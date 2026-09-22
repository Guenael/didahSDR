'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./load.js');

const RATE = 48000;

function sine(freq, rate, n, amp = 0.2, phase0 = 0) {
    const out = new Float32Array(n);
    const w = (2 * Math.PI * freq) / rate;
    for (let i = 0; i < n; i++) out[i] = amp * Math.sin(w * i + phase0);
    return out;
}

function rms(a, start = 0, end = a.length) {
    let s = 0;
    for (let i = start; i < end; i++) s += a[i] * a[i];
    return Math.sqrt(s / Math.max(1, end - start));
}

function keyedSine(freq, rate, n, amp, onMs, offMs) {
    const out = new Float32Array(n);
    const w = (2 * Math.PI * freq) / rate;
    const period = ((onMs + offMs) * rate) / 1000;
    const onN = (onMs * rate) / 1000;
    for (let i = 0; i < n; i++) {
        if ((i % period) < onN) out[i] = amp * Math.sin(w * i);
    }
    return out;
}

test('disabled FX stages are identity', () => {
    const src = sine(700, RATE, 2048, 0.3);
    const a = Float32Array.from(src);
    const n = new DidahAutoNotch(RATE);
    n.process(a, a.length);
    assert.deepEqual(Array.from(a), Array.from(src));

    const b = Float32Array.from(src);
    const nr = new DidahNoiseReduction(RATE);
    nr.process(b, b.length);
    assert.deepEqual(Array.from(b), Array.from(src));

    const c = Float32Array.from(src);
    const sq = new DidahSquelch(RATE);
    sq.observe(c, c.length);
    sq.gate(c, c.length);
    assert.deepEqual(Array.from(c), Array.from(src));
});

test('autonotch attenuates a continuous tone', () => {
    const n = new DidahAutoNotch(RATE);
    n.setEnabled(true);
    n.setDepth(100);
    const buf = sine(700, RATE, RATE, 0.2);
    const orig = rms(buf, RATE - 8000, RATE);
    n.process(buf, buf.length);
    const tail = rms(buf, RATE - 8000, RATE);
    assert.ok(tail < orig * 0.25, `tail rms ${tail.toFixed(4)} vs orig ${orig.toFixed(4)}`);
});

test('autonotch suppresses a steady interferer more than a short keyed burst', () => {
    const cont = sine(700, RATE, RATE, 0.2);
    const keyed = keyedSine(700, RATE, RATE, 0.2, 50, 200);
    const n1 = new DidahAutoNotch(RATE);
    n1.setEnabled(true);
    n1.setDepth(100);
    n1.process(cont, cont.length);
    const n2 = new DidahAutoNotch(RATE);
    n2.setEnabled(true);
    n2.setDepth(100);
    n2.process(keyed, keyed.length);

    // RMS of the last 50 ms on-period of the keyed signal vs the continuous tail
    const lastOnStart = RATE - Math.round(0.25 * RATE);
    const lastOnEnd = lastOnStart + Math.round(0.05 * RATE);
    const keyedOn = rms(keyed, lastOnStart, lastOnEnd);
    const contTail = rms(cont, RATE - 8000, RATE);
    assert.ok(keyedOn > contTail * 3, `keyed residual ${keyedOn.toFixed(4)} vs continuous ${contTail.toFixed(4)}`);
});

test('NR reduces white noise more than a tone and reuses the buffer', () => {
    const noise = new Float32Array(RATE);
    for (let i = 0; i < noise.length; i++) noise[i] = 0.15 * (Math.random() * 2 - 1);
    const noiseIn = rms(noise, RATE / 2, RATE);
    const nrN = new DidahNoiseReduction(RATE);
    nrN.setEnabled(true);
    nrN.setStrength(100);
    const same = noise;
    nrN.process(noise, noise.length);
    assert.equal(noise, same);
    const noiseOut = rms(noise, RATE / 2, RATE);
    assert.ok(noiseOut < noiseIn * 0.55, `noise ${noiseIn.toFixed(4)} → ${noiseOut.toFixed(4)}`);

    const tone = sine(700, RATE, RATE, 0.2);
    const toneIn = rms(tone, RATE / 2, RATE);
    const nrT = new DidahNoiseReduction(RATE);
    nrT.setEnabled(true);
    nrT.setStrength(100);
    nrT.process(tone, tone.length);
    const toneOut = rms(tone, RATE / 2, RATE);
    assert.ok(toneOut > toneIn * 0.5, `tone ${toneIn.toFixed(4)} → ${toneOut.toFixed(4)}`);
    assert.ok(noiseOut / noiseIn < toneOut / toneIn, 'noise should be reduced more than the tone');
});

