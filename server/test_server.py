#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "aiohttp",
# ]
# ///
"""
didahSDR - Standalone Test Server
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
        loop = asyncio.get_event_loop()
        while True:
            if len(self._blocks) < self.prefetch_blocks:
                block = await loop.run_in_executor(None, self._read_block, self._read_pos)
                self._advance_read_pos()
                self._blocks.append(block)
            else:
                await asyncio.sleep(0.1)

    def close(self):
        if self._fd is not None:
            os.close(self._fd)
            self._fd = None


class ClientSession:
    """State for a connected WebSocket client."""

    def __init__(self, ws: web.WebSocketResponse):
        self.ws = ws
        self.stream_mode = "raw_iq"


class DidahServer:
    def __init__(self, looper: WavIQLooper, static_dir: Path, center_freq: int = 14048000, fps: int = 30):
        self.looper = looper
        self.static_dir = static_dir
        self.center_freq = center_freq
        self.samp_rate = looper.framerate  # 96000
        self.fps = fps
        self.step_samples = max(256, int(self.samp_rate / self.fps))
        self.clients: dict[web.WebSocketResponse, ClientSession] = {}

    async def handle_websocket(self, request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        session = ClientSession(ws)
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
                                "start_freq": self.center_freq + 700,
                                "start_mod": "cw",
                                "fft_size": 2048,
                                "fft_fps": self.fps,
                                "fft_compression": "none",
                                "audio_compression": "none",
                                "waterfall_min_level": -90,
                                "waterfall_max_level": -30,
                            },
                        }
                        await ws.send_str(json.dumps(config_msg))
                    else:
                        # No server-side DSP: "dspcontrol" and any other message types are ignored.
                        try:
                            data = json.loads(text)
                            if data.get("type") == "set_stream_mode":
                                session.stream_mode = data.get("mode", "raw_iq")
                                logger.info(f"Client set stream_mode to '{session.stream_mode}'")
                        except json.JSONDecodeError:
                            pass

                elif msg.type == aiohttp.WSMsgType.ERROR:
                    logger.warning(f"WebSocket error: {ws.exception()}")
        finally:
            self.clients.pop(ws, None)
            logger.info(f"Client disconnected. Remaining clients: {len(self.clients)}")
        return ws

    async def raw_iq_broadcast_loop(self):
        """Streams raw 16-bit interleaved IQ chunks (type 0x03) for client-side FFT and demodulation."""
        block_duration = 0.025  # 25ms chunks (40 chunks/sec)
        num_iq_samples = int(self.samp_rate * block_duration)  # 2400 complex samples = 9600 bytes
        logger.info(f"Starting raw IQ stream loop ({num_iq_samples} samples per {block_duration*1000:.1f}ms chunk)...")

        # Pace against an absolute deadline. Computing each sleep from the previous iteration's elapsed
        # time lets asyncio.sleep() overshoot accumulate into a permanent rate error (~1.6% slow measured),
        # which drains the client's jitter buffer and causes periodic audio underruns.
        loop = asyncio.get_event_loop()
        next_tick = loop.time()
        while True:
            raw_clients = [ws for ws, s in self.clients.items() if s.stream_mode == "raw_iq"]
            if raw_clients:
                raw_bytes = self.looper.next_raw_iq_bytes(num_iq_samples)
                # Packet: 0x03 followed by 16-bit interleaved IQ samples
                packet = bytes([0x03]) + raw_bytes
                disconnected = []
                for ws in raw_clients:
                    try:
                        await ws.send_bytes(packet)
                    except Exception:
                        disconnected.append(ws)
                for ws in disconnected:
                    self.clients.pop(ws, None)

            next_tick += block_duration
            delay = next_tick - loop.time()
            if delay < -block_duration:
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


def create_app(wav_path: str, static_dir: Path, center_freq: int, fps: int):
    looper = WavIQLooper(wav_path)
    server = DidahServer(looper, static_dir, center_freq=center_freq, fps=fps)

    app = web.Application()
    app["server"] = server
    app.cleanup_ctx.append(start_background_tasks)

    app.router.add_get("/ws", server.handle_websocket)
    app.router.add_get("/ws/", server.handle_websocket)

    # Serve index.html at root
    async def index_handler(request):
        return web.FileResponse(static_dir / "index.html")

    app.router.add_get("/", index_handler)

    # Static assets
    app.router.add_static("/css", static_dir / "css")
    app.router.add_static("/js", static_dir / "js")

    return app


def main():
    parser = argparse.ArgumentParser(description="didahSDR - Test Server (raw IQ streaming, no server-side DSP)")
    parser.add_argument("--wav", type=str, default=None, help="Path to 16-bit stereo IQ WAV file")
    parser.add_argument("--port", type=int, default=9000, help="Port to listen on (default: 9000)")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Host IP to bind (default: 0.0.0.0)")
    parser.add_argument("--center-freq", type=int, default=14048000, help="Center frequency in Hz (default: 14048000)")
    parser.add_argument("--fps", type=int, default=30, help="Spectrum frames per second (default: 30)")
    args = parser.parse_args()

    wav_file = find_wav_file(args.wav)
    static_dir = Path(__file__).resolve().parent.parent / "app"

    logger.info(f"Serving static files from: {static_dir}")
    logger.info(f"didahSDR web server: http://localhost:{args.port}/")

    app = create_app(wav_file, static_dir, args.center_freq, args.fps)
    web.run_app(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
