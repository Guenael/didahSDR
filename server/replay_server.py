#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "aiohttp",
# ]
# ///
"""
didahSDR - Replay Server
Features:
- Streams an IQ WAV file of any size in a loop with a bounded (~16 MB) read-ahead buffer.
- didahSDR link protocol v1 over WebSocket (docs/protocol.md; the client codec is app/js/didah_proto.js).
- Broadcasts raw 16-bit interleaved IQ (RX_IQ); all DSP (FFT, demodulation) is client-side.
- Simulates the transceiver side: fixed LO, TX_IQ accepted and measured (forward/reflected power in
  STATUS), PTT logged, PTT watchdog. Nothing is transmitted.
"""

import argparse
import asyncio
import collections
import enum
import logging
import math
import operator
import os
import struct
import sys
from array import array
from pathlib import Path

import aiohttp
from aiohttp import web

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("didahSDR-Server")

SERVER_VERSION = "0.1.0"  # keep in step with pyproject.toml


# --- didahSDR link protocol v1 (docs/protocol.md). Mirrors app/js/didah_proto.js. ---

MAGIC = b"didahSDR"
VER_MAJOR = 1
VER_MINOR = 0
HEADER = struct.Struct("<8sBBBBIII")  # magic, ver_major, ver_minor, type, flags, seq, payload_len, reserved
STREAM_HEADER = struct.Struct("<QIBBH")  # sample_index, sample_rate, format, channels, reserved
HELLO_S = struct.Struct("<16sI")
DEVICE_INFO_S = struct.Struct("<16s16sIIIIIBIhh")
ACK_S = struct.Struct("<IHHq")
ERROR_S = struct.Struct("<IH")
COMMAND_S = struct.Struct("<HHq")
STATUS_S = struct.Struct("<IIHhHhII")
EVENT_S = struct.Struct("<Hi")
PING_S = struct.Struct("<I")

FLAG_ACK_REQ = 1
FLAG_RESPONSE = 2
FLAG_ERROR = 4
FMT_INT16 = 0


class MsgType(enum.IntEnum):
    HELLO = 0x01
    DEVICE_INFO = 0x02
    PING = 0x03
    PONG = 0x04
    ACK = 0x05
    ERROR = 0x06
    COMMAND = 0x10
    RX_IQ = 0x20
    TX_IQ = 0x21
    TX_KEY = 0x22
    STATUS = 0x30
    EVENT = 0x31


class Cmd(enum.IntEnum):
    SET_FREQUENCY = 0x01
    SET_SAMPLE_RATE = 0x02
    SET_RF_GAIN = 0x03
    SET_IF_GAIN = 0x04
    SET_FREQ_CORRECTION = 0x05
    SET_TX_POWER = 0x06
    SET_PTT = 0x07
    SET_RX_STREAM = 0x08
    SET_TX_WATCHDOG = 0x09
    GET_STATUS = 0x0A


class Err(enum.IntEnum):
    VERSION = 1
    UNSUPPORTED = 2
    RANGE = 3
    BUSY = 4
    TX_INHIBIT = 5


class Cap(enum.IntFlag):
    RX_IQ = 1 << 0
    TX_IQ = 1 << 1
    TX_KEY = 1 << 2
    RF_GAIN = 1 << 3
    IF_GAIN = 1 << 4
    FREQ_CORR = 1 << 5
    TX_POWER = 1 << 6
    SWR_METER = 1 << 7
    SAMPLE_RATE = 1 << 8


class StatusFlag(enum.IntFlag):
    TX = 1 << 0
    PTT = 1 << 1
    ADC_OVERLOAD = 1 << 2
    PLL_LOCK = 1 << 3
    SWR_FOLDBACK = 1 << 4
    TX_UNDERRUN = 1 << 5
    WATCHDOG_TRIP = 1 << 6
    OVER_TEMP = 1 << 7


class Event(enum.IntEnum):
    SWR_TRIP = 1
    OVER_TEMP = 2
    WATCHDOG = 3
    SUPPLY = 4


