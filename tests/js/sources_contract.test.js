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

test('every source keeps the callbacks it is given (a dropped one fails silently)', () => {
    req('civ.js');
    req('ic7300_if.js');
    const DidahConnection = req('connection.js');
    const { KiwiConnection } = req('kiwi.js');
    const { SoundcardSource } = req('soundcard.js');
    const { Ic7300Source } = req('ic7300.js');
    const { RtlSdrSource } = req('rtlsdr.js');
    const cb = () => {};
    const cases = [
        [DidahConnection, ['onRawIQ', 'onConfig', 'onStatusChange'], { url: 'ws://x/ws' }],
        [KiwiConnection, ['onRawIQ', 'onReady', 'onStatusChange', 'onCenterApplied'], {}],
        [SoundcardSource, ['onRawIQ', 'onReady', 'onStatusChange', 'onDevices'], {}],
        [Ic7300Source, ['onRawIQ', 'onReady', 'onStatusChange', 'onDevices', 'onFrequency', 'onMode'], {}],
        [RtlSdrSource, ['onRawIQ', 'onReady', 'onStatusChange', 'onCenterApplied'], {}],
    ];
    for (const [Ctor, names, extra] of cases) {
        const opts = Object.assign({}, extra);
        for (const n of names) opts[n] = cb;
        const src = new Ctor(opts);
        for (const n of names) assert.equal(src[n], cb, `${Ctor.name}.${n}`);
    }
});

test('source policy: only Kiwi and RTL-SDR follow the dial; every catalog source has a label', () => {
    const { sourcePolicy } = req('sources_controller.js');
    const { SOURCES } = req('sources.js');
    for (const src of SOURCES) assert.ok(sourcePolicy(src.protocol).label, src.id);
    const following = SOURCES.filter((s) => sourcePolicy(s.protocol).followsDial).map((s) => s.protocol).sort();
    assert.deepEqual(following, ['kiwi', 'rtlsdr']);
    assert.equal(sourcePolicy('nope').label, sourcePolicy('didah').label);
});
