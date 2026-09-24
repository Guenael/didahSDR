import asyncio
import json
from pathlib import Path

import pytest
from aiohttp.test_utils import TestClient, TestServer

from server.replay_server import (
    SERVER_KEY,
    WavIQLooper,
    chunk_sample_count,
    create_app,
    enqueue_packet,
    find_wav_file,
)

STATIC_DIR = Path(__file__).resolve().parent.parent / "app"


def test_looper_reads_header_and_packets(iq_wav):
    path, _ = iq_wav()
    looper = WavIQLooper(str(path))
    assert (looper.framerate, looper.channels, looper.total_samples) == (96000, 2, 96000)
    assert len(looper.next_raw_iq_bytes(480)) == 480 * 4  # 2 channels * 2 bytes
    looper.close()


def test_looper_accepts_wave_format_extensible(iq_wav):
    path, pcm = iq_wav(extensible=True, rate=192000)
    looper = WavIQLooper(str(path))
    assert looper.framerate == 192000
    assert looper.next_raw_iq_bytes(100) == pcm[:400]
    looper.close()


def test_looper_streams_and_wraps_like_the_file(iq_wav):
    """Small blocks force many block boundaries and wraps; output must equal the data chunk looped."""
    path, pcm = iq_wav(list_chunk=True)  # LIST before 'data' exercises the chunk walker
    looper = WavIQLooper(str(path), block_bytes=4096, prefetch_blocks=2)
    assert looper.total_samples == len(pcm) // 4
    with open(path, "rb") as f:
        f.seek(looper.data_offset)
        assert f.read(looper.data_bytes) == pcm

    # 2.5 loops in 9600-byte packets (not a divisor of 4096: packets straddle blocks and the wrap)
    want_total = looper.data_bytes * 5 // 2
    got = bytearray()
    while len(got) < want_total:
        got += looper.next_raw_iq_bytes(2400)
    assert bytes(got) == (pcm * 3)[: len(got)]
    looper.close()


def test_looper_rejects_bad_files(tmp_path, iq_wav):
    no_data = tmp_path / "bad.wav"
    no_data.write_bytes(
        b"RIFF" + (36).to_bytes(4, "little") + b"WAVE" + b"fmt " + (16).to_bytes(4, "little") + b"\0" * 16
    )
    with pytest.raises(ValueError):
        WavIQLooper(str(no_data))
    not_riff = tmp_path / "x.wav"
    not_riff.write_bytes(b"hello world, not a wav")
    with pytest.raises(ValueError, match="RIFF"):
        WavIQLooper(str(not_riff))


def test_find_wav_file_explains_what_to_do(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    with pytest.raises(FileNotFoundError, match="--wav"):
        find_wav_file(None)


def test_late_prefetch_block_is_not_played_out_of_order(iq_wav):
    """Queue runs dry while a prefetch read is in flight: the stream must still be the file, in order."""
    path, pcm = iq_wav(pcm=bytes(i % 251 for i in range(96000 * 4)))
    looper = WavIQLooper(str(path), block_bytes=4096, prefetch_blocks=2)
    got = bytearray()
    got += looper.next_raw_iq_bytes(1024)  # block 0, read synchronously (nothing prefetched yet)
    in_flight = looper._reserve_seq()  # the prefetch task claims block 1 and starts reading...
    assert in_flight == 1
    got += looper.next_raw_iq_bytes(1024)  # ...but the consumer needs block 1 now: sync read
    late = looper._read_block(looper._seq_pos(in_flight))
    looper._blocks.append((in_flight, late))  # the late copy lands after the sync read
    assert looper._reserve_seq() == 2  # the producer never reclaims a played block
    while len(got) < len(pcm) * 2:
        got += looper.next_raw_iq_bytes(2400)
    assert bytes(got) == (pcm * 3)[: len(got)]
    looper.close()


def test_prefetch_loop_keeps_the_stream_in_order(iq_wav):
    """Real prefetch task running concurrently with the consumer."""
    path, pcm = iq_wav(frames=20000)

    async def run():
        looper = WavIQLooper(str(path), block_bytes=6000, prefetch_blocks=3)
        task = asyncio.create_task(looper.prefetch_loop())
        got = bytearray()
        try:
            while len(got) < len(pcm) * 3:
                got += looper.next_raw_iq_bytes(2400)
                await asyncio.sleep(0)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            looper.close()
        return bytes(got)

    got = asyncio.run(run())
    assert got == (pcm * 4)[: len(got)]


def test_chunk_samples_96000_is_exact():
    acc = 0.0
    for _ in range(40):
        n, acc = chunk_sample_count(96000, acc)
        assert n == 2400
    assert acc == 0.0


def test_chunk_samples_44100_sums_to_one_second():
    acc = 0.0
    total = 0
    for _ in range(40):
        n, acc = chunk_sample_count(44100, acc)
        total += n
    assert total == 44100
    assert abs(acc) < 1e-6


def test_enqueue_drops_oldest_when_full():
    queue = asyncio.Queue(maxsize=2)
    enqueue_packet(queue, b"a")
    enqueue_packet(queue, b"b")
    enqueue_packet(queue, b"c")
    assert queue.get_nowait() == b"b"
    assert queue.get_nowait() == b"c"


def test_create_app(iq_wav):
    path, _ = iq_wav()
    app = create_app(str(path), STATIC_DIR, center_freq=7048000)
    assert app[SERVER_KEY].center_freq == 7048000


def test_http_and_websocket_end_to_end(iq_wav):
    """Index and isolation headers over HTTP, then handshake -> config -> 0x03 IQ packets."""
    path, pcm = iq_wav()

    async def run():
        app = create_app(str(path), STATIC_DIR, center_freq=7048000)
        async with TestClient(TestServer(app)) as client:
            resp = await client.get("/")
            assert resp.status == 200
            assert resp.headers["Cross-Origin-Embedder-Policy"] == "require-corp"
            assert "didahSDR" in await resp.text()
            assert (await client.get("/js/app.js")).status == 200

            ws = await client.ws_connect("/ws")
            await ws.send_str("SERVER DE CLIENT client=test version=0 type=receiver")
            config = None
            packets = []
            while config is None or len(packets) < 3:
                msg = await asyncio.wait_for(ws.receive(), timeout=5)
                if msg.type.name == "TEXT" and msg.data.startswith("{"):
                    config = json.loads(msg.data)
                elif msg.type.name == "BINARY":
                    packets.append(msg.data)
            await ws.close()
            return config, packets

    config, packets = asyncio.run(run())
    assert config["type"] == "config"
    assert config["value"]["samp_rate"] == 96000
    assert config["value"]["center_freq"] == 7048000
    for p in packets:
        assert p[0] == 0x03
        assert len(p) == 1 + 2400 * 4  # 25 ms at 96 kHz
    assert b"".join(p[1:] for p in packets) == pcm[: 3 * 9600]
