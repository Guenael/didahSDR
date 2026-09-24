'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { req } = require('./load.js');

const {
    encodeFreqBcd, decodeFreqBcd, civCommand, civSetFrequency, civSetMode,
    civSetKeySpeed, civSendCw, civKeySpeedValue, classifyCivFrame, CivParser, Ic7300Cat
} = req('civ.js');
const {
    IC7300_IF_HZ, IC7300_CW_TRACE_HZ, IC7300_CW_PITCH_HZ, IC7300_OUT_RATE, IC7300_SSB_SPAN_HZ,
    mapCivMode, didahToCivMode, ic7300DecimPlan, ic7300Geometry, ic7300View, ic7300Zoom,
    RealIfConverter
} = req('ic7300_if.js');
const { findSource } = req('sources.js');

test('catalog lists the IC-7300 as a real-IF source', () => {
    const src = findSource('ic7300');
    assert.equal(src.protocol, 'ic7300');
    assert.equal(src.startFreq, IC7300_CW_TRACE_HZ - IC7300_IF_HZ);
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

test('mode map and geometry: CW cursor is 650 Hz below the dial', () => {
    assert.equal(mapCivMode(0x03).mod, 'cw');
    assert.equal(mapCivMode(0x01).mod, 'usb');
    assert.equal(mapCivMode(0x00).mod, 'lsb');
    assert.equal(mapCivMode(0x07).label, 'CW-R');
    assert.equal(mapCivMode(0x02).supported, false);
    assert.equal(mapCivMode(0x02).mod, 'cw');

    const radio = 14048000;
    const cw = ic7300Geometry(radio, 0x03, IC7300_OUT_RATE);
    assert.equal(cw.centerFreq, radio);
    assert.equal(cw.tunedFreq, radio - IC7300_CW_PITCH_HZ);
    assert.equal(cw.tunedFreq - cw.centerFreq, -IC7300_CW_PITCH_HZ);
    assert.equal(cw.ifHz, 0);
    assert.equal(cw.modulation, 'cw');

    const usb = ic7300Geometry(radio, 0x01, IC7300_OUT_RATE);
    assert.equal(usb.tunedFreq, radio);
    assert.equal(usb.tunedFreq - usb.centerFreq, 0);
    assert.equal(usb.modulation, 'usb');

    const cwr = ic7300Geometry(radio, 0x07, IC7300_OUT_RATE);
    assert.equal(cwr.tunedFreq - cwr.centerFreq, IC7300_CW_PITCH_HZ);

    const pending = ic7300Geometry(0, null, IC7300_OUT_RATE);
    assert.equal(pending.centerFreq, 0);
    assert.equal(pending.tunedFreq, -IC7300_CW_PITCH_HZ);
});

test('48/96/192 kHz contexts emit 12 kHz; 44.1 kHz scales the pitch', () => {
    assert.equal(ic7300DecimPlan(48000).outRate, 12000);
    assert.equal(ic7300DecimPlan(48000).decim, 4);
    assert.equal(ic7300DecimPlan(96000).outRate, 12000);
    assert.equal(ic7300DecimPlan(96000).decim, 8);
    assert.equal(ic7300DecimPlan(192000).decim, 16);
    const scaled = ic7300Geometry(14048000, 0x03, 11025);
    const expectOff = -Math.round(IC7300_CW_PITCH_HZ * 11025 / 12000);
    assert.equal(scaled.centerFreq, 14048000);
    assert.equal(scaled.tunedFreq - scaled.centerFreq, expectOff);
    assert.notEqual(expectOff, -IC7300_CW_PITCH_HZ);
    assert.equal(ic7300DecimPlan(44100).outRate, 11025);
    assert.equal(ic7300Zoom(12000, 24), 12000 / 2500);
});

function convertReal(conv, freq, rate, n) {
    const iq = new Float32Array(Math.ceil(n / conv.decim) * 2 + 8);
    let fill = 0;
    const w = (2 * Math.PI * freq) / rate;
    for (let i = 0; i < n; i++) {
        if (conv.push(Math.cos(w * i), iq, fill)) fill++;
    }
    return iq.subarray(0, fill * 2);
}

function complexPeak(iq, rate) {
    const fftSize = 2048;
    const fft = new DidahFFT(fftSize);
    const re = new Float32Array(fftSize);
    const im = new Float32Array(fftSize);
    const complex = iq.length / 2;
    const start = complex - fftSize;
    for (let i = 0; i < fftSize; i++) {
        re[i] = iq[(start + i) * 2];
        im[i] = iq[(start + i) * 2 + 1];
    }
    const spec = fft.computeSpectrumDb(re, im);
    const bin = Math.round((1000 / rate) * fftSize);
    return { pos: spec[fftSize / 2 + bin], neg: spec[fftSize / 2 - bin] };
}

test('fs/4 mix centres the 12 kHz IF and rejects the negative image', () => {
    const rate = 48000;
    const n = rate;
    const conv = new RealIfConverter(rate);
    assert.equal(conv.outRate, 12000);
    assert.equal(conv.decim, 4);
    const up = complexPeak(convertReal(conv, 13000, rate, n), conv.outRate);
    assert.ok(up.pos > -6, `+1 kHz level ${up.pos.toFixed(1)} dBFS`);
    assert.ok(up.pos > up.neg + 40, `+1 kHz ${up.pos.toFixed(1)} vs image ${up.neg.toFixed(1)}`);

    const down = complexPeak(convertReal(new RealIfConverter(rate), 11000, rate, n), 12000);
    assert.ok(down.neg > down.pos + 40, `−1 kHz ${down.neg.toFixed(1)} vs image ${down.pos.toFixed(1)}`);

    const wide = new RealIfConverter(96000);
    assert.equal(wide.outRate, 12000);
    const up96 = complexPeak(convertReal(wide, 13000, 96000, 96000), 12000);
    assert.ok(up96.pos > up96.neg + 40, `96 kHz +1 kHz ${up96.pos.toFixed(1)} vs image ${up96.neg.toFixed(1)}`);
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

    const speed = civSetKeySpeed(20);
    assert.equal(speed[4], 0x14);
    assert.equal(speed[5], 0x0C);
    assert.equal(speed[speed.length - 1], 0xFD);
    assert.equal(civKeySpeedValue(6), 0);
    assert.equal(civKeySpeedValue(48), 255);
    const cw = civSendCw('CQ');
    assert.equal(cw[4], 0x17);
    assert.equal(cw[5], 0x43);
    assert.equal(cw[6], 0x51);
    assert.equal(cw[7], 0xFD);
    assert.equal(civSendCw(''), null);
    assert.equal(civSendCw('x'.repeat(40)).length, 36);
});

test('SSB view covers about 4 kHz of the sideband; CW stays on the trace', () => {
    const cw = ic7300View(0x03, IC7300_OUT_RATE);
    assert.equal(cw.span, 2500);
    assert.equal(cw.audioCenter, -IC7300_CW_PITCH_HZ);
    const usb = ic7300View(0x01, IC7300_OUT_RATE, { low: 200, high: 2700 });
    assert.equal(usb.span, IC7300_SSB_SPAN_HZ);
    assert.equal(usb.audioCenter, 1450);
    const lsb = ic7300View(0x00, IC7300_OUT_RATE, { low: -2700, high: -200 });
    assert.equal(lsb.audioCenter, -1450);
    const usbLo = usb.audioCenter - usb.span / 2;
    const usbHi = usb.audioCenter + usb.span / 2;
    assert.ok(usbLo <= 200 && usbHi >= 2700);
});

test('a key held past the watchdog is released and stays up until the keyer lets go', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const signals = [];
    const statuses = [];
    const cat = new Ic7300Cat({ keyWatchdogMs: 1000, onStatus: (text) => statuses.push(text) });
    cat.port = { setSignals: (s) => { signals.push(s); return Promise.resolve(); } };
    cat.setLines(true, true);
    t.mock.timers.tick(999);
    assert.equal(statuses.length, 0);
    t.mock.timers.tick(1);
    await cat._signalChain;
    assert.deepEqual(signals[signals.length - 1], { dataTerminalReady: false, requestToSend: false });
    assert.match(statuses[0], /released/);

    // The keyer still reports key down: the lines must not come back.
    const n = signals.length;
    await cat.setLines(true, true);
    assert.equal(signals.length, n);
    // Key up clears the lockout; the next element keys normally.
    await cat.setLines(false, false);
    await cat.setLines(true, true);
    assert.deepEqual(signals[signals.length - 1], { dataTerminalReady: true, requestToSend: true });
});

test('key edges inside the watchdog window never trip it', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const statuses = [];
    const cat = new Ic7300Cat({ keyWatchdogMs: 1000, onStatus: (text) => statuses.push(text) });
    cat.port = { setSignals: () => Promise.resolve() };
    for (let i = 0; i < 20; i++) {
        cat.setLines(true, true);
        t.mock.timers.tick(400);
        cat.setLines(false, true);
        t.mock.timers.tick(100);
    }
    assert.equal(statuses.length, 0);
    cat.releaseKey();
});
