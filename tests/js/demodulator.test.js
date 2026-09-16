'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { iqTone, audioPeak } = require('./load.js');

const RATE = 96000, AUDIO = 48000;

function run(demod, iq, chunk = 4800) {
    const parts = [];
    for (let p = 0; p + chunk <= iq.length; p += chunk) parts.push(Float32Array.from(demod.process(iq.subarray(p, p + chunk))));
    const out = new Float32Array(parts.reduce((s, a) => s + a.length, 0));
    let o = 0; for (const a of parts) { out.set(a, o); o += a.length; }
    return out;
}

test('CW: carrier at the tuned offset comes out at the BFO pitch', () => {
    const d = new DidahDemodulator(RATE, AUDIO);
    d.setModulation('cw'); d.setOffsetFrequency(5000); d.setBfoPitch(700);
    const audio = run(d, iqTone(5000, RATE, RATE * 1.0, 0.1));
    const { freq } = audioPeak(audio, AUDIO);
    assert.ok(Math.abs(freq - 700) < 12, `audio peak ${freq} Hz, expected 700 Hz`);
});

test('USB: tone 1 kHz above the carrier is heard at 1 kHz; the LSB image is rejected by >= 55 dB', () => {
    const d = new DidahDemodulator(RATE, AUDIO);
    d.setModulation('usb'); d.setOffsetFrequency(0);
    const wanted = audioPeak(run(d, iqTone(1000, RATE, RATE, 0.1)), AUDIO);
    assert.ok(Math.abs(wanted.freq - 1000) < 12, `USB audio at ${wanted.freq} Hz`);

    const d2 = new DidahDemodulator(RATE, AUDIO);
    d2.setModulation('usb'); d2.setOffsetFrequency(0);
    d2.agc.maxGain = 1;   // measure the filter, not the AGC's attempt to lift the residual
    const image = audioPeak(run(d2, iqTone(-1000, RATE, RATE, 0.1)), AUDIO);
    const d3 = new DidahDemodulator(RATE, AUDIO);
    d3.setModulation('usb'); d3.setOffsetFrequency(0); d3.agc.maxGain = 1;
    const ref = audioPeak(run(d3, iqTone(1000, RATE, RATE, 0.1)), AUDIO);
    assert.ok(ref.db - image.db >= 55, `image rejection ${(ref.db - image.db).toFixed(1)} dB`);
});

test('LSB: tone 1 kHz below the carrier is heard at 1 kHz', () => {
    const d = new DidahDemodulator(RATE, AUDIO);
    d.setModulation('lsb'); d.setOffsetFrequency(0);
    const { freq } = audioPeak(run(d, iqTone(-1000, RATE, RATE, 0.1)), AUDIO);
    assert.ok(Math.abs(freq - 1000) < 12, `LSB audio at ${freq} Hz`);
});

test('output buffer is reused between calls and is half the complex input length', () => {
    const d = new DidahDemodulator(RATE, AUDIO);
    const iq = iqTone(1000, RATE, 2400, 0.1);
    const a = d.process(iq), b = d.process(iq);
    assert.equal(a.length, 1200);
    assert.equal(a, b);
});
