from pathlib import Path

import asyncio

from server.replay_server import WavIQLooper, chunk_sample_count, create_app, enqueue_packet, find_wav_file


def test_wav_iq_looper():
    wav_path = find_wav_file()
    assert Path(wav_path).is_file()

    looper = WavIQLooper(wav_path)
    assert looper.framerate == 96000
    assert looper.channels == 2
    assert looper.total_samples > 0

    # Test next_raw_iq_bytes (protocol 0x03 payload)
    chunk_samples = 480
    raw_bytes = looper.next_raw_iq_bytes(chunk_samples)
    assert len(raw_bytes) == chunk_samples * 4  # 2 channels * 2 bytes
    looper.close()


def test_looper_streams_and_wraps_like_the_file(tmp_path):
    """Small blocks force many block boundaries and wraps; output must equal the data chunk looped."""
    import wave

    # 1 s synthetic stereo 16-bit WAV with a LIST chunk before 'data', so the chunk walker is exercised
    frames = 96000
    pcm = bytes((i * 7) & 0xFF for i in range(frames * 4))
    wav_path = tmp_path / "synthetic.wav"
    with wave.open(str(wav_path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(96000)
        w.writeframes(pcm)

    looper = WavIQLooper(str(wav_path), block_bytes=4096, prefetch_blocks=2)
    assert looper.total_samples == frames
    with open(wav_path, "rb") as f:
        f.seek(looper.data_offset)
        assert f.read(looper.data_bytes) == pcm

    # Read 2.5 loops in 9600-byte packets (not a divisor of 4096, so packets straddle blocks and the wrap)
    want_total = looper.data_bytes * 5 // 2
    got = bytearray()
    while len(got) < want_total:
        got += looper.next_raw_iq_bytes(2400)
    assert bytes(got) == (pcm * 3)[: len(got)]
    looper.close()


def test_looper_rejects_bad_data_chunk(tmp_path):
    bad = tmp_path / "bad.wav"
    bad.write_bytes(b"RIFF" + (36).to_bytes(4, "little") + b"WAVE" + b"fmt " + (16).to_bytes(4, "little") + b"\0" * 16)
    import pytest

    with pytest.raises(Exception):
        WavIQLooper(str(bad))


def test_create_app():
    wav_path = find_wav_file()
    static_dir = Path(__file__).resolve().parent.parent / "app"
    app = create_app(wav_path, static_dir, center_freq=14048000)
    assert app is not None
    assert "server" in app


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


def test_prefetch_reserves_the_block_before_reading(tmp_path):
    """The sync fallback must not re-read a block the prefetch task has already claimed."""
    import wave

    frames = 96000
    pcm = bytes(i % 251 for i in range(frames * 4))
    wav_path = tmp_path / "prefetch.wav"
    with wave.open(str(wav_path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(96000)
        w.writeframes(pcm)

    looper = WavIQLooper(str(wav_path), block_bytes=4096, prefetch_blocks=2)
    pos = looper._reserve_block_pos()
    assert pos == 0
    assert looper._read_pos == 4096
    reserved = looper._read_block(pos)
    fallback = looper._read_block(looper._read_pos)
    assert reserved != fallback
    looper.close()


def test_enqueue_drops_oldest_when_full():
    queue = asyncio.Queue(maxsize=2)
    enqueue_packet(queue, b"a")
    enqueue_packet(queue, b"b")
    enqueue_packet(queue, b"c")
    assert queue.get_nowait() == b"b"
    assert queue.get_nowait() == b"c"
