'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSampleWav, iqTone, peakAbs } = require('./load.js');

const RATE = 96000;

/** Keyed CW: `on` ms tone then `off` ms silence, repeated, plus white noise at `noiseAmp`. */
function keyedTone(offset, amp, onMs, offMs, seconds, noiseAmp) {
    const n = RATE * seconds, out = new Int16Array(n * 2);
    const w = (2 * Math.PI * offset) / RATE, period = ((onMs + offMs) * RATE) / 1000, onN = (onMs * RATE) / 1000;
    for (let i = 0; i < n; i++) {
        const key = (i % period) < onN ? amp : 0;
        out[2 * i] = Math.round(32767 * (key * Math.cos(w * i) + noiseAmp * (Math.random() * 2 - 1)));
        out[2 * i + 1] = Math.round(32767 * (key * Math.sin(w * i) + noiseAmp * (Math.random() * 2 - 1)));
    }
    return out;
}

function runCollect(iq, chunk = 4800, everyChunk) {
    const d = new DidahDemodulator(RATE, 48000);
    d.setModulation('cw'); d.setOffsetFrequency(3000);
    const blocks = [];
    for (let p = 0; p + chunk <= iq.length; p += chunk) {
        const out = d.process(iq.subarray(p, p + chunk));
        blocks.push(peakAbs(out));
        if (everyChunk) everyChunk(d, p / (RATE * 2));
    }
    return { d, blockPeaks: blocks };
}

test('a -60 dBFS keyed tone reaches >= 0.7 output peak within 600 ms', () => {
    // 100 ms elements with 250 ms gaps: the floor estimator needs one noise-only 100 ms block
    const iq = keyedTone(3000, 1e-3, 100, 250, 1.5, 1e-5);
    const { blockPeaks } = runCollect(iq);
    // 4800 int16 = 2400 complex = 25 ms per block; 600 ms = block 24
    const reached = blockPeaks.slice(0, 24).some((p) => p >= 0.7);
    assert.ok(reached, `first 600 ms peaks: ${blockPeaks.slice(0, 24).map((v) => v.toFixed(2)).join(' ')}`);
});

test('noise-only input stays at a modest output level (no pumping to full scale)', () => {
    const iq = keyedTone(3000, 0, 100, 50, 1.5, 3e-4);
    const { blockPeaks } = runCollect(iq);
    const steady = blockPeaks.slice(20);
    assert.ok(Math.max(...steady) <= 0.35, `noise peaks up to ${Math.max(...steady).toFixed(2)}`);
});

test('noise floor estimate holds still during a keyed transmission (no slow swell/fade)', () => {
    const iq = keyedTone(3000, 3e-3, 80, 60, 5.0, 2e-4);
    const floors = [];
    runCollect(iq, 4800, (d, t) => { if (t >= 2.5) floors.push(d.agc.noiseFloor); });
    const ratio = Math.max(...floors) / Math.min(...floors);
    assert.ok(ratio < 2.0, `floor wandered by ${ratio.toFixed(2)}x after settling`);
});

test('sample WAV: the strongest CW signal is levelled near the AGC target', { skip: !loadSampleWav(0) && 'sample WAV not present' }, () => {
    const wav = loadSampleWav(8);
    // Find the strongest bin over the first seconds with the project FFT (averaged power)
    const N = 4096, fft = new DidahFFT(N), acc = new Float64Array(N);
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let blk = 0; blk < 64; blk++) {
        const base = blk * N * 2;
        for (let n = 0; n < N; n++) { re[n] = wav.data[base + 2 * n] / 32768; im[n] = wav.data[base + 2 * n + 1] / 32768; }
        const spec = fft.computeSpectrumDb(re, im);
        for (let i = 0; i < N; i++) acc[i] += spec[i];
    }
    let pi = 0; for (let i = 1; i < N; i++) if (acc[i] > acc[pi]) pi = i;
    const offset = ((pi - N / 2) * wav.rate) / N;

    const d = new DidahDemodulator(wav.rate, 48000);
    d.setModulation('cw'); d.setOffsetFrequency(offset);
    let pk = 0;
    const chunk = 4800;
    for (let p = 0; p + chunk <= wav.data.length; p += chunk) {
        const out = d.process(wav.data.subarray(p, p + chunk));
        if (p > wav.rate * 2 * 2) pk = Math.max(pk, peakAbs(out));   // skip the first 2 s (floor settling)
    }
    assert.ok(pk >= 0.85 && pk <= 0.96, `strongest signal at ${offset.toFixed(0)} Hz: peak ${pk.toFixed(2)}, target 0.95`);
});
