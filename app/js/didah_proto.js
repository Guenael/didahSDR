/**
 * didahSDR - link protocol v1 codec (docs/protocol.md). DOM-free; server/replay_server.py mirrors it.
 *
 * Every message: 24-byte header (magic "didahSDR", version, type, flags, seq, payload_len, reserved),
 * little-endian, then the payload. Stream payloads (RX_IQ / TX_IQ) start with a 16-byte sub-header,
 * so the samples sit at byte 40 and typed-array views need no copy.
 */

const PROTO = Object.freeze({
    MAGIC: 'didahSDR',
    VER_MAJOR: 1,
    VER_MINOR: 0,
    HEADER_BYTES: 24,
    STREAM_HEADER_BYTES: 16,
    TYPE: Object.freeze({
        HELLO: 0x01, DEVICE_INFO: 0x02, PING: 0x03, PONG: 0x04, ACK: 0x05, ERROR: 0x06,
        COMMAND: 0x10, RX_IQ: 0x20, TX_IQ: 0x21, TX_KEY: 0x22, STATUS: 0x30, EVENT: 0x31
    }),
    FLAG: Object.freeze({ ACK_REQ: 1, RESPONSE: 2, ERROR: 4 }),
    CMD: Object.freeze({
        SET_FREQUENCY: 0x01, SET_SAMPLE_RATE: 0x02, SET_RF_GAIN: 0x03, SET_IF_GAIN: 0x04,
        SET_FREQ_CORRECTION: 0x05, SET_TX_POWER: 0x06, SET_PTT: 0x07, SET_RX_STREAM: 0x08,
        SET_TX_WATCHDOG: 0x09, GET_STATUS: 0x0A
    }),
    ERR: Object.freeze({ VERSION: 1, UNSUPPORTED: 2, RANGE: 3, BUSY: 4, TX_INHIBIT: 5 }),
    CAP: Object.freeze({
        RX_IQ: 1 << 0, TX_IQ: 1 << 1, TX_KEY: 1 << 2, RF_GAIN: 1 << 3, IF_GAIN: 1 << 4,
        FREQ_CORR: 1 << 5, TX_POWER: 1 << 6, SWR_METER: 1 << 7, SAMPLE_RATE: 1 << 8
    }),
    FMT: Object.freeze({ INT16: 0, INT24: 1, FLOAT32: 2 }),
    STATUS_FLAG: Object.freeze({
        TX: 1 << 0, PTT: 1 << 1, ADC_OVERLOAD: 1 << 2, PLL_LOCK: 1 << 3, SWR_FOLDBACK: 1 << 4,
        TX_UNDERRUN: 1 << 5, WATCHDOG_TRIP: 1 << 6, OVER_TEMP: 1 << 7
    }),
    EVENT: Object.freeze({ SWR_TRIP: 1, OVER_TEMP: 2, WATCHDOG: 3, SUPPLY: 4 })
});

const PROTO_MAGIC_BYTES = Uint8Array.from(PROTO.MAGIC, (c) => c.charCodeAt(0));

/** Bytes per complex sample for a stream format (I and Q). */
function protoSampleBytes(format) {
    return format === PROTO.FMT.INT16 ? 4 : 8;
}

function writeProtoHeader(buffer, type, flags, seq, payloadLen) {
    new Uint8Array(buffer, 0, 8).set(PROTO_MAGIC_BYTES);
    const dv = new DataView(buffer);
    dv.setUint8(8, PROTO.VER_MAJOR);
    dv.setUint8(9, PROTO.VER_MINOR);
    dv.setUint8(10, type);
    dv.setUint8(11, flags);
    dv.setUint32(12, seq >>> 0, true);
    dv.setUint32(16, payloadLen >>> 0, true);
    dv.setUint32(20, 0, true);
}

/** Header fields, or null when the frame is short or the magic is wrong. */
function readProtoHeader(buffer) {
    if (!buffer || buffer.byteLength < PROTO.HEADER_BYTES) return null;
    const b = new Uint8Array(buffer, 0, 8);
    for (let i = 0; i < 8; i++) if (b[i] !== PROTO_MAGIC_BYTES[i]) return null;
    const dv = new DataView(buffer);
    return {
        verMajor: dv.getUint8(8),
        verMinor: dv.getUint8(9),
        type: dv.getUint8(10),
        flags: dv.getUint8(11),
        seq: dv.getUint32(12, true),
        payloadLen: dv.getUint32(16, true)
    };
}

function protoFrame(type, flags, seq, payloadLen) {
    const buf = new ArrayBuffer(PROTO.HEADER_BYTES + payloadLen);
    writeProtoHeader(buf, type, flags, seq, payloadLen);
    return buf;
}

function writeFixedAscii(dv, off, len, text) {
    const s = String(text || '');
    for (let i = 0; i < len; i++) dv.setUint8(off + i, i < s.length ? s.charCodeAt(i) & 0x7f : 0);
}

function readFixedAscii(dv, off, len) {
    let s = '';
    for (let i = 0; i < len; i++) {
        const c = dv.getUint8(off + i);
        if (c === 0) break;
        s += String.fromCharCode(c);
    }
    return s;
}

function encodeHello(seq, clientName, capsWanted) {
    const buf = protoFrame(PROTO.TYPE.HELLO, 0, seq, 20);
    const dv = new DataView(buf);
    writeFixedAscii(dv, 24, 16, clientName);
    dv.setUint32(40, capsWanted >>> 0, true);
    return buf;
}

