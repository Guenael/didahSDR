'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSampleWav, floatIq, peakAbs, gaussSource } = require('./load.js');

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
    const f = floatIq(iq);
    const d = new DidahDemodulator(RATE);
    d.setModulation('cw'); d.setOffsetFrequency(3000);
    const blocks = [];
    for (let p = 0; p + chunk <= f.length; p += chunk) {
        const out = d.process(f.subarray(p, p + chunk));
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

/** Complex white noise (std `sig` per component) plus an optional carrier at the tuned offset; returns the demod. */
function runNoise({ mod = 'cw', bw = 150, sig = 1e-2, packets = 240, carrier = null, each = null }) {
    const g = gaussSource(1);
    const d = new DidahDemodulator(RATE);
    d.setModulation(mod);
    if (mod === 'cw') d.setCwBandwidth(bw);
    d.setOffsetFrequency(3000);
    const n = 2400, iq = new Float32Array(2 * n), w = (2 * Math.PI * 3000) / RATE;
    for (let p = 0; p < packets; p++) {
        const a = carrier ? carrier(p) : 0;
        for (let i = 0; i < n; i++) {
            const k = p * n + i;
            iq[2 * i] = a * Math.cos(w * k) + sig * g();
            iq[2 * i + 1] = a * Math.sin(w * k) + sig * g();
        }
        const out = d.process(iq, n);
        if (each) each(d, p, out);
    }
    return d;
}

test('noise estimator reads the audio noise power of the channel within 0.5 dB', () => {
    for (const [mod, bw] of [['cw', 150], ['cw', 500], ['usb', 0]]) {
        let sum = 0, cnt = 0, truth = 0;
        runNoise({ mod, bw, packets: 120, each: (d, p) => {
            // σ = 1e-2 per component at 96 kHz → complex variance 2σ² / decim at the channel rate
            truth = ((2 * 1e-4) / d.decim) * d.noiseEst.sumH2 * 0.5;
            if (p >= 40) { sum += d.noiseEst.noisePower; cnt++; }
        } });
        const errDb = 10 * Math.log10(sum / cnt / truth);
        assert.ok(Math.abs(errDb) < 0.5, `${mod} ${bw}: estimate ${errDb.toFixed(2)} dB off`);
    }
});

test('noise estimate moves < 1 dB while a strong carrier sits in the passband', () => {
    const before = [], during = [];
    // 60 dB above the noise in the channel, on from 2 s to 7 s
    runNoise({ packets: 280, carrier: (p) => (p >= 80 && p < 280 ? 0.3 : 0), each: (d, p) => {
        const db = 10 * Math.log10(d.noiseEst.noisePower);
        if (p >= 20 && p < 80) before.push(db);
        else if (p >= 80) during.push(db);
    } });
    const ref = before.reduce((a, b) => a + b) / before.length;
    const dev = Math.max(...during.map((v) => Math.abs(v - ref)));
    assert.ok(dev < 1.0, `estimate moved ${dev.toFixed(2)} dB under the carrier`);
});

test('AGC: pure-noise output level matches the old in-band floor estimator (CW 150 Hz)', () => {
    // 0.1393 rms: the pre-ChannelNoiseEstimator AGC on this exact input (seed 1, σ = 1e-2, 2-6 s)
    let s = 0, c = 0;
    runNoise({ each: (d, p, out) => { if (p >= 80) { for (let i = 0; i < out.length; i++) s += out[i] * out[i]; c += out.length; } } });
    const db = 20 * Math.log10(Math.sqrt(s / c) / 0.1393);
    assert.ok(Math.abs(db) < 1.0, `noise output ${db.toFixed(2)} dB from the old level`);
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

    const d = new DidahDemodulator(wav.rate);
    d.setModulation('cw'); d.setOffsetFrequency(offset);
    let pk = 0;
    const chunk = 4800;
    const wavF = floatIq(wav.data);
    for (let p = 0; p + chunk <= wavF.length; p += chunk) {
        const out = d.process(wavF.subarray(p, p + chunk));
        if (p > wav.rate * 2 * 2) pk = Math.max(pk, peakAbs(out));   // skip the first 2 s (floor settling)
    }
    assert.ok(pk >= 0.85 && pk <= 0.96, `strongest signal at ${offset.toFixed(0)} Hz: peak ${pk.toFixed(2)}, target 0.95`);
});
