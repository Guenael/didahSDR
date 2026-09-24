#!/usr/bin/env node
'use strict';
/**
 * CPU cost of the client DSP hot paths, as a share of one core in real time.
 * Usage: node scripts/bench.js
 *
 * Numbers are for V8 on this machine; browsers are in the same range. Use it before
 * optimising (or porting to WASM): anything that reads a few percent is not the bottleneck.
 */
require('../tests/js/load.js');
const { DidahDemodulator } = require('../app/js/demodulator.js');
const DidahFFT = require('../app/js/fft.js');
const { RtlDecimator, RTL_CAPTURE_RATE } = require('../app/js/rtlsdr.js');

function bench(name, fn) {
    for (let w = 0; w < 3; w++) fn();
    const reps = 10;
    const t0 = process.hrtime.bigint();
    for (let r = 0; r < reps; r++) fn();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / reps;
    console.log(`${name.padEnd(50)} ${ms.toFixed(2).padStart(7)} ms per 1 s of signal  ${(ms / 10).toFixed(2).padStart(6)} % of a core`);
}

for (const rate of [96000, 192000]) {
    const d = new DidahDemodulator(rate);
    d.configure({ offsetFreq: 2800 });
    const n = rate / 40; // one 25 ms packet
    const iq = new Float32Array(2 * n).map(() => Math.random() - 0.5);
    bench(`demodulator ${rate / 1000} kHz (CW, AGC)`, () => { for (let p = 0; p < 40; p++) d.process(iq, n); });
}

// The waterfall hop is fftSize / speed, capped near 200 columns/s (app.js spectrumHopSize()).
for (const size of [1024, 2048, 4096]) {
    const fft = new DidahFFT(size);
    const re = new Float32Array(size).map(() => Math.random());
    const im = new Float32Array(size);
    const cols = Math.min(200, Math.round(96000 / Math.max(size / 3, 480)));
    bench(`FFT ${size} + window + dB, ${cols} col/s (96 kHz, 3x)`, () => {
        for (let c = 0; c < cols; c++) fft.computeSpectrumDb(re, im, true);
    });
}

const dec = new RtlDecimator();
const src = new Uint8Array(65536).map(() => (Math.random() * 256) | 0);
const dst = new Int16Array(65536 / 8 + 4);
const bulks = Math.round((RTL_CAPTURE_RATE * 2) / 65536);
bench('RTL-SDR CIC + compensator, 1.536 Msps', () => { for (let b = 0; b < bulks; b++) dec.process(src, 65536, dst); });
