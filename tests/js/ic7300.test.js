'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { req } = require('./load.js');

const {
    encodeFreqBcd, decodeFreqBcd, civCommand, civSetFrequency, civSetMode, classifyCivFrame, CivParser, Ic7300Cat
} = req('civ.js');
const {
    IC7300_IF_HZ, IC7300_CW_TRACE_HZ, IC7300_NATIVE_RATE, IC7300_SSB_SPAN_HZ,
    mapCivMode, didahToCivMode, ic7300IfScale, ic7300Geometry, ic7300View, ic7300Zoom,
    designHilbert, RealIfConverter
} = req('ic7300_if.js');
const { findSource } = req('sources.js');

test('catalog lists the IC-7300 as a real-IF source', () => {
    const src = findSource('ic7300');
    assert.equal(src.protocol, 'ic7300');
    assert.equal(src.startFreq, IC7300_CW_TRACE_HZ);
    assert.equal(src.startMod, 'cw');
});

test('BCD frequency round-trips and the read commands carry no payload', () => {
    for (const hz of [14200000, 14048000, 7048000, 1800000]) {
        const bytes = encodeFreqBcd(hz);
        assert.equal(bytes.length, 5);
        assert.equal(decodeFreqBcd(bytes), hz);
    }
    assert.deepEqual(Array.from(civCommand(0x03)), [0xFE, 0xFE, 0x94, 0xE0, 0x03, 0xFD]);
    assert.deepEqual(Array.from(civCommand(0x04)), [0xFE, 0xFE, 0x94, 0xE0, 0x04, 0xFD]);
    assert.equal(Array.from(civCommand(0x03)).includes(0x05), false);
});

test('frames: frequency, mode, echo, and a split stream', () => {
    const bcd = encodeFreqBcd(14200000);
    const freq = new Uint8Array([0xFE, 0xFE, 0xE0, 0x94, 0x03, ...bcd, 0xFD]);
    const transceive = new Uint8Array([0xFE, 0xFE, 0x00, 0x94, 0x00, ...bcd, 0xFD]);
    const mode = new Uint8Array([0xFE, 0xFE, 0xE0, 0x94, 0x04, 0x03, 0x01, 0xFD]);
    const echo = new Uint8Array([0xFE, 0xFE, 0x94, 0xE0, 0x03, 0xFD]);

    const parser = new CivParser();
    const got = [];
    parser.push(freq.subarray(0, 4), (body) => got.push(classifyCivFrame(body)));
    parser.push(freq.subarray(4), (body) => got.push(classifyCivFrame(body)));
    const both = new Uint8Array(transceive.length + mode.length + echo.length);
    both.set(transceive, 0);
    both.set(mode, transceive.length);
    both.set(echo, transceive.length + mode.length);
    parser.push(both, (body) => got.push(classifyCivFrame(body)));

    assert.equal(got.length, 4);
    assert.equal(got[0].kind, 'freq');
    assert.equal(got[0].hz, 14200000);
    assert.equal(got[1].kind, 'freq');
    assert.equal(got[1].hz, 14200000);
    assert.equal(got[2].kind, 'mode');
    assert.equal(got[2].mode, 0x03);
    assert.equal(got[2].filter, 0x01);
    assert.equal(got[3].kind, 'echo');
});

test('swapped wiring puts PTT on DTR and CW on RTS', async () => {
    const signals = [];
    const cat = new Ic7300Cat({});
    cat.setWiring('ptt-dtr');
    cat.port = {
        setSignals: (s) => {
            signals.push(s);
            return Promise.resolve();
        }
    };
    await cat.setLines(true, true);
    await cat.setLines(false, true);
    await cat.releaseKey();
    assert.deepEqual(signals, [
        { dataTerminalReady: true, requestToSend: false },
        { dataTerminalReady: true, requestToSend: true },
        { dataTerminalReady: true, requestToSend: false },
        { dataTerminalReady: false, requestToSend: false }
    ]);
});

test('default wiring puts PTT on RTS and CW on DTR', async () => {
    const signals = [];
    const cat = new Ic7300Cat({});
    cat.port = {
        setSignals: (s) => {
            signals.push(s);
            return Promise.resolve();
        }
    };
    await cat.setLines(true, true);
    await cat.setLines(true, true);
    await cat.setLines(false, true);
    await cat.releaseKey();
    assert.deepEqual(signals, [
        { dataTerminalReady: false, requestToSend: true },
        { dataTerminalReady: true, requestToSend: true },
        { dataTerminalReady: false, requestToSend: true },
        { dataTerminalReady: false, requestToSend: false }
    ]);
});