def pack_message(msg_type: int, seq: int, payload: bytes = b"", flags: int = 0) -> bytes:
    return HEADER.pack(MAGIC, VER_MAJOR, VER_MINOR, msg_type, flags, seq & 0xFFFFFFFF, len(payload), 0) + payload


def parse_header(data: bytes) -> tuple[int, int, int, int, int, int] | None:
    """(ver_major, ver_minor, type, flags, seq, payload_len), or None for a short frame or a wrong magic."""
    if len(data) < HEADER.size:
        return None
    magic, ver_major, ver_minor, msg_type, flags, seq, payload_len, _ = HEADER.unpack_from(data)
    if magic != MAGIC:
        return None
    return ver_major, ver_minor, msg_type, flags, seq, payload_len


def fixed_ascii(text: str, size: int = 16) -> bytes:
    return text.encode("ascii", "replace")[:size].ljust(size, b"\0")


def int16_samples(raw: bytes) -> array:
    a = array("h")
    a.frombytes(raw[: len(raw) & ~1])
    if sys.byteorder == "big":
        a.byteswap()
    return a


def iq_peak(raw: bytes) -> int:
    a = int16_samples(raw)
    return max(max(a), -min(a)) if a else 0


def iq_energy(raw: bytes) -> float:
    """Sum of I² + Q², full scale = 1 per complex sample."""
    a = int16_samples(raw)
    return sum(map(operator.mul, a, a)) / (32768.0 * 32768.0)


WAVE_FORMAT_PCM = 0x0001
WAVE_FORMAT_EXTENSIBLE = 0xFFFE


