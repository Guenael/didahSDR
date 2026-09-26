'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./load.js');

test('every colormap has a 256-entry packed table with opaque alpha', () => {
    for (const name of Colormaps.getAvailableNames()) {
        const t = Colormaps.getTable(name);
        assert.equal(t.length, 256, name);
        assert.equal(t[0] >>> 24, 0xff, `${name} alpha`);
        assert.equal(t[255] >>> 24, 0xff, `${name} alpha`);
    }
});

test('every theme has a stored reverse, and a reversed id pairs back to the forward table', () => {
    const suffix = '.reversed()';
    for (const { id } of Colormaps.list()) {
        const fwd = Colormaps.getTable(id);
        const revId = id.endsWith(suffix) ? id.slice(0, -suffix.length) : id + suffix;
        const rev = Colormaps.getTable(revId);
        assert.equal(rev.length, 256, revId);
        assert.equal(rev[0], fwd[255], id);
        assert.equal(rev[255], fwd[0], id);
        assert.notEqual(rev, fwd);
    }
    assert.equal(Colormaps.list().some((t) => t.id === 'viridis.reversed()'), false);
    assert.equal(Colormaps.list().some((t) => t.id === 'PuBu.reversed()'), true);
});

test('getRgb agrees with the packed ABGR table', () => {
    const p = Colormaps.getTable('viridis')[100];
    const [r, g, b] = Colormaps.getRgb('viridis', 100);
    assert.deepEqual([r, g, b], [p & 255, (p >>> 8) & 255, (p >>> 16) & 255]);
});

test('unknown name falls back to viridis', () => {
    assert.equal(Colormaps.getTable('nope'), Colormaps.getTable('viridis'));
});

test('tty is the rocky RGB permutation [0, 2, 1] as a packed table', () => {
    const rocky = Colormaps.getTable('rocky');
    const tty = Colormaps.getTable('tty');
    assert.equal(tty.length, 256);
    assert.notEqual(tty, rocky);
    const [sr, sg, sb] = Colormaps.getRgb('rocky', 255);
    const [tr, tg, tb] = Colormaps.getRgb('tty', 255);
    assert.deepEqual([tr, tg, tb], [sr, sb, sg]);
    assert.equal(tty[255] >>> 24, 0xff);
});