/** COMMAND with an i64 value. ACK requested unless ackReq is false. */
function encodeCommand(seq, cmd, value, ackReq = true) {
    const buf = protoFrame(PROTO.TYPE.COMMAND, ackReq ? PROTO.FLAG.ACK_REQ : 0, seq, 12);
    const dv = new DataView(buf);
    dv.setUint16(24, cmd, true);
    dv.setUint16(26, 0, true);
    dv.setBigInt64(28, BigInt(Math.round(value)), true);
    return buf;
}

function encodePing(seq, tMs, pong = false) {
    const buf = protoFrame(pong ? PROTO.TYPE.PONG : PROTO.TYPE.PING, pong ? PROTO.FLAG.RESPONSE : 0, seq, 4);
    new DataView(buf).setUint32(24, tMs >>> 0, true);
    return buf;
}

function decodeDeviceInfo(buffer) {
    const dv = new DataView(buffer, PROTO.HEADER_BYTES);
    if (dv.byteLength < 61) return null;
    return {
        name: readFixedAscii(dv, 0, 16),
        fw: readFixedAscii(dv, 16, 16),
        serial: dv.getUint32(32, true),
        caps: dv.getUint32(36, true),
        freqMin: dv.getUint32(40, true),
        freqMax: dv.getUint32(44, true),
        sampleRate: dv.getUint32(48, true),
        formats: dv.getUint8(52),
        maxTxMw: dv.getUint32(53, true),
        rfGainMin: dv.getInt16(57, true),
        rfGainMax: dv.getInt16(59, true)
    };
}

function decodeAck(buffer) {
    const dv = new DataView(buffer, PROTO.HEADER_BYTES);
    if (dv.byteLength < 16) return null;
    return {
        refSeq: dv.getUint32(0, true),
        cmd: dv.getUint16(4, true),
        status: dv.getUint16(6, true),
        applied: Number(dv.getBigInt64(8, true))
    };
}

function decodeError(buffer) {
    const dv = new DataView(buffer, PROTO.HEADER_BYTES);
    if (dv.byteLength < 6) return null;
    return { refSeq: dv.getUint32(0, true), code: dv.getUint16(4, true) };
}

function decodeStatus(buffer) {
    const dv = new DataView(buffer, PROTO.HEADER_BYTES);
    if (dv.byteLength < 24) return null;
    return {
        fwdMw: dv.getUint32(0, true),
        reflMw: dv.getUint32(4, true),
        swr: dv.getUint16(8, true) / 100,
        paTempC: dv.getInt16(10, true) / 10,
        supplyMv: dv.getUint16(12, true),
        adcPeakDbfs: dv.getInt16(14, true) / 100,
        flags: dv.getUint32(16, true),
        freqHz: dv.getUint32(20, true)
    };
}

function decodeEvent(buffer) {
    const dv = new DataView(buffer, PROTO.HEADER_BYTES);
    if (dv.byteLength < 6) return null;
    return { code: dv.getUint16(0, true), value: dv.getInt32(2, true) };
}

/** RX_IQ / TX_IQ sub-header. Samples start at HEADER_BYTES + STREAM_HEADER_BYTES. */
function decodeStreamHeader(buffer) {
    const dv = new DataView(buffer, PROTO.HEADER_BYTES);
    if (dv.byteLength < PROTO.STREAM_HEADER_BYTES) return null;
    return {
        sampleIndex: Number(dv.getBigUint64(0, true)),
        sampleRate: dv.getUint32(8, true),
        format: dv.getUint8(12),
        channels: dv.getUint8(13)
    };
}

/** Preallocated int16 stream frame for n complex samples; samples are an Int16Array view at byte 40. */
function allocStreamFrame(type, nComplex) {
    const payload = PROTO.STREAM_HEADER_BYTES + nComplex * 4;
    const buffer = new ArrayBuffer(PROTO.HEADER_BYTES + payload);
    return {
        buffer,
        type,
        nComplex,
        samples: new Int16Array(buffer, PROTO.HEADER_BYTES + PROTO.STREAM_HEADER_BYTES, nComplex * 2)
    };
}

/** Fill the headers of a frame from allocStreamFrame (int16, 2 channels). */
function writeStreamFrame(frame, seq, sampleIndex, sampleRate) {
    writeProtoHeader(frame.buffer, frame.type, 0, seq, PROTO.STREAM_HEADER_BYTES + frame.nComplex * 4);
    const dv = new DataView(frame.buffer, PROTO.HEADER_BYTES, PROTO.STREAM_HEADER_BYTES);
    dv.setBigUint64(0, BigInt(sampleIndex), true);
    dv.setUint32(8, sampleRate >>> 0, true);
    dv.setUint8(12, PROTO.FMT.INT16);
    dv.setUint8(13, 2);
    dv.setUint16(14, 0, true);
    return frame.buffer;
}

function toHex(buffer) {
    return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

if (typeof module !== 'undefined') {
    module.exports = {
        PROTO, protoSampleBytes, writeProtoHeader, readProtoHeader, encodeHello, encodeCommand, encodePing,
        decodeDeviceInfo, decodeAck, decodeError, decodeStatus, decodeEvent, decodeStreamHeader,
        allocStreamFrame, writeStreamFrame, toHex
    };
}
