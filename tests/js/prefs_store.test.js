'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSettingsStore, SETTINGS_KEY } = require('../../app/js/prefs_store.js');

function memoryStorage(initial) {
    const data = new Map(Object.entries(initial || {}));
    return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), data };
}

function field(name, log, current) {
    return { name, save: () => current[name], load: (v) => log.push([name, v]) };
}

test('save writes every defined field under didah_settings', () => {
    const storage = memoryStorage();
    const current = { volume: 0.5, wpm: 25, skipped: undefined };
    const store = createSettingsStore({ storage, fields: ['volume', 'wpm', 'skipped'].map((n) => field(n, [], current)) });
    const out = store.save();
    assert.deepEqual(out, { volume: 0.5, wpm: 25 });
    assert.deepEqual(JSON.parse(storage.data.get(SETTINGS_KEY)), { volume: 0.5, wpm: 25 });
});

test('load restores in field order and skips keys that were never saved', () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: JSON.stringify({ wpm: 30, volume: 0.2, extra: 1 }) });
    const log = [];
    const store = createSettingsStore({ storage, fields: ['volume', 'missing', 'wpm'].map((n) => field(n, log, {})) });
    assert.equal(store.load(), true);
    assert.deepEqual(log, [['volume', 0.2], ['wpm', 30]]);
});

test('corrupt or absent storage keeps the defaults', () => {
    for (const raw of [undefined, 'not json', '42', 'null']) {
        const storage = memoryStorage(raw === undefined ? {} : { [SETTINGS_KEY]: raw });
        const log = [];
        const store = createSettingsStore({ storage, fields: [field('volume', log, {})] });
        assert.equal(store.load(), false, String(raw));
        assert.deepEqual(log, []);
    }
});

test('a field that throws does not stop the others, and a failing storage does not throw', () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: JSON.stringify({ a: 1, b: 2 }) });
    const log = [];
    const warn = console.warn;
    console.warn = () => {};
    try {
        const store = createSettingsStore({
            storage,
            fields: [{ name: 'a', save: () => 1, load: () => { throw new Error('boom'); } }, field('b', log, {})]
        });
        store.load();
    } finally {
        console.warn = warn;
    }
    assert.deepEqual(log, [['b', 2]]);
    const broken = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    assert.doesNotThrow(() => createSettingsStore({ storage: broken, fields: [field('x', [], { x: 1 })] }).save());
});
