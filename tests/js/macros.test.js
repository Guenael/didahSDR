'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { req } = require('./load.js');
const {
    MACRO_KEYS,
    MACRO_SETS,
    macroSet,
    sanitizeCallsign,
    sanitizeExtra,
    clampContestNr,
    formatContestNr,
    expandMacro,
    appendMacroText,
} = req('macros.js');

const VARS = { MY_CALL: 'VA2GKA', CALLER: 'F4KIY', MY_EXTRA: '<NR>', NR: 7 };
const run = (mode, i, vars = VARS) => expandMacro(MACRO_SETS[mode].macros[i].text, vars);

test('the 12 macros expand with the operator, caller, extra and counter', () => {
    assert.deepEqual([0, 1, 2, 3].map((i) => run('qso', i)), [
        'CQ CQ DE VA2GKA VA2GKA VA2GKA K',
        'F4KIY DE VA2GKA VA2GKA KN',
        'F4KIY DE VA2GKA',
        'F4KIY DE VA2GKA THX FER CALL = RST 599 599 = HW CPY? F4KIY DE VA2GKA KN',
    ]);
    assert.deepEqual([0, 1, 2, 3].map((i) => run('ans', i)), [
        'F4KIY DE VA2GKA VA2GKA K',
        'R R F4KIY DE VA2GKA TNX FER RPRT = UR RST 599 599 = F4KIY DE VA2GKA KN',
        'F4KIY DE VA2GKA',
        'TNX FER QSO 73 F4KIY DE VA2GKA SK',
    ]);
    assert.deepEqual([0, 1, 2, 3].map((i) => run('test', i)), [
        'TEST VA2GKA VA2GKA',
        'VA2GKA',
        '5NN 007',
        'TU',
    ]);
});

test('labels, flags and F-key map', () => {
    assert.deepEqual(MACRO_SETS.qso.macros.map((m) => m.label), ['CQ', 'ANS', 'DE', 'RST']);
    assert.deepEqual(MACRO_SETS.ans.macros.map((m) => m.label), ['ANS', 'RST', 'DE', '73']);
    assert.deepEqual(MACRO_SETS.test.macros.map((m) => m.label), ['CQ', 'ANS', 'RPRT', 'RRR']);
    const flags = (mode, k) => MACRO_SETS[mode].macros.map((m) => m[k]);
    assert.deepEqual(flags('qso', 'log'), [false, false, false, true]);
    assert.deepEqual(flags('ans', 'log'), [false, true, false, false]);
    assert.deepEqual(flags('test', 'log'), [false, false, true, false]);
    assert.deepEqual(flags('test', 'bump'), [false, false, false, true]);
    assert.deepEqual(flags('qso', 'needsCaller'), [false, true, true, true]);
    assert.deepEqual(flags('ans', 'needsCaller'), [true, true, true, true]);
    // TEST RPRT has no <CALLER> but logs, so it needs one.
    assert.deepEqual(flags('test', 'needsCaller'), [false, false, true, false]);
    assert.deepEqual(MACRO_KEYS, { F1: 0, F2: 1, F3: 2, F4: 3 });
    assert.equal(macroSet('nope'), MACRO_SETS.qso);
});

test('<NR> is padded to 3 digits and expanded inside Extra', () => {
    assert.equal(formatContestNr(1), '001');
    assert.equal(formatContestNr(42), '042');
    assert.equal(formatContestNr(1234), '1234');
    assert.equal(expandMacro('5NN <MY_EXTRA>', { MY_EXTRA: 'QC <NR>', NR: 12 }), '5NN QC 012');
    assert.equal(expandMacro('<NR> <NR>', { NR: 3 }), '003 003');
    assert.equal(expandMacro('5NN <MY_EXTRA>', { MY_EXTRA: '', NR: 3 }), '5NN');
});

test('expansion collapses spaces and trims', () => {
    assert.equal(expandMacro('  <CALLER>  DE <MY_CALL> ', { MY_CALL: 'va2gka' }), 'DE VA2GKA');
});

test('sanitisers', () => {
    assert.equal(sanitizeCallsign(' va2gka/p-1! '), 'VA2GKA/P1');
    assert.equal(sanitizeCallsign('ABCDEFGHIJKLMNOPQ'), 'ABCDEFGHIJKLMN');
    assert.equal(sanitizeCallsign(null), '');
    assert.equal(sanitizeExtra('qc <nr>, 5w!'), 'QC <NR> 5W');
    assert.equal(sanitizeExtra('x'.repeat(40)).length, 32);
});

