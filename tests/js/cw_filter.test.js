'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./load.js');

function noiseSpectrum(N, levelDb, spread = 3) {
    const s = new Float32Array(N);
    for (let i = 0; i < N; i++) s[i] = levelDb + (Math.random() * 2 - 1) * spread;
    return s;
}

test('disabled filter passes the input through untouched', () => {
    const f = new CWAdaptiveFilter(1024);
    f.enabled = false;
    const inp = noiseSpectrum(1024, -100);
    assert.equal(f.process(inp), inp);
});

test('output has the input length and is a reused buffer', () => {
    const f = new CWAdaptiveFilter(2048);
    const a = f.process(noiseSpectrum(2048, -100));
    const b = f.process(noiseSpectrum(2048, -100));
    assert.equal(a.length, 2048);
    assert.equal(a, b);
});

test('noise floor estimate converges within 1 dB of the lowest-eighth mean of a flat noise spectrum', () => {
    const f = new CWAdaptiveFilter(2048);
    let inp;
    for (let k = 0; k < 20; k++) { inp = noiseSpectrum(2048, -100, 3); f.process(inp); }
    const sorted = Float32Array.from(inp).sort();
    let sum = 0; for (let i = 0; i < 256; i++) sum += sorted[i];
    const expected = sum / 256;
    assert.ok(Math.abs(f.prevAvgNf - expected) < 1.0, `floor ${f.prevAvgNf.toFixed(2)} vs lowest-eighth mean ${expected.toFixed(2)}`);
});

test('a strong carrier stays well above the noise after filtering, with every kernel', () => {
    for (const k of ['off', 'light', 'medium', 'strong']) {
        const f = new CWAdaptiveFilter(2048);
        f.setKernel(k);
        let out;
        for (let i = 0; i < 30; i++) { const s = noiseSpectrum(2048, -100, 2); s[1000] = -60; out = f.process(s); }
        const noiseNeighbour = out[500];
        assert.ok(out[1000] - noiseNeighbour > 25, `kernel ${k}: carrier ${out[1000].toFixed(1)} vs noise ${noiseNeighbour.toFixed(1)}`);
    }
});

test('resize resets state and adapts to a new FFT size on the fly', () => {
    const f = new CWAdaptiveFilter(1024);
    const out = f.process(noiseSpectrum(4096, -100));
    assert.equal(out.length, 4096);
    assert.equal(f.nfft, 4096);
});
