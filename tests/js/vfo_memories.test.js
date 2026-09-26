'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { req } = require('./load.js');
const {
    VFO_MEMORY_MAX,
    VFO_MEMORY_DEFAULTS,
    formatVfoHz,
    sanitizeVfoMemories,
    loadVfoMemories,
} = req('vfo_memories.js');

test('format groups Hz the same way as the drum dial', () => {
    assert.equal(formatVfoHz(1802500), '1.802.500');
    assert.equal(formatVfoHz(14047500), '14.047.500');
    assert.equal(formatVfoHz(18097500), '18.097.500');
    assert.equal(formatVfoHz(700), '700');
});

test('a missing store restores the ARRL W1AW Morse frequencies', () => {
    assert.deepEqual(sanitizeVfoMemories(null), [...VFO_MEMORY_DEFAULTS]);
    assert.deepEqual(sanitizeVfoMemories('nope'), [...VFO_MEMORY_DEFAULTS]);
    assert.equal(VFO_MEMORY_DEFAULTS[4], 18097500);
});

test('a saved list is kept, including an empty one, and junk is dropped', () => {
    assert.deepEqual(sanitizeVfoMemories([]), []);
    assert.deepEqual(sanitizeVfoMemories([14048000, 'bad', -1, 1e12, 7047500.4]), [14048000, 7047500]);
    const long = [];
    for (let i = 0; i < 40; i++) long.push(1000 + i);
    assert.equal(sanitizeVfoMemories(long).length, VFO_MEMORY_MAX);
});

test('load reads JSON from storage and falls back when it is missing', () => {
    const mem = new Map();
    const storage = {
        getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    };
    assert.deepEqual(loadVfoMemories(storage, 'k'), [...VFO_MEMORY_DEFAULTS]);
    mem.set('k', JSON.stringify([21067500]));
    assert.deepEqual(loadVfoMemories(storage, 'k'), [21067500]);
    mem.set('k', '{');
    assert.deepEqual(loadVfoMemories(storage, 'k'), [...VFO_MEMORY_DEFAULTS]);
});