test('counter clamp', () => {
    assert.equal(clampContestNr(0), 1);
    assert.equal(clampContestNr(-5), 1);
    assert.equal(clampContestNr(10000), 9999);
    assert.equal(clampContestNr('12'), 12);
    assert.equal(clampContestNr('junk'), 1);
    assert.equal(clampContestNr(2.6), 3);
});

test('append puts one space between the box text and the macro', () => {
    assert.equal(appendMacroText('', 'CQ'), 'CQ');
    assert.equal(appendMacroText('TU', 'CQ'), 'TU CQ');
    assert.equal(appendMacroText('TU ', 'CQ'), 'TU CQ');
    assert.equal(appendMacroText('TU', ''), 'TU');
});

// ---- Macro editor store (JSON document, overrides) --------------------------------------------
{
    const M = req('macros.js');

    test('overrides replace label and text per slot; <LOG> / <INC> in the text set the flags', () => {
        const sets = M.applyMacroOverrides({
            qso: [{ label: 'cq?', text: 'cq test de <my_call>\nk <inc>' }, {}, { label: '', text: '' },
                  { text: '<CALLER> TU 73' }],
            test: [undefined, undefined, undefined, { label: 'TU!', text: 'tu <my_call> <LOG> <INC>' }],
        });
        assert.equal(sets.qso.macros[0].label, 'CQ?');
        assert.equal(sets.qso.macros[0].text, 'CQ TEST DE <MY_CALL> K <INC>');
        assert.equal(sets.qso.macros[0].bump, true);
        assert.equal(sets.qso.macros[1].text, M.MACRO_SETS.qso.macros[1].text);       // untouched slot
        assert.equal(sets.qso.macros[2].label, 'DE');                                  // empty label keeps default
        assert.equal(sets.qso.macros[2].text, '');                                     // empty text is allowed
        assert.equal(sets.qso.macros[3].log, false);                                   // <LOG> removed: no entry
        assert.equal(sets.test.macros[3].label, 'TU');
        assert.equal(sets.test.macros[3].log, true);
        assert.equal(sets.test.macros[3].bump, true);
        assert.equal(sets.test.macros[3].needsCaller, true);                           // logging needs a caller
        assert.equal(M.applyMacroOverrides({ ans: [{ text: 'QRZ? <CALLER>' }] }).ans.macros[0].needsCaller, true);
    });

    test('<LOG> and <INC> send nothing, also when they come in through Extra', () => {
        assert.equal(M.expandMacro('5NN <MY_EXTRA> <LOG>', { MY_EXTRA: '<NR>', NR: 7 }), '5NN 007');
        assert.equal(M.expandMacro('<INC>TU <LOG>', {}), 'TU');
        assert.equal(M.expandMacro('<MY_EXTRA>', { MY_EXTRA: 'X <LOG>' }), 'X');
    });

    test('export document round-trips through JSON and localStorage', () => {
        const sets = M.applyMacroOverrides({ ans: [{ label: 'QRZ', text: 'QRZ? DE <MY_CALL>' }] });
        const doc = M.macroDocument(sets);
        assert.equal(doc.format, 'didahSDR-macros');
        assert.equal(doc.version, 1);
        assert.deepEqual(Object.keys(doc.sets), ['qso', 'ans', 'test']);
        assert.ok(Object.values(doc.sets).every((a) => a.length === 4));
        const back = M.applyMacroOverrides(M.parseMacroDocument(JSON.stringify(doc)));
        assert.deepEqual(M.macroDocument(back), doc);

        const store = new Map([[M.MACRO_STORE_KEY, JSON.stringify(doc)]]);
        const storage = { getItem: (k) => store.get(k) ?? null };
        assert.equal(M.loadMacroSets(storage).ans.macros[0].label, 'QRZ');
        store.set(M.MACRO_STORE_KEY, '{broken');
        assert.equal(M.loadMacroSets(storage), M.MACRO_SETS);
        assert.equal(M.loadMacroSets({ getItem: () => null }), M.MACRO_SETS);
    });

    test('import rejects other files and versions', () => {
        assert.throws(() => M.parseMacroDocument('{"sets":{}}'), /not a didahSDR macro file/);
        assert.throws(() => M.parseMacroDocument({ format: 'didahSDR-macros', version: 2, sets: {} }), /version 2/);
        assert.throws(() => M.parseMacroDocument('not json'));
    });

    test('macroSet follows the active sets', () => {
        const sets = M.applyMacroOverrides({ qso: [{ label: 'X', text: 'X' }] });
        M.setMacroSets(sets);
        assert.equal(M.macroSet('qso').macros[0].label, 'X');
        M.setMacroSets(null);
        assert.equal(M.macroSet('qso').macros[0].label, 'CQ');
    });
}
