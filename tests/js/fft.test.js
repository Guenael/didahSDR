'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./load.js');

test('full-scale complex tone peaks in the expected fftshifted bin at 0 dBFS', () => {
    const N = 2048, rate = 96000, f = 9375; // exactly bin 200, so the check is coherent gain
    const fft = new DidahFFT(N);
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let n = 0; n < N; n++) { const ph = (2 * Math.PI * f * n) / rate; re[n] = Math.cos(ph); im[n] = Math.sin(ph); }
    const out = fft.computeSpectrumDb(re, im);
    let pk = -Infinity, pi = 0;
    for (let i = 0; i < N; i++) if (out[i] > pk) { pk = out[i]; pi = i; }
    assert.equal(pi, N / 2 + Math.round((f / rate) * N));
    assert.ok(Math.abs(pk) < 0.5, `peak ${pk} dB should be within 0.5 dB of 0 dBFS`);
});

test('negative frequency lands below DC after fftshift; output is reused buffer of size N', () => {
    const N = 1024, rate = 96000, f = -12000;
    const fft = new DidahFFT(N);
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let n = 0; n < N; n++) { const ph = (2 * Math.PI * f * n) / rate; re[n] = Math.cos(ph); im[n] = Math.sin(ph); }
    const out = fft.computeSpectrumDb(re, im);
    let pi = 0; for (let i = 1; i < N; i++) if (out[i] > out[pi]) pi = i;
    assert.equal(pi, N / 2 + Math.round((f / rate) * N));
    assert.equal(out.length, N);
    assert.equal(fft.computeSpectrumDb(re, im), out, 'power buffer must be reused, not reallocated');
});

test('setSize reallocates tables and window sum', () => {
    const fft = new DidahFFT(1024);
    fft.setSize(4096);
    assert.equal(fft.window.length, 4096);
    assert.ok(fft.windowSum > 0);
});

test('default window is 4-term Blackman-Harris with ENBW near 2 bins', () => {
    const fft = new DidahFFT(2048);
    assert.equal(fft.windowName, 'bh4');
    assert.ok(fft.enbw > 1.8 && fft.enbw < 2.2, `ENBW ${fft.enbw}`);
});

test('blackman window is coherent-gain normalised; mag2Buffer matches dB', () => {
    const N = 2048, rate = 96000, f = 9375; // exactly bin 200, so the check is coherent gain
    const fft = new DidahFFT(N);
    fft.initWindow('blackman');
    assert.equal(fft.windowName, 'blackman');
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let n = 0; n < N; n++) { const ph = (2 * Math.PI * f * n) / rate; re[n] = Math.cos(ph); im[n] = Math.sin(ph); }
    const out = fft.computeSpectrumDb(re, im);
    let pk = -Infinity, pi = 0;
    for (let i = 0; i < N; i++) if (out[i] > pk) { pk = out[i]; pi = i; }
    assert.ok(Math.abs(pk) < 0.5, `blackman peak ${pk} dB`);
    assert.ok(Math.abs(10 * Math.log10(fft.mag2Buffer[pi]) - pk) < 1e-6);
});

test('every FFT window has the textbook ENBW and reads a bin-centred full-scale tone at 0 dBFS', () => {
    const enbw = { rect: 1.0, hann: 1.5, hamming: 1.363, blackman: 1.727, bh4: 2.004, flattop: 3.77 };
    const n = 2048;
    const re = new Float32Array(n), im = new Float32Array(n);
    const k = 200;   // bin-centred complex tone
    for (let i = 0; i < n; i++) {
        re[i] = Math.cos((2 * Math.PI * k * i) / n);
        im[i] = Math.sin((2 * Math.PI * k * i) / n);
    }
    for (const name of DidahFFT.WINDOWS) {
        const fft = new DidahFFT(n);
        fft.initWindow(name);
        assert.equal(fft.windowName, name);
        assert.ok(Math.abs(fft.enbw - enbw[name]) < 0.02, `${name} ENBW ${fft.enbw}`);
        const spec = fft.computeSpectrumDb(re, im);
        let pk = -Infinity;
        for (let i = 0; i < n; i++) if (spec[i] > pk) pk = spec[i];
        assert.ok(Math.abs(pk) < 0.05, `${name} peak ${pk} dB`);
    }
    const fallback = new DidahFFT(256);
    fallback.initWindow('nope');
    assert.equal(fallback.windowName, 'bh4');
});
