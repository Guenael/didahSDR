import asyncio
import logging
import struct
from pathlib import Path

import pytest
from aiohttp.test_utils import TestClient, TestServer

from server.replay_server import (
    ACK_S,
    COMMAND_S,
    DEVICE_INFO_S,
    ERROR_S,
    EVENT_S,
    FLAG_ACK_REQ,
    HEADER,
    HELLO_S,
    MAX_TX_MW,
    SERVER_KEY,
    STATUS_S,
    STREAM_HEADER,
    Cap,
    Cmd,
    Err,
    Event,
    MsgType,
    StatusFlag,
    WavIQLooper,
    chunk_sample_count,
    create_app,
    enqueue_packet,
    find_wav_file,
    iq_energy,
    iq_peak,
    pack_message,
    parse_header,
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


GOLDEN_SET_FREQUENCY = "6469646168534452" "01001001" "07000000" "0c000000" "00000000" "01000000" "005bd60000000000"


def cmd(seq, code, value, flags=FLAG_ACK_REQ):
    return pack_message(MsgType.COMMAND, seq, COMMAND_S.pack(code, 0, value), flags)


def hello(seq=0):
    return pack_message(MsgType.HELLO, seq, HELLO_S.pack(b"pytest".ljust(16, b"\0"), int(Cap.RX_IQ | Cap.TX_IQ)))


async def recv_until(ws, msg_type, timeout=5.0):
    """Next binary frame of `msg_type` as (header, payload); other frames are skipped."""
    while True:
        msg = await asyncio.wait_for(ws.receive(), timeout=timeout)
        assert msg.type.name == "BINARY", msg
        hdr = parse_header(msg.data)
        assert hdr is not None
        if hdr[2] == msg_type:
            return hdr, msg.data[HEADER.size : HEADER.size + hdr[5]]


def test_golden_command_matches_the_js_codec():
    """Same hex as tests/js/didah_proto.test.js: both codecs must frame a COMMAND byte for byte alike."""
    assert cmd(7, Cmd.SET_FREQUENCY, 14048000).hex() == GOLDEN_SET_FREQUENCY
    assert parse_header(bytes.fromhex(GOLDEN_SET_FREQUENCY)) == (1, 0, MsgType.COMMAND, FLAG_ACK_REQ, 7, 12)
    assert parse_header(b"notdidah" + bytes(16)) is None
    assert parse_header(b"didahSDR") is None


def test_iq_energy_full_scale_is_one():
    raw = struct.pack("<4h", 32767, 0, 0, -32768)
    assert iq_energy(raw) == pytest.approx(2.0, rel=1e-4)
    assert iq_peak(raw) == 32768


def test_http_and_websocket_end_to_end(iq_wav):
    """Index and isolation headers over HTTP, then HELLO -> DEVICE_INFO + STATUS -> SET_RX_STREAM -> RX_IQ."""
    path, pcm = iq_wav()

    async def run():
        app = create_app(str(path), STATIC_DIR, center_freq=7048000)
        async with TestClient(TestServer(app)) as client:
            resp = await client.get("/")
            assert resp.status == 200
            assert resp.headers["Cross-Origin-Embedder-Policy"] == "require-corp"
            assert "didahSDR" in await resp.text()
            assert (await client.get("/js/app.js")).status == 200
            assert (await client.get("/js/didah_proto.js")).status == 200

            ws = await client.ws_connect("/ws")
            await ws.send_bytes(hello())
            _, info = await recv_until(ws, MsgType.DEVICE_INFO)
            _, status = await recv_until(ws, MsgType.STATUS)
            await ws.send_bytes(cmd(1, Cmd.SET_RX_STREAM, 1))
            _, ack = await recv_until(ws, MsgType.ACK)
            packets = [(await recv_until(ws, MsgType.RX_IQ))[1] for _ in range(3)]
            await ws.send_bytes(cmd(2, Cmd.SET_FREQUENCY, 14000000))
            _, freq_ack = await recv_until(ws, MsgType.ACK)
            await ws.send_bytes(cmd(3, Cmd.SET_RF_GAIN, 100))
            _, err = await recv_until(ws, MsgType.ERROR)
            await ws.close()
            return info, status, ack, packets, freq_ack, err

    info, status, ack, packets, freq_ack, err = asyncio.run(run())
    name, _fw, _serial, caps, fmin, fmax, rate, formats, max_tx, _, _ = DEVICE_INFO_S.unpack(info)
    assert name.rstrip(b"\0") == b"didahSDR replay"
    assert (fmin, fmax, rate, formats, max_tx) == (7048000, 7048000, 96000, 1, MAX_TX_MW)
    assert caps & Cap.RX_IQ and caps & Cap.TX_IQ and not caps & Cap.TX_KEY
    assert STATUS_S.unpack(status)[7] == 7048000
    assert STATUS_S.unpack(status)[6] & StatusFlag.PLL_LOCK
    assert ACK_S.unpack(ack) == (1, Cmd.SET_RX_STREAM, 0, 1)
    assert ACK_S.unpack(freq_ack)[3] == 7048000  # fixed LO: the ACK reports where it stays
    assert ERROR_S.unpack(err) == (3, Err.UNSUPPORTED)

    first = STREAM_HEADER.unpack_from(packets[0])[0]
    raw = b""
    for k, p in enumerate(packets):
        index, rate, fmt, channels, _ = STREAM_HEADER.unpack_from(p)
        assert (index, rate, fmt, channels) == (first + 2400 * k, 96000, 0, 2)  # contiguous, 25 ms each
        assert len(p) == STREAM_HEADER.size + 2400 * 4
        raw += p[STREAM_HEADER.size :]
    start = (first * 4) % len(pcm)  # the stream ran before RX was enabled: index = samples since start
    assert raw == (pcm + pcm)[start : start + 3 * 9600]


def test_tx_iq_is_measured_and_logged(iq_wav, caplog):
    """PTT on, full-scale TX_IQ -> STATUS shows the set power and SWR 1.2; PTT off logs the over."""
    path, _ = iq_wav()
    tone = struct.pack("<2h", 32767, 0) * 2400

    async def run():
        app = create_app(str(path), STATIC_DIR, center_freq=7048000)
        async with TestClient(TestServer(app)) as client:
            ws = await client.ws_connect("/ws")
            await ws.send_bytes(hello())
            await recv_until(ws, MsgType.STATUS)
            await ws.send_bytes(cmd(1, Cmd.SET_TX_POWER, 50000))
            _, power_ack = await recv_until(ws, MsgType.ACK)
            await ws.send_bytes(cmd(2, Cmd.SET_PTT, 1))
            await recv_until(ws, MsgType.ACK)
            for k in range(4):
                stream = STREAM_HEADER.pack(1000 + 2400 * k, 96000, 0, 2, 0)
                await ws.send_bytes(pack_message(MsgType.TX_IQ, 3 + k, stream + tone))
            while True:
                _, st = await recv_until(ws, MsgType.STATUS)
                if STATUS_S.unpack(st)[0] > 0:
                    break
            await ws.send_bytes(cmd(9, Cmd.SET_PTT, 0))
            await recv_until(ws, MsgType.ACK)
            await ws.close()
            return power_ack, st

    with caplog.at_level(logging.INFO, logger="didahSDR-Server"):
        power_ack, st = asyncio.run(run())
    assert ACK_S.unpack(power_ack)[3] == MAX_TX_MW  # clamped
    fwd, refl, swr_x100, _, _, _, flags, _ = STATUS_S.unpack(st)
    assert fwd == pytest.approx(MAX_TX_MW, rel=1e-3)
    assert refl == pytest.approx(fwd * (0.2 / 2.2) ** 2, abs=1)
    assert swr_x100 == 120
    assert flags & StatusFlag.TX and flags & StatusFlag.PTT
    assert "TX enabled" in caplog.text
    assert "TX released" in caplog.text and "9600 IQ samples" in caplog.text and "0 gaps" in caplog.text


def test_tx_watchdog_drops_ptt(iq_wav, caplog):
    path, _ = iq_wav()

    async def run():
        app = create_app(str(path), STATIC_DIR, center_freq=7048000)
        async with TestClient(TestServer(app)) as client:
            ws = await client.ws_connect("/ws")
            await ws.send_bytes(hello())
            await recv_until(ws, MsgType.STATUS)
            await ws.send_bytes(cmd(1, Cmd.SET_TX_WATCHDOG, 150))
            _, wd_ack = await recv_until(ws, MsgType.ACK)
            await ws.send_bytes(cmd(2, Cmd.SET_PTT, 1))
            _, event = await recv_until(ws, MsgType.EVENT)
            _, st = await recv_until(ws, MsgType.STATUS)
            await ws.close()
            return wd_ack, event, st

    with caplog.at_level(logging.INFO, logger="didahSDR-Server"):
        wd_ack, event, st = asyncio.run(run())
    assert ACK_S.unpack(wd_ack)[3] == 150
    assert EVENT_S.unpack(event) == (Event.WATCHDOG, 150)
    flags = STATUS_S.unpack(st)[6]
    assert flags & StatusFlag.WATCHDOG_TRIP and not flags & StatusFlag.PTT
    assert "watchdog" in caplog.text


def test_version_mismatch_and_text_frames_close_the_link(iq_wav):
    path, _ = iq_wav()

    async def run():
        app = create_app(str(path), STATIC_DIR, center_freq=7048000)
        async with TestClient(TestServer(app)) as client:
            ws = await client.ws_connect("/ws")
            v2 = bytearray(hello())
            v2[8] = 2
            await ws.send_bytes(bytes(v2))
            _, err = await recv_until(ws, MsgType.ERROR)
            closed = await asyncio.wait_for(ws.receive(), timeout=5)

            ws2 = await client.ws_connect("/ws")
            await ws2.send_str("SERVER DE CLIENT client=old")
            closed2 = await asyncio.wait_for(ws2.receive(), timeout=5)
            return err, closed, closed2

    err, closed, closed2 = asyncio.run(run())
    assert ERROR_S.unpack(err)[1] == Err.VERSION
    assert closed.type.name in ("CLOSE", "CLOSED")
    assert closed2.type.name in ("CLOSE", "CLOSED")
