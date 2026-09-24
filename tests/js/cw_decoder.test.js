'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./load.js');
const { cwTokenClass, cwHighlightHtml, cwConsumeText, CWDecoder } = require('../../app/js/cw_decoder.js');

test('token classes: exchanges before keywords before callsigns', () => {
    assert.equal(cwTokenClass('5NN'), 'cwd-exch');
    assert.equal(cwTokenClass('TU'), 'cwd-exch');
    assert.equal(cwTokenClass('CQ'), 'cwd-kw');
    assert.equal(cwTokenClass('='), 'cwd-kw');
    assert.equal(cwTokenClass('W1AW'), 'cwd-call');
    assert.equal(cwTokenClass('VE3ABC/P'), 'cwd-call');
    assert.equal(cwTokenClass('HELLO'), 'cwd-plain');
    assert.equal(cwTokenClass('R'), 'cwd-plain'); // single letters are not keywords
    assert.equal(cwTokenClass('599'), 'cwd-exch'); // not a callsign
});

test('highlight keeps the trailing partial word pending and escapes HTML', () => {
    const html = cwHighlightHtml('CQ DE W1A');
    assert.match(html, /<span class="cwd-kw">CQ<\/span> <span class="cwd-kw">DE<\/span> <span class="cwd-pending">W1A<\/span>/);
    assert.equal(cwHighlightHtml('<X>'), '<span class="cwd-pending">&lt;X&gt;</span>');
});

test('usable rates snap to multiples of 800 within 1 %', () => {
    assert.equal(CWDecoder.usableRate(48000), 48000);
    assert.equal(CWDecoder.usableRate(12001.2), 12000);
    assert.equal(CWDecoder.usableRate(44100), 44000); // 0.2 % error is harmless
    assert.equal(CWDecoder.usableRate(11025), 0);
    assert.equal(CWDecoder.usableRate(1000), 0);
    assert.deepEqual(CWDecoder.ratePlan(12000), { rate: 12000, resample: false });
    assert.deepEqual(CWDecoder.ratePlan(11025), { rate: 12000, resample: true });
    assert.deepEqual(CWDecoder.ratePlan(1000), { rate: 0, resample: false });
});

test('leaving CW shows STANDBY and returning restores the worker state', () => {
    const status = { textContent: '', className: '', title: '' };
    const demod = { tapCallback: null };
    const dec = new CWDecoder(demod, { output: null, status });
    dec.worker = { postMessage() {} };
    dec._onMessage({ type: 'status', state: 'ready', detail: '1 thread(s)' });
    assert.equal(status.textContent, 'STANDBY');
    dec.start(12000);
    assert.equal(status.textContent, 'DECODING');
    assert.equal(status.title, '1 thread(s)');
    dec.stop();
    assert.equal(status.textContent, 'STANDBY');
    dec.start(12000);
    assert.equal(status.textContent, 'DECODING');
});

test('consume text completes words and keeps the tail pending', () => {
    assert.deepEqual(cwConsumeText('', 'CQ DE '), { words: ['CQ', 'DE'], pending: '' });
    assert.deepEqual(cwConsumeText('W1', 'AW '), { words: ['W1AW'], pending: '' });
    assert.deepEqual(cwConsumeText('', 'CQ'), { words: [], pending: 'CQ' });
});

test('tap copies samples without a view and drops the oldest held chunk', () => {
    const posted = [];
    const demod = { tapCallback: null };
    const dec = new CWDecoder(demod, { output: null, status: null });
    dec.worker = { postMessage(m) { posted.push({ i: Array.from(m.i), epoch: m.epoch }); } };
    dec.active = true;
    dec.chunkSamples = 4;
    dec._tap(Float32Array.from([1, 2, 3, 4, 5]), Float32Array.from([6, 7, 8, 9, 10]), 5);
    assert.equal(posted.length, 1);
    assert.deepEqual(posted[0].i, [1, 2, 3, 4]);
    assert.equal(dec.cur.i[0], 5);

    dec.inFlight = 1;
    dec.made = 8;
    dec.pool = [];
    dec.hold = [{ i: Float32Array.from([9, 9]), q: Float32Array.from([8, 8]) }];
    dec.chunkSamples = 2;
    dec.cur = null;
    dec.fill = 0;
    const before = posted.length;
    dec._tap(Float32Array.from([1, 2, 3, 4]), Float32Array.from([5, 6, 7, 8]), 4);
    assert.equal(posted.length, before);
    assert.equal(dec.hold.length, 1);
    assert.deepEqual(Array.from(dec.hold[0].i), [3, 4]);
});

test('greedy CTC collapses repeats, drops blanks, carries prev across chunks', () => {
    const chars = ['A', 'B', ' '], blank = 3, C = 4;
    const seq = [0, 0, 3, 0, 1, 1];
    const lp = new Float32Array(seq.length * C).fill(-10);
    seq.forEach((c, t) => { lp[t * C + c] = 0; });
    const r = ctcGreedy(lp, seq.length, C, chars, blank, null);
    assert.equal(r.text, 'AAB');
    assert.equal(r.prev, 1);
    const r2 = ctcGreedy(lp.subarray(4 * C), 2, C, chars, blank, r.prev);
    assert.equal(r2.text, '');
});

test('a missing model keeps the decoder off and says why', () => {
    const status = { textContent: '', className: '', title: '' };
    const demod = { tapCallback: null };
    const dec = new CWDecoder(demod, { output: null, status });
    dec.setMissing('models/didahcw.onnx not installed (see README)');
    dec.start(12000);
    assert.equal(dec.active, false);
    assert.equal(dec.worker, null);
    assert.equal(demod.tapCallback, null);
    assert.equal(status.textContent, 'NO MODEL');
    assert.match(status.title, /README/);
});
