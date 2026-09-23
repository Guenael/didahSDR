'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { req } = require('./load.js');

const { acceptIq, capRingAvailable } = req('sources_controller.js');
const { createSabRing, sabWrite, sabRead } = req('audio_ring.js');

test('acceptIq drops inactive sources and stale generations', () => {
    assert.equal(acceptIq('kiwi', 'didah', true, 1, 1), false);
    assert.equal(acceptIq('soundcard', 'soundcard', false, 2, 2), false);
    assert.equal(acceptIq('soundcard', 'soundcard', true, 2, 1), false);
    assert.equal(acceptIq('soundcard', 'soundcard', true, 2, 2), true);
    assert.equal(acceptIq('didah', 'didah', true, null, null), true);
    assert.equal(acceptIq('rtlsdr', 'rtlsdr', true, 0, 0), true);
});

test('capRingAvailable stays inside the spectrum ring', () => {
    assert.equal(capRingAvailable(100, 32768), 100);
    assert.equal(capRingAvailable(40000, 32768), 32768);
    assert.equal(capRingAvailable(-4, 32768), 0);
});

test('SAB ring round-trips floats and leaves one slot empty', () => {
    const ring = createSabRing();
    const src = new Float32Array([0.25, -0.5, 0.75]);
    assert.equal(sabWrite(ring, src), 3);
    const dst = new Float32Array(8);
    assert.equal(sabRead(ring, dst), 3);
    assert.equal(dst[0], 0.25);
    assert.equal(dst[1], -0.5);
    assert.equal(dst[2], 0.75);
    const big = new Float32Array(20000);
    big.fill(1);
    const wrote = sabWrite(ring, big);
    assert.ok(wrote < 16384, `wrote ${wrote}`);
    assert.ok(wrote > 16000, `wrote ${wrote}`);
});
