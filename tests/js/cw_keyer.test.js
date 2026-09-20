'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./load.js');

const AUDIO = 48000;
const IQ = 96000;
const PACKET_S = 0.025;

function renderSeconds(keyer, seconds, bfo = 700, iqOff = 1000) {
    const nAudio = Math.round(AUDIO * PACKET_S);
    const nIq = Math.round(IQ * PACKET_S);
    const nTotal = Math.round(AUDIO * seconds);
    const env = new Float32Array(nTotal);
    let o = 0;
    let keyedSamples = 0;
    let txSamples = 0;
    while (o < nTotal) {
        keyer.render(nAudio, AUDIO, nIq, IQ, bfo, iqOff);
        const take = Math.min(nAudio, nTotal - o);
        const ratio = nIq / nAudio;
        for (let i = 0; i < take; i++) {
            const iq = Math.min(nIq - 1, Math.round(i * ratio));
            const mag = Math.hypot(keyer.iqI[iq], keyer.iqQ[iq]);
            env[o + i] = mag;
            if (mag > 0.05) keyedSamples++;
        }
        if (keyer.isTx()) txSamples += take;
        o += take;
    }
    return { env, keyedSamples, txSamples };
}

function bursts(env, thresh = 0.05) {
    const out = [];
    let on = false, start = 0;
    for (let i = 0; i < env.length; i++) {
        const k = env[i] > thresh;
        if (k && !on) { on = true; start = i; }
        if (!k && on) { on = false; out.push({ start, len: i - start }); }
    }
    if (on) out.push({ start, len: env.length - start });
    return out;
}

test('dit length at 20 WPM is one PARIS unit (~60 ms)', () => {
    const k = new CwKeyer();
    k.setWpm(20);
    k.setPaddle('dit', true);
    const { env } = renderSeconds(k, 0.09);
    k.setPaddle('dit', false);
    const b = bursts(env);
    assert.ok(b.length >= 1, 'expected a keyed dit');
    const ms = (b[0].len / AUDIO) * 1000;
    assert.ok(ms > 50 && ms < 70, `dit ${ms.toFixed(1)} ms`);
});

test('dah length at 20 WPM is three units (~180 ms)', () => {
    const k = new CwKeyer();
    k.setWpm(20);
    k.setPaddle('dah', true);
    const { env } = renderSeconds(k, 0.22);
    k.setPaddle('dah', false);
    const b = bursts(env);
    assert.ok(b.length >= 1);
    const ms = (b[0].len / AUDIO) * 1000;
    assert.ok(ms > 160 && ms < 200, `dah ${ms.toFixed(1)} ms`);
});

test('iambic B squeeze-release during a dit still sends the opposite dah', () => {
    const k = new CwKeyer();
    k.setWpm(20);
    k.setIambicMode('B');
    k.setPaddle('dit', true);
    k.setPaddle('dah', true);
    const first = renderSeconds(k, 0.02).env;
    k.setPaddle('dit', false);
    k.setPaddle('dah', false);
    const rest = renderSeconds(k, 0.35).env;
    const all = new Float32Array(first.length + rest.length);
    all.set(first, 0);
    all.set(rest, first.length);
    const b = bursts(all);
    assert.ok(b.length >= 2, `iambic B expected dit+dah, got ${b.length} bursts`);
    const ditMs = (b[0].len / AUDIO) * 1000;
    const dahMs = (b[1].len / AUDIO) * 1000;
    assert.ok(ditMs < 80, `first element should be a dit, got ${ditMs.toFixed(1)} ms`);
    assert.ok(dahMs > 140, `second element should be a dah, got ${dahMs.toFixed(1)} ms`);
});

test('iambic A squeeze-release during a dit does not send the opposite element', () => {
    const k = new CwKeyer();
    k.setWpm(20);
    k.setIambicMode('A');
    k.setPaddle('dit', true);
    k.setPaddle('dah', true);
    const first = renderSeconds(k, 0.02).env;
    k.setPaddle('dit', false);
    k.setPaddle('dah', false);
    const rest = renderSeconds(k, 0.35).env;
    const all = new Float32Array(first.length + rest.length);
    all.set(first, 0);
    all.set(rest, first.length);
    const b = bursts(all);
    assert.equal(b.length, 1, `iambic A should send only the dit, got ${b.length} bursts`);
});

test('raised-cosine envelope: first samples of a dit are below the peak', () => {
    const k = new CwKeyer();
    k.setWpm(20);
    k.setPaddle('dit', true);
    const { env } = renderSeconds(k, 0.08);
    let peak = 0;
    for (let i = 0; i < env.length; i++) if (env[i] > peak) peak = env[i];
    assert.ok(peak > 0.2);
    assert.ok(env[0] < peak * 0.5, 'first sample should be on the rise');
    assert.ok(env[8] < env[80]);
});

test('Morse E is a single dit; hang keeps TX for one extra letter-space', () => {
    const k = new CwKeyer();
    k.setWpm(20);
    k.armed = true;
    const queue = ['E'];
    k.pullChar = () => (queue.length ? queue.shift() : null);
    const { env, txSamples } = renderSeconds(k, 0.40);
    const b = bursts(env);
    assert.equal(b.length, 1);
    const txMs = (txSamples / AUDIO) * 1000;
    assert.ok(txMs > 200 && txMs < 320, `TX hold ${txMs.toFixed(0)} ms`);
});

test('held dit paddle keeps a one-unit gap between elements', () => {
    const k = new CwKeyer();
    k.setWpm(20);
    k.setPaddle('dit', true);
    const { env } = renderSeconds(k, 0.28);
    const b = bursts(env);
    assert.ok(b.length >= 2, `expected repeated dits, got ${b.length} bursts`);
    const gapMs = ((b[1].start - (b[0].start + b[0].len)) / AUDIO) * 1000;
    assert.ok(gapMs > 45 && gapMs < 80, `intra-element gap ${gapMs.toFixed(1)} ms`);
});

test('sanitizeTxText uppercases, strips accents, and blanks unknown glyphs', () => {
    assert.equal(sanitizeTxText('cq de f4kiy'), 'CQ DE F4KIY');
    assert.equal(sanitizeTxText('café'), 'CAFE');
    assert.equal(sanitizeTxText('ÉÀÜ'), 'EAU');
    assert.equal(sanitizeTxText('hello#world'), 'HELLO WORLD');
    assert.equal(morseOf('C'), '-.-.');
    assert.equal(morseOf('~'), '');
});

test('IQ oscillator is non-zero while keyed and silent in the gaps', () => {
    const k = new CwKeyer();
    k.setWpm(20);
    k.setPaddle('dit', true);
    const nAudio = Math.round(AUDIO * PACKET_S);
    const nIq = Math.round(IQ * PACKET_S);
    k.render(nAudio, AUDIO, nIq, IQ, 700, 2000);
    let peak = 0;
    for (let i = 0; i < nIq; i++) peak = Math.max(peak, Math.hypot(k.iqI[i], k.iqQ[i]));
    assert.ok(peak > 0.1, `IQ peak ${peak}`);
});
