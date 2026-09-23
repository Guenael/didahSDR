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
- Standard WebSocket protocol (handshake, config).
- Broadcasts raw 16-bit interleaved IQ binary stream (type 0x03); all DSP (FFT, demodulation) is client-side.
"""

import argparse
import asyncio
import collections
import json
import logging
import os
import wave
from pathlib import Path

import aiohttp
from aiohttp import web

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("didahSDR-Server")


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

        with wave.open(wav_path, "rb") as w:
            self.channels = w.getnchannels()
            self.sampwidth = w.getsampwidth()
            self.framerate = w.getframerate()
            self.nframes = w.getnframes()
        if self.channels != 2 or self.sampwidth != 2:
            raise ValueError(
                f"WAV file must be stereo 16-bit PCM (channels={self.channels}, sampwidth={self.sampwidth})"
            )

        self.frame_bytes = self.channels * self.sampwidth  # 4
        self.data_offset, self.data_bytes = self._locate_data_chunk(wav_path)
        self.data_bytes -= self.data_bytes % self.frame_bytes  # whole frames only
        if self.data_bytes < self.frame_bytes:
            raise ValueError(f"WAV file has no sample data: {wav_path}")
        self.total_samples = self.data_bytes // self.frame_bytes

        self._fd = os.open(wav_path, os.O_RDONLY)
        self._read_pos = 0  # next block start, bytes into the data chunk (producer side)
        self._blocks: collections.deque[bytes] = collections.deque()
        self._cur = memoryview(b"")
        self._cur_off = 0
        self._sync_reads = 0

        logger.info(
            f"WAV opened (streaming): {self.total_samples} complex samples at {self.framerate} Hz "
            f"({self.total_samples / self.framerate:.2f}s), {self.data_bytes / 1e6:.1f} MB on disk, "
            f"buffer <= {(self.prefetch_blocks + 1) * self.block_bytes / 1e6:.0f} MB"
        )

    @staticmethod
    def _locate_data_chunk(wav_path: str) -> tuple[int, int]:
        """Returns (offset, size) of the 'data' chunk, walking RIFF sub-chunks (fmt, LIST, ...)."""
        file_size = os.path.getsize(wav_path)
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
                if chunk_id == b"data":
                    # Some recorders write 0 or an oversized length for still-open files: clamp to the file
                    if size == 0 or pos + 8 + size > file_size:
                        size = file_size - pos - 8
                    return pos + 8, size
                pos += 8 + size + (size & 1)  # chunks are word-aligned
        raise ValueError(f"No 'data' chunk found in {wav_path}")

    def _read_block(self, pos: int) -> bytes:
        """Reads `block_bytes` starting at data offset `pos`, wrapping around the end of the data."""
        n = min(self.block_bytes, self.data_bytes)
        first = min(n, self.data_bytes - pos)
        out = os.pread(self._fd, first, self.data_offset + pos)
        if first < n:
            out += os.pread(self._fd, n - first, self.data_offset)
        return out

    def _advance_read_pos(self):
        self._read_pos = (self._read_pos + min(self.block_bytes, self.data_bytes)) % self.data_bytes

    def _reserve_block_pos(self) -> int:
        """Claim the next block offset before the read, so a sync fallback cannot repeat it."""
        pos = self._read_pos
        self._advance_read_pos()
        return pos

    def _take_next_block(self):
        """Moves the next prefetched block into `_cur`; reads synchronously if the queue is empty."""
        if self._blocks:
            block = self._blocks.popleft()
        else:
            block = self._read_block(self._read_pos)
            self._advance_read_pos()
            self._sync_reads += 1
            if self._sync_reads in (1, 10, 100) or self._sync_reads % 1000 == 0:
                logger.warning(f"IQ prefetch queue empty, read synchronously ({self._sync_reads} times)")
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
                pos = self._reserve_block_pos()
                block = await loop.run_in_executor(None, self._read_block, pos)
                self._blocks.append(block)
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


class ClientSession:
    """State for a connected WebSocket client."""

    def __init__(self, ws: web.WebSocketResponse):
        self.ws = ws
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=CLIENT_QUEUE_MAX)
        self.sender: asyncio.Task | None = None


class DidahServer:
    def __init__(self, looper: WavIQLooper, static_dir: Path, center_freq: int = 14048000):
        self.looper = looper
        self.static_dir = static_dir
        self.center_freq = center_freq
        self.samp_rate = looper.framerate  # 96000
        self.clients: dict[web.WebSocketResponse, ClientSession] = {}

    async def handle_websocket(self, request):
        ws = web.WebSocketResponse(heartbeat=10)
        await ws.prepare(request)
        session = ClientSession(ws)
        session.sender = asyncio.create_task(self._send_loop(session))
        self.clients[ws] = session
        logger.info(f"Client connected from {request.remote}. Total clients: {len(self.clients)}")

        try:
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    text = msg.data.strip()
                    if text.startswith("SERVER DE CLIENT"):
                        await ws.send_str("CLIENT DE SERVER server=didahsdr version=1.0.0-cw")

                        # Send config JSON
                        config_msg = {
                            "type": "config",
                            "value": {
                                "samp_rate": self.samp_rate,
                                "center_freq": self.center_freq,
                                "start_freq": self.center_freq + 2800,
                                "start_mod": "cw",
                                "fft_size": 2048,
                                "fft_compression": "none",
                                "audio_compression": "none",
                                "waterfall_min_level": -90,
                                "waterfall_max_level": -30,
                            },
                        }
                        await ws.send_str(json.dumps(config_msg))
                    # No server-side DSP. "dspcontrol" and any other client JSON are ignored.

                elif msg.type == aiohttp.WSMsgType.ERROR:
                    logger.warning(f"WebSocket error: {ws.exception()}")
        finally:
            self.clients.pop(ws, None)
            if session.sender is not None:
                session.sender.cancel()
            logger.info(f"Client disconnected. Remaining clients: {len(self.clients)}")
        return ws

    async def _send_loop(self, session: ClientSession) -> None:
        """Drains one client's queue. A slow socket cannot block the broadcast clock or other clients."""
        try:
            while True:
                packet = await session.queue.get()
                if packet is None:
                    break
                await session.ws.send_bytes(packet)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("IQ send failed; dropping client")
        finally:
            self.clients.pop(session.ws, None)

    async def raw_iq_broadcast_loop(self):
        """Streams raw 16-bit interleaved IQ chunks (type 0x03) for client-side FFT and demodulation."""
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
                    # Packet: 0x03 followed by 16-bit interleaved IQ samples
                    packet = bytes([0x03]) + raw_bytes
                    for session in list(self.clients.values()):
                        enqueue_packet(session.queue, packet)

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
        "./samples/SAMPLE_20120219_174346Z_14048kHz_RF.wav",
    ]
    for c in candidates:
        if c and os.path.isfile(c):
            return os.path.abspath(c)
    raise FileNotFoundError("Could not locate the WAV file. Please specify a valid path using --wav argument.")


async def start_background_tasks(app):
    logger.info("Initializing IQ prefetch and raw IQ broadcast tasks...")
    server = app["server"]
    tasks = [asyncio.create_task(server.looper.prefetch_loop()), asyncio.create_task(server.raw_iq_broadcast_loop())]
    yield
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    server.looper.close()


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
    app["server"] = server
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

    wav_file = find_wav_file(args.wav)
    static_dir = Path(__file__).resolve().parent.parent / "app"

    logger.info(f"Serving static files from: {static_dir}")
    logger.info(f"didahSDR web server: http://localhost:{args.port}/")

    app = create_app(wav_file, static_dir, args.center_freq)
    web.run_app(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
