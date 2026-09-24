"""Shared fixtures. Tests never need a real recording: IQ WAVs are synthesised per test."""

import struct

import pytest


def write_iq_wav(path, pcm: bytes, rate: int = 96000, extensible: bool = False, list_chunk: bool = False):
    """Writes a stereo 16-bit WAV around `pcm` (raw interleaved I/Q bytes). Returns the path."""
    if extensible:
        guid_pcm = struct.pack("<H", 1) + bytes.fromhex("000000001000800000aa00389b71")
        fmt = struct.pack("<HHIIHHHHI", 0xFFFE, 2, rate, rate * 4, 4, 16, 22, 16, 0x3) + guid_pcm
    else:
        fmt = struct.pack("<HHIIHH", 1, 2, rate, rate * 4, 4, 16)
    chunks = b"fmt " + struct.pack("<I", len(fmt)) + fmt
    if list_chunk:
        info = b"INFOISFT\x06\x00\x00\x00didah\x00"
        chunks += b"LIST" + struct.pack("<I", len(info)) + info
    chunks += b"data" + struct.pack("<I", len(pcm)) + pcm
    path.write_bytes(b"RIFF" + struct.pack("<I", 4 + len(chunks)) + b"WAVE" + chunks)
    return path


@pytest.fixture
def iq_wav(tmp_path):
    """Factory: iq_wav(pcm=None, frames=96000, name='iq.wav', **write_iq_wav kwargs) -> (path, pcm)."""

    def make(pcm: bytes | None = None, frames: int = 96000, name: str = "iq.wav", **kw):
        if pcm is None:
            pcm = bytes((i * 7) & 0xFF for i in range(frames * 4))
        return write_iq_wav(tmp_path / name, pcm, **kw), pcm

    return make
