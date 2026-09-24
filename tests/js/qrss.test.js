'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./load.js');
const { QrssSpectrum } = require('../../app/js/qrss.js');

test('a short hop paints a column well before one full FFT', () => {
    const q = new QrssSpectrum();
    q.setFftSize(4096);
    q.setInputRate(12000);
    q.setHop(Math.round(q.outRate / 3));
    const rate = 12000;
    let cols = 0;
    let peak = -300;
    const n = rate; // 1 s at the channel rate, about 0.33 of a 4096-point window
    for (let i = 0; i < n; i++) {
        const t = i / rate;
        const col = q.push(0.2 * Math.cos(2 * Math.PI * 0.25 * t), 0.2 * Math.sin(2 * Math.PI * 0.25 * t));
        if (!col) continue;
        cols++;
        for (let k = 0; k < col.length; k++) if (col[k] > peak) peak = col[k];
    }
    assert.ok(cols >= 2, `expected several columns, got ${cols}`);
    assert.ok(peak > -80, `carrier should clear the waterfall floor, peak ${peak.toFixed(1)} dB`);
});

test('two tones 0.5 Hz apart are resolved at 4096 points', () => {
    const q = new QrssSpectrum();
    q.setFftSize(4096);
    q.setInputRate(12000);
    assert.ok(Math.abs(q.outRate - 375) < 1, `decimated rate ${q.outRate}`);
    const rate = 12000;
    const n = rate * 14;
    let spec = null;
    for (let i = 0; i < n; i++) {
        const t = i / rate;
        const a = 2 * Math.PI * 0.25 * t;
        const b = 2 * Math.PI * -0.25 * t;
        const col = q.push(0.4 * (Math.cos(a) + Math.cos(b)), 0.4 * (Math.sin(a) + Math.sin(b)));
        if (col) spec = col;
    }
    assert.ok(spec, 'expected a QRSS column');
    let peakA = 0;
    for (let i = 1; i < spec.length; i++) if (spec[i] > spec[peakA]) peakA = i;
    let peakB = 0;
    for (let i = 1; i < spec.length; i++) {
        if (Math.abs(i - peakA) < 3) continue;
        if (spec[i] > spec[peakB]) peakB = i;
    }
    const binHz = q.outRate / 4096;
    const sep = Math.abs(peakA - peakB) * binHz;
    assert.ok(Math.abs(sep - 0.5) < binHz * 1.6, `separation ${sep.toFixed(3)} Hz (bin ${binHz.toFixed(4)})`);
    const lo = Math.min(peakA, peakB);
    const hi = Math.max(peakA, peakB);
    let valley = Infinity;
    for (let i = lo + 1; i < hi; i++) if (spec[i] < valley) valley = spec[i];
    assert.ok(spec[peakA] - valley > 6, `valley under first peak ${spec[peakA] - valley} dB`);
    assert.ok(spec[peakB] - valley > 6, `valley under second peak ${spec[peakB] - valley} dB`);
});

test('columns are independent: a keyed carrier leaves no trace one window after it stops', () => {
    const q = new QrssSpectrum();
    q.setInputRate(12000);
    q.setFftSize(1024);                        // 2.7 s window at 375 Hz, hop 256 (0.68 s)
    assert.equal(q.hop, 256);
    const rate = 12000;
    const onFor = 20 * rate, total = 40 * rate;
    const cols = [];
    let seed = 11;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
    for (let i = 0; i < total; i++) {
        const t = i / rate;
        const a = i < onFor ? 0.05 : 0;
        const col = q.push(a * Math.cos(2 * Math.PI * 0.5 * t) + 1e-3 * rnd(), a * Math.sin(2 * Math.PI * 0.5 * t) + 1e-3 * rnd());
        if (col) cols.push({ t, peak: Math.max(...col), med: Float32Array.from(col).sort()[col.length >> 1] });
    }
    const on = cols.filter((c) => c.t > 5 && c.t < 19);
    const off = cols.filter((c) => c.t > 20 + 2.8);      // one window after key-up
    assert.ok(on.every((c) => c.peak - c.med > 40), 'the carrier stands out while keyed');
    assert.ok(off.every((c) => c.peak - c.med < 22), `no smear after key-up (noise-only peak/median is ~15-20 dB): ${Math.max(...off.map((c) => c.peak - c.med)).toFixed(1)} dB`);
    assert.ok(Math.abs(cols.filter((c) => c.t > 10).length / 30 - 375 / 256) < 0.1, 'one column per hop');
});

test('the QRSS view is about 200 Hz wide', () => {
    const q = new QrssSpectrum();
    q.setInputRate(12000);
    assert.ok(Math.abs(q.outRate / q.viewZoom() - 200) < 1);
});
