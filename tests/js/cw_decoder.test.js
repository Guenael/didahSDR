'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./load.js');
const { cwTokenClass, cwHighlightHtml, CWDecoder } = require('../../app/js/cw_decoder.js');

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
    assert.equal(CWDecoder.usableRate(1000), 0);
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
