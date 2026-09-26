'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { req } = require('./load.js');
const P = req('didah_proto.js');
const DidahConnection = req('connection.js');
const { PROTO } = P;

// Same bytes as GOLDEN_SET_FREQUENCY in tests/test_server.py: both codecs must agree.
const GOLDEN_SET_FREQUENCY = '6469646168534452' + '01001001' + '07000000' + '0c000000' + '00000000' +
    '01000000' + '005bd60000000000';

test('COMMAND encodes byte for byte like the Python server', () => {
    assert.equal(P.toHex(P.encodeCommand(7, PROTO.CMD.SET_FREQUENCY, 14048000)), GOLDEN_SET_FREQUENCY);
    const h = P.readProtoHeader(P.encodeCommand(7, PROTO.CMD.SET_FREQUENCY, 14048000));
    assert.deepEqual(h, { verMajor: 1, verMinor: 0, type: 0x10, flags: 1, seq: 7, payloadLen: 12 });
    assert.equal(P.readProtoHeader(P.encodeCommand(7, 1, 1, false)).flags, 0);
});

test('header reader rejects short frames and a wrong magic', () => {
    assert.equal(P.readProtoHeader(new ArrayBuffer(10)), null);
    const buf = P.encodePing(1, 5);
    new Uint8Array(buf)[0] = 0x44;
    assert.equal(P.readProtoHeader(buf), null);
});

test('HELLO and PING / PONG payloads', () => {
    const hello = P.encodeHello(0, 'didahSDR web', PROTO.CAP.RX_IQ | PROTO.CAP.TX_IQ);
    assert.equal(hello.byteLength, 24 + 20);
    const dv = new DataView(hello);
    assert.equal(String.fromCharCode(...new Uint8Array(hello, 24, 12)), 'didahSDR web');
    assert.equal(dv.getUint8(24 + 12), 0);
    assert.equal(dv.getUint32(40, true), 3);
    const pong = P.encodePing(3, 2 ** 32 + 17, true);
    assert.equal(P.readProtoHeader(pong).type, PROTO.TYPE.PONG);
    assert.equal(P.readProtoHeader(pong).flags, PROTO.FLAG.RESPONSE);
    assert.equal(new DataView(pong).getUint32(24, true), 17);   // wraps like u32
});

function frame(type, bytes) {
    const buf = new ArrayBuffer(24 + bytes.length);
    P.writeProtoHeader(buf, type, 0, 0, bytes.length);
    new Uint8Array(buf, 24).set(bytes);
    return buf;
}

test('STATUS and DEVICE_INFO decode with the documented scaling', () => {
    const st = new DataView(new ArrayBuffer(24));
    st.setUint32(0, 5000, true); st.setUint32(4, 41, true); st.setUint16(8, 120, true);
    st.setInt16(10, 250, true); st.setUint16(12, 13800, true); st.setInt16(14, -1234, true);
    st.setUint32(16, PROTO.STATUS_FLAG.TX | PROTO.STATUS_FLAG.PTT, true); st.setUint32(20, 14048000, true);
    const s = P.decodeStatus(frame(PROTO.TYPE.STATUS, new Uint8Array(st.buffer)));
    assert.deepEqual(s, { fwdMw: 5000, reflMw: 41, swr: 1.2, paTempC: 25, supplyMv: 13800,
                          adcPeakDbfs: -12.34, flags: 3, freqHz: 14048000 });

    const di = new DataView(new ArrayBuffer(61));
    'didahSDR replay'.split('').forEach((c, i) => di.setUint8(i, c.charCodeAt(0)));
    di.setUint32(36, 0xC3, true); di.setUint32(48, 96000, true); di.setUint8(52, 1); di.setUint32(53, 10000, true);
    const info = P.decodeDeviceInfo(frame(PROTO.TYPE.DEVICE_INFO, new Uint8Array(di.buffer)));
    assert.equal(info.name, 'didahSDR replay');
    assert.equal(info.sampleRate, 96000);
    assert.equal(info.maxTxMw, 10000);
    assert.equal(P.decodeStatus(frame(PROTO.TYPE.STATUS, new Uint8Array(4))), null);
});

test('stream frames put samples at byte 40 and round-trip the sub-header', () => {
    const f = P.allocStreamFrame(PROTO.TYPE.TX_IQ, 4);
    assert.equal(f.samples.byteOffset, 40);
    f.samples.set([1, -1, 2, -2, 3, -3, 4, -4]);
    const buf = P.writeStreamFrame(f, 9, 2 ** 40 + 5, 96000);
    const h = P.readProtoHeader(buf);
    assert.equal(h.type, PROTO.TYPE.TX_IQ);
    assert.equal(h.payloadLen, 16 + 16);
    assert.deepEqual(P.decodeStreamHeader(buf), { sampleIndex: 2 ** 40 + 5, sampleRate: 96000, format: 0, channels: 2 });
    assert.deepEqual(Array.from(new Int16Array(buf, 40)), [1, -1, 2, -2, 3, -3, 4, -4]);
});

function rxFrame(index, n, value) {
    const f = P.allocStreamFrame(PROTO.TYPE.RX_IQ, n);
    f.samples.fill(value);
    return P.writeStreamFrame(f, 0, index, 96000).slice(0);
}

function readyConnection(got) {
    const conn = new DidahConnection({ url: 'ws://x', onRawIQ: (f, n) => got.push([f[0], n]) });
    conn.info = { sampleRate: 96000 };
    conn.ready = true;
    return conn;
}

test('connection scales RX_IQ and zero-fills a dropped packet', () => {
    const got = [];
    const conn = readyConnection(got);
    conn.handleMessage(rxFrame(1000, 2400, 16384));
    conn.handleMessage(rxFrame(1000 + 4800, 2400, 16384));    // one packet lost
    assert.deepEqual(got, [[0.5, 2400], [0, 2400], [0.5, 2400]]);
    assert.deepEqual(conn.stats, { packets: 2, gaps: 1, lostSamples: 2400 });
    assert.equal(conn.rxIndex, 1000 + 7200);
});

test('connection only counts a gap longer than 250 ms', () => {
    const got = [];
    const conn = readyConnection(got);
    conn.handleMessage(rxFrame(0, 2400, 0));
    conn.handleMessage(rxFrame(2400 + 96000, 2400, 0));
    assert.equal(got.length, 2);
    assert.equal(conn.stats.lostSamples, 96000);
});

test('connection becomes ready on the first STATUS after DEVICE_INFO and asks for RX', () => {
    const sent = [];
    let ready = null;
    const conn = new DidahConnection({ url: 'ws://x', onReady: (r) => { ready = r; } });
    conn.ws = { readyState: 1, send: (b) => sent.push(b) };
    conn.connected = true;
    const di = new Uint8Array(61);
    new DataView(di.buffer).setUint32(48, 96000, true);
    conn.handleMessage(frame(PROTO.TYPE.DEVICE_INFO, di));
    const st = new Uint8Array(24);
    new DataView(st.buffer).setUint32(20, 7048000, true);
    conn.handleMessage(frame(PROTO.TYPE.STATUS, st));
    assert.equal(ready.centerFreq, 7048000);
    assert.equal(ready.sampleRate, 96000);
    const cmd = new DataView(sent[0]);
    assert.equal(cmd.getUint16(24, true), PROTO.CMD.SET_RX_STREAM);
    assert.equal(Number(cmd.getBigInt64(28, true)), 1);
});
