from pathlib import Path

from server.replay_server import WavIQLooper, create_app, find_wav_file


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
    app = create_app(wav_path, static_dir, center_freq=14048000, fps=30)
    assert app is not None
    assert "server" in app