class WavIQLooper:
    """
    Streams a 16-bit stereo IQ WAV file in a loop without loading it into memory.

    The data chunk is read in fixed-size blocks with os.pread() at explicit offsets (wrapping at the
    end of the data), so any file size works with a bounded footprint: at most `prefetch_blocks`
    queued blocks plus the one being consumed (~16 MB with the defaults). `prefetch_loop()` refills
    the queue from a thread executor so disk latency never blocks the event loop; if the queue is
    ever empty, `next_raw_iq_bytes()` falls back to a synchronous read so the stream never stalls.
    """

    BLOCK_BYTES = 4 * 1024 * 1024  # 4 MiB = ~10.9 s of IQ at 96 kHz
    PREFETCH_BLOCKS = 3

    def __init__(self, wav_path: str, block_bytes: int = BLOCK_BYTES, prefetch_blocks: int = PREFETCH_BLOCKS):
        self.wav_path = wav_path
        self.block_bytes = block_bytes
        self.prefetch_blocks = prefetch_blocks

        fmt, self.data_offset, self.data_bytes = self._parse_riff(wav_path)
        self.channels = fmt["channels"]
        self.sampwidth = fmt["bits"] // 8
        self.framerate = fmt["rate"]
        if fmt["format"] != WAVE_FORMAT_PCM or self.channels != 2 or fmt["bits"] != 16:
            raise ValueError(
                f"WAV file must be stereo 16-bit PCM (format={fmt['format']:#x}, channels={self.channels}, "
                f"bits={fmt['bits']}): {wav_path}"
            )
        if self.framerate <= 0:
            raise ValueError(f"WAV file has no sample rate: {wav_path}")

        self.frame_bytes = self.channels * self.sampwidth  # 4
        self.data_bytes -= self.data_bytes % self.frame_bytes  # whole frames only
        if self.data_bytes < self.frame_bytes:
            raise ValueError(f"WAV file has no sample data: {wav_path}")
        self.total_samples = self.data_bytes // self.frame_bytes

        self._fd = os.open(wav_path, os.O_RDONLY)
        # Blocks are numbered; block k starts at (k * step) % data_bytes. The consumer plays block
        # `_consume_seq` next; the producer reserves `_next_seq` before its (threaded) read.
        self._step = min(self.block_bytes, self.data_bytes)
        self._next_seq = 0
        self._consume_seq = 0
        self._blocks: collections.deque[tuple[int, bytes]] = collections.deque()
        self._cur = memoryview(b"")
        self._cur_off = 0
        self._sync_reads = 0

        logger.info(
            f"WAV opened (streaming): {self.total_samples} complex samples at {self.framerate} Hz "
            f"({self.total_samples / self.framerate:.2f}s), {self.data_bytes / 1e6:.1f} MB on disk, "
            f"buffer <= {(self.prefetch_blocks + 1) * self.block_bytes / 1e6:.0f} MB"
        )

    @staticmethod
    def _parse_riff(wav_path: str) -> tuple[dict, int, int]:
        """Walks the RIFF chunks. Returns (fmt, data offset, data size).

        Parsed here rather than with the `wave` module, which rejects WAVE_FORMAT_EXTENSIBLE headers
        (common in SDR recorders) before Python 3.12.
        """
        file_size = os.path.getsize(wav_path)
        fmt = None
        with open(wav_path, "rb") as f:
            riff = f.read(12)
            if len(riff) < 12 or riff[:4] != b"RIFF" or riff[8:12] != b"WAVE":
                raise ValueError(f"Not a RIFF/WAVE file: {wav_path}")
            pos = 12
            while pos + 8 <= file_size:
                f.seek(pos)
                header = f.read(8)
                if len(header) < 8:
                    break
                chunk_id, size = header[:4], int.from_bytes(header[4:8], "little")
                if chunk_id == b"fmt ":
                    body = f.read(min(size, 40))
                    if len(body) < 16:
                        raise ValueError(f"Truncated 'fmt ' chunk in {wav_path}")
                    fmt = {
                        "format": int.from_bytes(body[0:2], "little"),
                        "channels": int.from_bytes(body[2:4], "little"),
                        "rate": int.from_bytes(body[4:8], "little"),
                        "bits": int.from_bytes(body[14:16], "little"),
                    }
                    # Extensible: the real format code is the first two bytes of the sub-format GUID
                    if fmt["format"] == WAVE_FORMAT_EXTENSIBLE and len(body) >= 26:
                        fmt["format"] = int.from_bytes(body[24:26], "little")
                elif chunk_id == b"data":
                    if fmt is None:
                        raise ValueError(f"'data' chunk before 'fmt ' in {wav_path}")
                    # Some recorders write 0 or an oversized length for still-open files: clamp to the file
                    if size == 0 or pos + 8 + size > file_size:
                        size = file_size - pos - 8
                    return fmt, pos + 8, size
                pos += 8 + size + (size & 1)  # chunks are word-aligned
        raise ValueError(f"No 'data' chunk found in {wav_path}")

    def _seq_pos(self, seq: int) -> int:
        return (seq * self._step) % self.data_bytes

    def _read_block(self, pos: int) -> bytes:
        """Reads one block starting at data offset `pos`, wrapping around the end of the data."""
        n = self._step
        first = min(n, self.data_bytes - pos)
        out = os.pread(self._fd, first, self.data_offset + pos)
        if first < n:
            out += os.pread(self._fd, n - first, self.data_offset)
        return out

    def _reserve_seq(self) -> int:
        """Claim the next block for the prefetch task. Never a block the consumer has already played."""
        seq = max(self._next_seq, self._consume_seq)
        self._next_seq = seq + 1
        return seq

    def _take_next_block(self):
        """Moves block `_consume_seq` into `_cur`, reading it synchronously if it is not queued yet.

        A prefetch read can still be in flight when the queue runs dry. The synchronous read then takes
        that block's place, and the late copy is dropped here instead of being played out of order.
        """
        seq = self._consume_seq
        while self._blocks and self._blocks[0][0] < seq:
            self._blocks.popleft()
        if self._blocks and self._blocks[0][0] == seq:
            block = self._blocks.popleft()[1]
        else:
            block = self._read_block(self._seq_pos(seq))
            self._sync_reads += 1
            if self._sync_reads in (1, 10, 100) or self._sync_reads % 1000 == 0:
                logger.warning(f"IQ prefetch queue empty, read synchronously ({self._sync_reads} times)")
        self._consume_seq = seq + 1
        self._cur = memoryview(block)
        self._cur_off = 0

    def next_raw_iq_bytes(self, num_samples: int) -> bytes:
        """Returns the next `num_samples` complex samples as raw 16-bit interleaved IQ bytes."""
        num_bytes = num_samples * self.frame_bytes
        parts = []
        while num_bytes > 0:
            avail = len(self._cur) - self._cur_off
            if avail == 0:
                self._take_next_block()
                continue
            take = min(avail, num_bytes)
            parts.append(self._cur[self._cur_off : self._cur_off + take])
            self._cur_off += take
            num_bytes -= take
        return parts[0].tobytes() if len(parts) == 1 else b"".join(parts)

    async def prefetch_loop(self):
        """Keeps up to `prefetch_blocks` blocks queued, reading in a thread so the event loop never blocks."""
        loop = asyncio.get_running_loop()
        while True:
            if len(self._blocks) < self.prefetch_blocks:
                seq = self._reserve_seq()
                block = await loop.run_in_executor(None, self._read_block, self._seq_pos(seq))
                if seq >= self._consume_seq:
                    self._blocks.append((seq, block))
            else:
                await asyncio.sleep(0.1)

    def close(self):
        if self._fd is not None:
            os.close(self._fd)
            self._fd = None


