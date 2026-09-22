'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./load.js');

function gauss() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const MEDIAN_BIAS_DB = 10 * Math.log10(1 / Math.LN2);

function dbToMag2(spec) {
    const m = new Float32Array(spec.length);
    for (let i = 0; i < spec.length; i++) m[i] = Math.pow(10, spec[i] / 10);
    return m;
}

function noiseSpectrum(fft, amp = 0.02) {
    const n = fft.size;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        re[i] = gauss() * amp;
        im[i] = gauss() * amp;
    }
    fft.computeSpectrumDb(re, im);
    return fft.mag2Buffer;
}

test('flat spectrum (white-in-frequency) reads 0 dB SNR in USB and CW', () => {
    const meter = new DidahSMeter();
    const spec = dbToMag2(new Float32Array(2048).fill(-80));
    const usb = meter.computeSnrDb(spec, 96000, 0, 0, 'usb');
    const cw = meter.computeSnrDb(spec, 96000, 0, 0, 'cw', 150);
    assert.ok(Math.abs(usb + MEDIAN_BIAS_DB) < 0.05, `USB SNR ${usb}`);
    assert.ok(Math.abs(cw + MEDIAN_BIAS_DB) < 0.05, `CW SNR ${cw}`);
});

test('passband raised uniformly by 20 dB reads +20 dB, not a peak-bin value', () => {
    const meter = new DidahSMeter();
    const n = 2048, rate = 96000;
    const db = new Float32Array(n);
    db.fill(-80);
    const binWidth = rate / n;
    const k0 = n / 2;
    const kStart = k0 + Math.round(MODES.usb.low / binWidth);
    const kEnd = k0 + Math.round(MODES.usb.high / binWidth);
    for (let k = kStart; k <= kEnd; k++) db[k] = -60;
    const snr = meter.computeSnrDb(dbToMag2(db), rate, 0, 0, 'usb');
    assert.ok(Math.abs(snr - (20 - MEDIAN_BIAS_DB)) < 0.05, `USB SNR ${snr} dB, expected ${20 - MEDIAN_BIAS_DB}`);
});

test('Gaussian IQ noise averages near 0 dB (no phantom 7–10 dB floor)', () => {
    const meter = new DidahSMeter();
    const cases = [
        { rate: 96000, fft: 2048 },
        { rate: 12000, fft: 2048 },
    ];
    for (const { rate, fft: nfft } of cases) {
        const fft = new DidahFFT(nfft);
        let sum = 0;
        const n = 80;
        for (let t = 0; t < n; t++) {
            const spec = noiseSpectrum(fft);
            const snr = meter.computeSnrDb(spec, rate, 0, 3000, 'usb');
            assert.ok(Number.isFinite(snr), 'SNR must be finite');
            sum += snr;
        }
        const mean = sum / n;
        assert.ok(Math.abs(mean) < 0.6, `${rate} Hz USB mean SNR on noise ${mean.toFixed(2)} dB, expected ~0`);
    }
});

test('a tone in the USB passband raises SNR; the same tone in LSB does not', () => {
    const meter = new DidahSMeter();
    const n = 2048, rate = 96000, f = 1000, amp = 0.25;
    const fft = new DidahFFT(n);
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const ph = (2 * Math.PI * f * i) / rate;
        re[i] = amp * Math.cos(ph) + gauss() * 0.02;
        im[i] = amp * Math.sin(ph) + gauss() * 0.02;
    }
    fft.computeSpectrumDb(re, im);
    const mag2 = fft.mag2Buffer;
    const usb = meter.computeSnrDb(mag2, rate, 0, 0, 'usb', 0, fft.enbw);
    const lsb = meter.computeSnrDb(mag2, rate, 0, 0, 'lsb', 0, fft.enbw);
    assert.ok(usb > 8, `USB SNR ${usb.toFixed(2)} dB should show the tone`);
    assert.ok(lsb < 3, `LSB SNR ${lsb.toFixed(2)} dB should stay near the noise`);
});

test('a neighbour inside the guard does not pull the CW noise estimate down', () => {
    const meter = new DidahSMeter();
    const n = 2048, rate = 96000;
    const mag = new Float32Array(n);
    const floor = Math.pow(10, -80 / 10);
    mag.fill(floor);
    const binWidth = rate / n;
    const k0 = n / 2;
    const halfBins = Math.max(1, Math.round((150 * 0.5) / binWidth));
    const guard = Math.ceil(2) + 2;
    const leak = k0 - halfBins - 1;
    assert.ok(leak >= k0 - halfBins - guard, 'tone must sit inside the guard');
    mag[leak] = Math.pow(10, -20 / 10);
    const snr = meter.computeSnrDb(mag, rate, 0, 0, 'cw', 150, 2);
    assert.ok(snr > -3, `guarded SNR ${snr.toFixed(2)} dB was pulled by the neighbour`);
});