test('mode map and geometry: CW cursor 11.350 kHz, USB on the carrier', () => {
    assert.equal(mapCivMode(0x03).mod, 'cw');
    assert.equal(mapCivMode(0x01).mod, 'usb');
    assert.equal(mapCivMode(0x00).mod, 'lsb');
    assert.equal(mapCivMode(0x07).label, 'CW-R');
    assert.equal(mapCivMode(0x02).supported, false);
    assert.equal(mapCivMode(0x02).mod, 'cw');

    const radio = 14048000;
    const cw = ic7300Geometry(radio, 0x03, IC7300_NATIVE_RATE);
    assert.equal(cw.centerFreq, radio - IC7300_IF_HZ);
    assert.equal(cw.tunedFreq, radio - (IC7300_IF_HZ - IC7300_CW_TRACE_HZ));
    assert.equal(cw.tunedFreq - cw.centerFreq, IC7300_CW_TRACE_HZ);
    assert.equal(cw.modulation, 'cw');

    const usb = ic7300Geometry(radio, 0x01, 48000);
    assert.equal(usb.tunedFreq, radio);
    assert.equal(usb.tunedFreq - usb.centerFreq, IC7300_IF_HZ);
    assert.equal(usb.modulation, 'usb');

    const cwr = ic7300Geometry(radio, 0x07, 48000);
    assert.equal(cwr.tunedFreq - cwr.centerFreq, IC7300_IF_HZ + (IC7300_IF_HZ - IC7300_CW_TRACE_HZ));

    const pending = ic7300Geometry(0, null, 48000);
    assert.equal(pending.centerFreq, 0);
    assert.equal(pending.tunedFreq, IC7300_CW_TRACE_HZ);
});

test('96 kHz keeps the 12 kHz IF; 44.1 kHz scales it', () => {
    assert.equal(ic7300IfScale(48000), 1);
    assert.equal(ic7300IfScale(96000), 1);
    assert.equal(ic7300IfScale(192000), 1);
    const scaled = ic7300Geometry(14048000, 0x03, 44100);
    const expectTrace = Math.round(IC7300_CW_TRACE_HZ * 44100 / 48000);
    assert.equal(scaled.tunedFreq - scaled.centerFreq, expectTrace);
    assert.notEqual(expectTrace, IC7300_CW_TRACE_HZ);
    assert.equal(ic7300Zoom(48000, 24), 48000 / 2500);
    assert.equal(ic7300Zoom(96000, 24), 24);
});

test('Hilbert taps are antisymmetric and reject the negative image', () => {
    const h = designHilbert(63);
    const mid = (h.length - 1) >> 1;
    assert.equal(h[mid], 0);
    for (let k = 1; k <= mid; k++) {
        assert.ok(Math.abs(h[mid + k] + h[mid - k]) < 1e-6);
    }

    const rate = 48000;
    const freq = 3000;
    const n = 8192;
    const conv = new RealIfConverter(h);
    const iq = new Int16Array(n * 2);
    for (let i = 0; i < n; i++) {
        conv.step(Math.cos((2 * Math.PI * freq * i) / rate), iq, i);
    }
    const fftSize = 2048;
    const fft = new DidahFFT(fftSize);
    const re = new Float32Array(fftSize);
    const im = new Float32Array(fftSize);
    const start = n - fftSize;
    for (let i = 0; i < fftSize; i++) {
        re[i] = iq[(start + i) * 2] / 32767;
        im[i] = iq[(start + i) * 2 + 1] / 32767;
    }
    const spec = fft.computeSpectrumDb(re, im);
    const bin = Math.round((freq / rate) * fftSize);
    const pos = fftSize / 2 + bin;
    const neg = fftSize / 2 - bin;
    assert.ok(spec[pos] > spec[neg] + 30, `positive ${spec[pos]} negative ${spec[neg]}`);
});

test('set-frequency and set-mode frames', () => {
    const frame = civSetFrequency(14200000);
    assert.equal(frame[4], 0x05);
    assert.equal(frame[frame.length - 1], 0xFD);
    assert.equal(decodeFreqBcd(frame.subarray(5, 10)), 14200000);
    assert.deepEqual(Array.from(civSetMode(0x01, 0x01)), [0xFE, 0xFE, 0x94, 0xE0, 0x06, 0x01, 0x01, 0xFD]);
    assert.equal(civSetMode(0x03, 9)[6], 0x03);
    assert.equal(didahToCivMode('lsb'), 0x00);
    assert.equal(didahToCivMode('usb'), 0x01);
    assert.equal(didahToCivMode('cw'), 0x03);
});

test('SSB view covers about 4 kHz of the sideband; CW stays on the trace', () => {
    const cw = ic7300View(0x03, 48000);
    assert.equal(cw.span, 2500);
    assert.equal(cw.audioCenter, IC7300_CW_TRACE_HZ);
    const usb = ic7300View(0x01, 48000, { low: 200, high: 2700 });
    assert.equal(usb.span, IC7300_SSB_SPAN_HZ);
    assert.equal(usb.audioCenter, IC7300_IF_HZ + 1450);
    const lsb = ic7300View(0x00, 48000, { low: -2700, high: -200 });
    assert.equal(lsb.audioCenter, IC7300_IF_HZ - 1450);
    const usbLo = usb.audioCenter - usb.span / 2;
    const usbHi = usb.audioCenter + usb.span / 2;
    assert.ok(usbLo <= IC7300_IF_HZ + 200 && usbHi >= IC7300_IF_HZ + 2700);
});