IQ_TICK_S = 0.025
CLIENT_QUEUE_MAX = 8


def chunk_sample_count(sample_rate: float, acc: float, tick_s: float = IQ_TICK_S) -> tuple[int, float]:
    """Complex samples for one paced tick, carrying the fractional remainder.

    ``int(rate * tick)`` drops a fraction of a sample every tick. At 44.1 kHz that is
    half a sample, 20 samples per second short of the file rate. The accumulator adds
    ``rate * tick`` and emits the integer part, so one second of ticks sums to the rate.
    """
    acc += float(sample_rate) * tick_s
    n = int(acc)
    if n < 0:
        n = 0
    return n, acc - n


def enqueue_packet(queue: asyncio.Queue, packet: bytes) -> None:
    """Queue one IQ packet. A full queue drops the oldest packet, not the new one."""
    if queue.full():
        try:
            queue.get_nowait()
        except asyncio.QueueEmpty:
            return
    try:
        queue.put_nowait(packet)
    except asyncio.QueueFull:
        pass


# Simulated transceiver (the replay stands in for the STM32 Tayloe TRX; nothing is transmitted)
MAX_TX_MW = 10000
DEFAULT_TX_POWER_MW = 5000
DEFAULT_WATCHDOG_S = 1.0
SIM_SWR = 1.2
CAPS = Cap.RX_IQ | Cap.TX_IQ | Cap.TX_POWER | Cap.SWR_METER


class ClientSession:
    """State for a connected WebSocket client."""

    def __init__(self, ws: web.WebSocketResponse, remote: str | None = None):
        self.ws = ws
        self.remote = remote or "?"
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=CLIENT_QUEUE_MAX)
        self.sender: asyncio.Task | None = None
        self.status_task: asyncio.Task | None = None
        self.send_lock = asyncio.Lock()
        self.seq = 0
        self.client_name = ""
        self.rx_enabled = False
        self.tx_power_mw = DEFAULT_TX_POWER_MW
        self.watchdog_s = DEFAULT_WATCHDOG_S
        self.ptt = False
        self.ptt_since = 0.0
        self.last_tx_activity = 0.0
        self.watchdog_tripped = False
        self.status_dirty = False
        self.fwd_mw = 0.0
        self.tx_samples = 0
        self.tx_energy = 0.0
        self.tx_gaps = 0
        self.tx_next_index: int | None = None
        self.tx_ignored = 0

    async def send(self, msg_type: int, payload: bytes = b"", flags: int = 0) -> None:
        """One frame. The lock keeps `seq` in send order across the IQ and control paths."""
        async with self.send_lock:
            seq = self.seq
            self.seq = (seq + 1) & 0xFFFFFFFF
            await self.ws.send_bytes(pack_message(msg_type, seq, payload, flags))