test('squelch stays closed on noise and opens on a tone above the floor', () => {
    const floor = 1e-3;   // AGC-style amplitude floor → -60 dBFS
    const sq = new DidahSquelch(RATE);
    sq.setEnabled(true);
    sq.setMarginDb(10);

    const noise = sine(700, RATE, RATE, floor);
    sq.observe(noise, noise.length, floor);
    sq.gate(noise, noise.length);
    assert.equal(sq.open, false);
    assert.ok(rms(noise, RATE - 4000, RATE) < 1e-6, `noise should stay muted`);

    const loud = sine(700, RATE, RATE, 0.3);
    const sq2 = new DidahSquelch(RATE);
    sq2.setEnabled(true);
    sq2.setMarginDb(10);
    sq2.observe(loud, loud.length, floor);
    sq2.gate(loud, loud.length);
    const orig = 0.3 / Math.sqrt(2);
    const tail = rms(loud, RATE - 8000, RATE);
    assert.ok(sq2.open, 'squelch should open on a tone well above the floor');
    assert.ok(tail > orig * 0.8, `loud tail rms ${tail.toFixed(4)} vs ${orig.toFixed(4)}`);
});

test('through the demodulator, squelch stays shut on band noise and opens on CW', () => {
    const IQ = 96000;
    const keyed = (amp, noiseAmp, seconds) => {
        const n = IQ * seconds, out = new Int16Array(n * 2);
        const w = (2 * Math.PI * 3000) / IQ;
        const period = 0.35 * IQ, onN = 0.1 * IQ;
        for (let i = 0; i < n; i++) {
            const key = (i % period) < onN ? amp : 0;
            out[2 * i] = Math.round(32767 * (key * Math.cos(w * i) + noiseAmp * (Math.random() * 2 - 1)));
            out[2 * i + 1] = Math.round(32767 * (key * Math.sin(w * i) + noiseAmp * (Math.random() * 2 - 1)));
        }
        return out;
    };
    const run = (d, iq) => {
        const chunk = 4800;
        for (let p = 0; p + chunk <= iq.length; p += chunk) d.process(iq.subarray(p, p + chunk));
    };

    const quiet = new DidahDemodulator(IQ, 48000);
    quiet.setModulation('cw');
    quiet.setOffsetFrequency(3000);
    quiet.setSquelchEnabled(true);
    quiet.setSquelchMarginDb(10);
    run(quiet, keyed(0, 3e-4, 2.5));
    assert.equal(quiet.squelch.open, false, 'band noise should stay closed at 10 dB margin');

    const sig = new DidahDemodulator(IQ, 48000);
    sig.setModulation('cw');
    sig.setOffsetFrequency(3000);
    sig.setSquelchEnabled(true);
    sig.setSquelchMarginDb(10);
    run(sig, keyed(1e-2, 1e-4, 2.5));
    assert.ok(sig.squelch.open, 'medium CW should open at 10 dB margin');
});

test('squelch hang keeps the gate open through a 200 ms CW gap', () => {
    const floor = 1e-3;
    const sq = new DidahSquelch(RATE);
    sq.setEnabled(true);
    sq.setHangForMode('cw');
    sq.setMarginDb(10);

    const on = sine(700, RATE, RATE / 2, 0.3);
    sq.observe(on, on.length, floor);
    sq.gate(on, on.length);
    assert.ok(sq.open, 'open after the keyed burst');

    const gap = new Float32Array(Math.round(RATE * 0.2));
    sq.observe(gap, gap.length, floor);
    assert.ok(sq.open, 'still open after 200 ms of silence (CW hang is 400 ms)');

    const longGap = new Float32Array(Math.round(RATE * 0.55));
    sq.observe(longGap, longGap.length, floor);
    assert.equal(sq.open, false, 'closed after a 550 ms gap');
});

test('NR at 12 kHz drops channel-filtered noise by at least 3 dB', () => {
    const rate = 12000;
    const { designLowpass } = require('../../app/js/demodulator.js');
    const h = designLowpass(129, 150, rate, 60);
    const n = rate * 2;
    const raw = new Float32Array(n + h.length);
    let s = 10007;
    for (let i = 0; i < raw.length; i++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        raw[i] = ((s / 4294967296) * 2 - 1) * 0.2;
    }
    const noise = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        let y = 0;
        for (let k = 0; k < h.length; k++) y += h[k] * raw[i + k];
        noise[i] = y;
    }
    const start = n - Math.round(rate * 0.5);
    const before = rms(noise, start, n);
    const nr = new DidahNoiseReduction(rate);
    nr.setEnabled(true);
    nr.setStrength(100);
    nr.process(noise, noise.length);
    const after = rms(noise, start, n);
    const db = 20 * Math.log10(before / Math.max(after, 1e-12));
    assert.ok(db >= 3, `NR ${db.toFixed(1)} dB`);
});

test('autonotch at 12 kHz attenuates a 60 ms dit by less than 1 dB', () => {
    const rate = 12000;
    const dit = Math.round(rate * 0.06);
    const buf = new Float32Array(rate);
    const w = (2 * Math.PI * 700) / rate;
    for (let i = 0; i < dit; i++) buf[i] = 0.2 * Math.sin(w * i);
    const bodyIn = rms(buf, Math.round(dit * 0.4), dit);
    const n = new DidahAutoNotch(rate);
    n.setEnabled(true);
    n.setDepth(100);
    n.process(buf, buf.length);
    const bodyOut = rms(buf, Math.round(dit * 0.4), dit);
    const db = 20 * Math.log10(bodyIn / Math.max(bodyOut, 1e-12));
    assert.ok(db < 1, `dit attenuation ${db.toFixed(2)} dB`);
});
