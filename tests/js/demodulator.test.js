'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { iqTone, floatIq, audioPeak } = require('./load.js');

const RATE = 96000, AUDIO = 12000;

function run(demod, iq, chunk = 4800) {
    const f = floatIq(iq);
    const parts = [];
    for (let p = 0; p + chunk <= f.length; p += chunk) parts.push(Float32Array.from(demod.process(f.subarray(p, p + chunk))));
    const out = new Float32Array(parts.reduce((s, a) => s + a.length, 0));
    let o = 0; for (const a of parts) { out.set(a, o); o += a.length; }
    return out;
}

test('CW: carrier at the tuned offset comes out at the BFO pitch', () => {
    const d = new DidahDemodulator(RATE);
    d.setModulation('cw'); d.setOffsetFrequency(5000); d.setBfoPitch(700);
    const audio = run(d, iqTone(5000, RATE, RATE * 1.0, 0.1));
    const { freq } = audioPeak(audio, AUDIO);
    assert.ok(Math.abs(freq - 700) < 12, `audio peak ${freq} Hz, expected 700 Hz`);
});

test('USB: tone 1 kHz above the carrier is heard at 1 kHz; the LSB image is rejected by >= 55 dB', () => {
    const d = new DidahDemodulator(RATE);
    d.setModulation('usb'); d.setOffsetFrequency(0);
    const wanted = audioPeak(run(d, iqTone(1000, RATE, RATE, 0.1)), AUDIO);
    assert.ok(Math.abs(wanted.freq - 1000) < 12, `USB audio at ${wanted.freq} Hz`);

    const d2 = new DidahDemodulator(RATE);
    d2.setModulation('usb'); d2.setOffsetFrequency(0);
    d2.agc.maxGain = 1;   // measure the filter, not the AGC's attempt to lift the residual
    const image = audioPeak(run(d2, iqTone(-1000, RATE, RATE, 0.1)), AUDIO);
    const d3 = new DidahDemodulator(RATE);
    d3.setModulation('usb'); d3.setOffsetFrequency(0); d3.agc.maxGain = 1;
    const ref = audioPeak(run(d3, iqTone(1000, RATE, RATE, 0.1)), AUDIO);
    assert.ok(ref.db - image.db >= 55, `image rejection ${(ref.db - image.db).toFixed(1)} dB`);
});

test('LSB: tone 1 kHz below the carrier is heard at 1 kHz', () => {
    const d = new DidahDemodulator(RATE);
    d.setModulation('lsb'); d.setOffsetFrequency(0);
    const { freq } = audioPeak(run(d, iqTone(-1000, RATE, RATE, 0.1)), AUDIO);
    assert.ok(Math.abs(freq - 1000) < 12, `LSB audio at ${freq} Hz`);
});

test('output buffer is reused and is the complex input length divided by 8', () => {
    const d = new DidahDemodulator(RATE);
    assert.equal(d.channel.N, 129);
    const iq = floatIq(iqTone(1000, RATE, 2400, 0.1));
    const a = d.process(iq), b = d.process(iq);
    assert.equal(a.length, 300);
    assert.equal(b.length, 300);
    assert.equal(a.buffer, b.buffer);
});

test('setIqRate(12000) skips the halfband and still puts a CW tone at the BFO pitch', () => {
    const d = new DidahDemodulator(RATE);
    d.setIqRate(12000);
    assert.equal(d.decimate2, false);
    assert.equal(d.audioRate, 12000);
    d.setModulation('cw'); d.setOffsetFrequency(0); d.setBfoPitch(700);
    const audio = run(d, iqTone(0, 12000, 12000, 0.1), 2400);
    assert.equal(audio.length, 12000);
    const { freq } = audioPeak(audio, 12000);
    assert.ok(Math.abs(freq - 700) < 12, `12 kHz audio peak ${freq} Hz, expected 700 Hz`);

    d.setIqRate(96000);
    assert.equal(d.decimate2, true);
    assert.equal(d.decim, 8);
    assert.equal(d.audioRate, 12000);
    const iq = floatIq(iqTone(1000, RATE, 2400, 0.1));
    assert.equal(d.process(iq).length, 300);
});

test('setIqRate(48000) decimates 4:1 to 12 kHz and keeps the BFO pitch', () => {
    const d = new DidahDemodulator(RATE);
    d.setIqRate(48000);
    assert.equal(d.decim, 4);
    assert.equal(d.audioRate, 12000);
    d.setModulation('cw'); d.setOffsetFrequency(0); d.setBfoPitch(700);
    const audio = run(d, iqTone(0, 48000, 48000, 0.1), 2400);
    assert.equal(audio.length, 12000);
    const { freq } = audioPeak(audio, 12000);
    assert.ok(Math.abs(freq - 700) < 12, `48 kHz audio peak ${freq} Hz, expected 700 Hz`);
});

test('setIqRate(192000) decimates 16:1 to 12 kHz and keeps the BFO pitch', () => {
    const d = new DidahDemodulator(RATE);
    d.setIqRate(192000);
    assert.equal(d.decim, 16);
    assert.equal(d.audioRate, 12000);
    d.setModulation('cw'); d.setOffsetFrequency(0); d.setBfoPitch(700);
    const audio = run(d, iqTone(0, 192000, 192000, 0.1), 4800);
    assert.equal(audio.length, 12000);
    const { freq } = audioPeak(audio, 12000);
    assert.ok(Math.abs(freq - 700) < 12, `192 kHz audio peak ${freq} Hz, expected 700 Hz`);
});

test('a large retune resets the AGC; a wheel tick does not', () => {
    const d = new DidahDemodulator(RATE);
    d.agc.noiseFloor = 0.2;
    d.agc.gNext = 4;
    d.autoNotch._lms.runP = 3;
    d.setOffsetFrequency(50);
    assert.equal(d.agc.noiseFloor, 0.2);
    assert.equal(d.autoNotch._lms.runP, 3);
    d.setOffsetFrequency(50 + 200);
    assert.equal(d.agc.noiseFloor, 1e-3);
    assert.equal(d.agc.gNext, 1);
    assert.equal(d.autoNotch._lms.runP, 0);
});

test('CW leaves a steady tone alone when the autonotch is enabled', () => {
    const d = new DidahDemodulator(RATE);
    d.setModulation('cw');
    d.setOffsetFrequency(0);
    d.setBfoPitch(700);
    d.setAutonotchEnabled(true);
    d.setAutonotchDepth(100);
    d.agc.maxGain = 1;
    const audio = run(d, iqTone(0, RATE, RATE, 0.2));
    const tail = audio.subarray(audio.length - 2000);
    let s = 0;
    for (let i = 0; i < tail.length; i++) s += tail[i] * tail[i];
    const rms = Math.sqrt(s / tail.length);
    assert.ok(rms > 0.05, `CW tail rms ${rms.toFixed(4)} should survive the autonotch`);
});