class DidahServer:
    def __init__(self, looper: WavIQLooper, static_dir: Path, center_freq: int = 14048000):
        self.looper = looper
        self.static_dir = static_dir
        self.center_freq = center_freq
        self.samp_rate = looper.framerate  # 96000
        self.clients: dict[web.WebSocketResponse, ClientSession] = {}
        self.sample_index = 0  # RX_IQ time base: complex samples since the stream started
        self.adc_peak = 0  # int16 peak of the last second of RX
        self._peak_acc = 0
        self._peak_ticks = 0

    async def handle_websocket(self, request):
        ws = web.WebSocketResponse(heartbeat=10)
        await ws.prepare(request)
        session = ClientSession(ws, request.remote)
        session.sender = asyncio.create_task(self._send_loop(session))
        self.clients[ws] = session
        logger.info(f"Client connected from {request.remote}. Total clients: {len(self.clients)}")

        try:
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.BINARY:
                    await self._on_message(session, msg.data)
                elif msg.type == aiohttp.WSMsgType.TEXT:
                    logger.warning(f"{session.remote}: text message; this server speaks didahSDR v1 (binary)")
                    await ws.close(message=b"didahSDR protocol v1 required")
                    break
                elif msg.type == aiohttp.WSMsgType.ERROR:
                    logger.warning(f"WebSocket error: {ws.exception()}")
        finally:
            self._set_ptt(session, False, "link closed")
            self.clients.pop(ws, None)
            for task in (session.sender, session.status_task):
                if task is not None:
                    task.cancel()
            logger.info(f"Client disconnected. Remaining clients: {len(self.clients)}")
        return ws

    # --- protocol ---

    async def _on_message(self, session: ClientSession, data: bytes) -> None:
        hdr = parse_header(data)
        if hdr is None:
            logger.debug(f"{session.remote}: frame without the didahSDR header, dropped")
            return
        ver_major, _ver_minor, msg_type, flags, seq, payload_len = hdr
        if ver_major != VER_MAJOR:
            logger.warning(f"{session.remote}: protocol v{ver_major}, this server is v{VER_MAJOR}")
            await session.send(MsgType.ERROR, ERROR_S.pack(seq, Err.VERSION), FLAG_ERROR | FLAG_RESPONSE)
            await session.ws.close()
            return
        payload = data[HEADER.size : HEADER.size + payload_len]
        loop_time = asyncio.get_running_loop().time()

        if msg_type == MsgType.HELLO:
            await self._on_hello(session, payload)
        elif msg_type == MsgType.PING:
            if session.ptt:
                session.last_tx_activity = loop_time  # PING also feeds the TX watchdog
            await session.send(MsgType.PONG, payload[: PING_S.size], FLAG_RESPONSE)
        elif msg_type == MsgType.COMMAND and len(payload) >= COMMAND_S.size:
            await self._on_command(session, seq, flags, payload)
        elif msg_type == MsgType.TX_IQ:
            self._on_tx_iq(session, payload, loop_time)
        elif msg_type == MsgType.TX_KEY:
            # Not in CAPS: the replay only takes TX_IQ. Counted as activity, like a real device would.
            if session.ptt:
                session.last_tx_activity = loop_time
            if flags & FLAG_ACK_REQ:
                await session.send(MsgType.ERROR, ERROR_S.pack(seq, Err.UNSUPPORTED), FLAG_ERROR | FLAG_RESPONSE)
        elif msg_type in (MsgType.PONG, MsgType.ACK, MsgType.ERROR):
            pass
        elif flags & FLAG_ACK_REQ:
            # Unknown type (a newer minor): ignored, but say so when an answer was asked for
            await session.send(MsgType.ERROR, ERROR_S.pack(seq, Err.UNSUPPORTED), FLAG_ERROR | FLAG_RESPONSE)

    async def _on_hello(self, session: ClientSession, payload: bytes) -> None:
        name, caps_wanted = HELLO_S.unpack_from(payload.ljust(HELLO_S.size, b"\0"))
        session.client_name = name.rstrip(b"\0").decode("ascii", "replace")
        logger.info(f"{session.remote}: HELLO from '{session.client_name}' (caps wanted {caps_wanted:#x})")
        info = DEVICE_INFO_S.pack(
            fixed_ascii("didahSDR replay"),
            fixed_ascii(SERVER_VERSION),
            0,
            CAPS,
            self.center_freq,
            self.center_freq,  # fixed LO: the replay cannot tune
            self.samp_rate,
            1 << FMT_INT16,
            MAX_TX_MW,
            0,
            0,
        )
        await session.send(MsgType.DEVICE_INFO, info, FLAG_RESPONSE)
        await self._send_status(session)  # the client takes the centre from the first STATUS
        if session.status_task is None:
            session.status_task = asyncio.create_task(self._status_loop(session))

    async def _on_command(self, session: ClientSession, seq: int, flags: int, payload: bytes) -> None:
        cmd, _, value = COMMAND_S.unpack_from(payload)
        if cmd == Cmd.SET_FREQUENCY:
            applied = self.center_freq  # the LO stays put; the ACK says where it is
        elif cmd == Cmd.SET_SAMPLE_RATE:
            applied = self.samp_rate
        elif cmd == Cmd.SET_TX_POWER:
            applied = min(max(value, 0), MAX_TX_MW)
            session.tx_power_mw = applied
        elif cmd == Cmd.SET_PTT:
            applied = 1 if value else 0
            self._set_ptt(session, bool(applied), "client")
        elif cmd == Cmd.SET_RX_STREAM:
            applied = 1 if value else 0
            session.rx_enabled = bool(applied)
        elif cmd == Cmd.SET_TX_WATCHDOG:
            applied = int(DEFAULT_WATCHDOG_S * 1000) if value <= 0 else min(max(value, 100), 10000)
            session.watchdog_s = applied / 1000.0
        elif cmd == Cmd.GET_STATUS:
            applied = 0
            await self._send_status(session)
        else:
            # RF / IF gain and frequency correction: not in CAPS
            if flags & FLAG_ACK_REQ:
                await session.send(MsgType.ERROR, ERROR_S.pack(seq, Err.UNSUPPORTED), FLAG_ERROR | FLAG_RESPONSE)
            return
        if flags & FLAG_ACK_REQ:
            await session.send(MsgType.ACK, ACK_S.pack(seq, cmd, 0, applied), FLAG_RESPONSE)

    def _set_ptt(self, session: ClientSession, on: bool, reason: str) -> None:
        now = asyncio.get_running_loop().time()
        if on and not session.ptt:
            session.ptt = True
            session.ptt_since = now
            session.last_tx_activity = now
            session.watchdog_tripped = False
            session.fwd_mw = 0.0
            session.tx_samples = 0
            session.tx_energy = 0.0
            session.tx_gaps = 0
            session.tx_next_index = None
            session.status_dirty = True
            logger.info(f"TX enabled by {session.remote} ({session.tx_power_mw / 1000:.1f} W set, not radiated)")
        elif not on and session.ptt:
            session.ptt = False
            session.fwd_mw = 0.0
            session.status_dirty = True
            avg_w = session.tx_power_mw * session.tx_energy / session.tx_samples / 1000 if session.tx_samples else 0.0
            logger.info(
                f"TX released by {session.remote} ({reason}) after {now - session.ptt_since:.2f} s: "
                f"{session.tx_samples} IQ samples ({session.tx_samples / self.samp_rate:.2f} s), "
                f"avg {avg_w:.2f} W, {session.tx_gaps} gaps"
            )

    def _on_tx_iq(self, session: ClientSession, payload: bytes, now: float) -> None:
        if len(payload) < STREAM_HEADER.size:
            return
        index, _rate, fmt, channels, _ = STREAM_HEADER.unpack_from(payload)
        if not session.ptt or fmt != FMT_INT16 or channels != 2:
            session.tx_ignored += 1
            if session.tx_ignored in (1, 100) or session.tx_ignored % 1000 == 0:
                logger.warning(f"{session.remote}: TX_IQ ignored ({'no PTT' if not session.ptt else 'format'})")
            return
        raw = payload[STREAM_HEADER.size :]
        n = len(raw) // 4
        if n == 0:
            return
        if session.tx_next_index is not None and index != session.tx_next_index:
            session.tx_gaps += 1
        session.tx_next_index = index + n
        energy = iq_energy(raw)
        session.tx_samples += n
        session.tx_energy += energy
        session.fwd_mw = session.tx_power_mw * energy / n  # full scale = the set power
        session.last_tx_activity = now

    def _status_payload(self, session: ClientSession) -> bytes:
        flags = StatusFlag.PLL_LOCK
        fwd = refl = 0
        swr_x100 = 100
        if session.ptt:
            flags |= StatusFlag.PTT
            fwd = int(round(session.fwd_mw))
            if fwd > 0:
                flags |= StatusFlag.TX
                refl = int(round(fwd * ((SIM_SWR - 1) / (SIM_SWR + 1)) ** 2))
                swr_x100 = int(round(SIM_SWR * 100))
        if self.adc_peak >= 32767:
            flags |= StatusFlag.ADC_OVERLOAD
        if session.watchdog_tripped:
            flags |= StatusFlag.WATCHDOG_TRIP
        peak_cdb = int(round(2000 * math.log10(self.adc_peak / 32768))) if self.adc_peak > 0 else -12000
        return STATUS_S.pack(fwd, refl, swr_x100, 250, 13800, max(peak_cdb, -12000), int(flags), self.center_freq)

    async def _send_status(self, session: ClientSession) -> None:
        await session.send(MsgType.STATUS, self._status_payload(session))

    async def _status_loop(self, session: ClientSession) -> None:
        """STATUS at 10 Hz on PTT, 1 Hz otherwise, and at once on a PTT edge. Runs the PTT watchdog."""
        loop = asyncio.get_running_loop()
        next_rx_status = loop.time() + 1.0
        try:
            while True:
                await asyncio.sleep(0.1)
                now = loop.time()
                if session.ptt and now - session.last_tx_activity > session.watchdog_s:
                    self._set_ptt(session, False, "watchdog")
                    session.watchdog_tripped = True
                    await session.send(MsgType.EVENT, EVENT_S.pack(Event.WATCHDOG, int(session.watchdog_s * 1000)))
                if session.ptt or session.status_dirty or now >= next_rx_status:
                    session.status_dirty = False
                    next_rx_status = now + 1.0
                    await self._send_status(session)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("STATUS send failed")

    async def _send_loop(self, session: ClientSession) -> None:
        """Drains one client's queue. A slow socket cannot block the broadcast clock or other clients."""
        try:
            while True:
                payload = await session.queue.get()
                if payload is None:
                    break
                await session.send(MsgType.RX_IQ, payload)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("IQ send failed; dropping client")
        finally:
            self.clients.pop(session.ws, None)

    def _track_peak(self, raw: bytes) -> None:
        self._peak_acc = max(self._peak_acc, iq_peak(raw))
        self._peak_ticks += 1
        if self._peak_ticks * IQ_TICK_S >= 1.0:
            self.adc_peak = self._peak_acc
            self._peak_acc = 0
            self._peak_ticks = 0

    async def raw_iq_broadcast_loop(self):
        """Streams RX_IQ (16-bit interleaved IQ) to every client that enabled the RX stream."""
        logger.info(f"Starting raw IQ stream loop ({IQ_TICK_S * 1000:.0f} ms tick)...")

        # Pace against an absolute deadline. Computing each sleep from the previous iteration's elapsed
        # time lets asyncio.sleep() overshoot accumulate into a permanent rate error (~1.6% slow measured),
        # which drains the client's jitter buffer and causes periodic audio underruns.
        loop = asyncio.get_running_loop()
        next_tick = loop.time()
        acc = 0.0
        while True:
            if self.clients:
                n, acc = chunk_sample_count(self.samp_rate, acc, IQ_TICK_S)
                if n:
                    raw_bytes = self.looper.next_raw_iq_bytes(n)
                    self._track_peak(raw_bytes)
                    # One payload for every client; each send adds its own header (per-client seq)
                    payload = STREAM_HEADER.pack(self.sample_index, self.samp_rate, FMT_INT16, 2, 0) + raw_bytes
                    self.sample_index += n
                    for session in list(self.clients.values()):
                        if session.rx_enabled:
                            enqueue_packet(session.queue, payload)

            next_tick += IQ_TICK_S
            delay = next_tick - loop.time()
            if delay < -IQ_TICK_S:
                # Fell more than one period behind (e.g. process was suspended): resync instead of bursting
                next_tick = loop.time()
                delay = 0.0
            await asyncio.sleep(max(0.0, delay))


def find_wav_file(specified: str | None = None) -> str:
    candidates = [
        specified,
        "./samples/REPLAY_SAMPLE.wav",
    ]
    for c in candidates:
        if c and os.path.isfile(c):
            return os.path.abspath(c)
    raise FileNotFoundError(
        "No IQ recording found. Pass a 16-bit stereo IQ WAV with --wav PATH (and --center-freq HZ); "
        "recordings are not shipped in the repository, see README 'IQ recordings'."
    )


async def start_background_tasks(app):
    logger.info("Initializing IQ prefetch and raw IQ broadcast tasks...")
    server = app[SERVER_KEY]
    tasks = [asyncio.create_task(server.looper.prefetch_loop()), asyncio.create_task(server.raw_iq_broadcast_loop())]
    yield
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    server.looper.close()


SERVER_KEY: web.AppKey["DidahServer"] = web.AppKey("server", DidahServer)


def create_app(wav_path: str, static_dir: Path, center_freq: int):
    looper = WavIQLooper(wav_path)
    server = DidahServer(looper, static_dir, center_freq=center_freq)

    @web.middleware
    async def isolation_headers(request, handler):
        # Cross-origin isolation lets onnxruntime-web use SharedArrayBuffer (multi-threaded WASM) in the
        # CW decoder worker. WebSockets to external Kiwi servers are unaffected by COEP.
        response = await handler(request)
        response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
        response.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
        # The test server is a live-reload workflow: never let the browser keep a stale
        # audio.js while serving a newer app.js (Firefox will do that on a normal refresh).
        if request.path == "/" or request.path.startswith(("/js/", "/css/", "/lib/", "/models/")):
            response.headers["Cache-Control"] = "no-store"
        return response

    app = web.Application(middlewares=[isolation_headers])
    app[SERVER_KEY] = server
    app.cleanup_ctx.append(start_background_tasks)

    app.router.add_get("/ws", server.handle_websocket)
    app.router.add_get("/ws/", server.handle_websocket)

    # Serve index.html at root
    async def index_handler(request):
        return web.FileResponse(static_dir / "index.html")

    app.router.add_get("/", index_handler)

    async def favicon_handler(_request):
        return web.FileResponse(static_dir / "favicon.svg")

    app.router.add_get("/favicon.ico", favicon_handler)
    app.router.add_get("/favicon.svg", favicon_handler)

    # Static assets
    app.router.add_static("/css", static_dir / "css")
    app.router.add_static("/js", static_dir / "js")
    # CW decoder assets: vendored onnxruntime-web (scripts/fetch_ort.sh) and the exported model
    for name in ("lib", "models"):
        if (static_dir / name).is_dir():
            app.router.add_static(f"/{name}", static_dir / name)

    return app


def main():
    parser = argparse.ArgumentParser(description="didahSDR - Replay Server (raw IQ streaming, no server-side DSP)")
    parser.add_argument("--wav", type=str, default=None, help="Path to 16-bit stereo IQ WAV file")
    parser.add_argument("--port", type=int, default=9000, help="Port to listen on (default: 9000)")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Host IP to bind (default: 0.0.0.0)")
    parser.add_argument("--center-freq", type=int, default=14048000, help="Center frequency in Hz (default: 14048000)")
    args = parser.parse_args()

    static_dir = Path(__file__).resolve().parent.parent / "app"
    try:
        wav_file = find_wav_file(args.wav)
        app = create_app(wav_file, static_dir, args.center_freq)
    except (FileNotFoundError, ValueError) as e:
        logger.error(str(e))
        sys.exit(2)

    logger.info(f"Serving static files from: {static_dir}")
    logger.info(f"didahSDR web server: http://localhost:{args.port}/")
    web.run_app(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
