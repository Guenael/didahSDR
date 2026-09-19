'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { req } = require('./load.js');
const { MODES, setSsbPassband } = req('modes.js');

test('USB/LSB default passband is 200–2700 Hz and LSB is the mirror', () => {
    assert.equal(MODES.usb.low, 200);
    assert.equal(MODES.usb.high, 2700);
    assert.equal(MODES.lsb.low, -2700);
    assert.equal(MODES.lsb.high, -200);
});

test('setSsbPassband updates USB and mirrors LSB, then restores defaults', () => {
    const pb = setSsbPassband(250, 2400);
    assert.equal(pb.low, 250);
    assert.equal(pb.high, 2400);
    assert.equal(MODES.usb.low, 250);
    assert.equal(MODES.usb.high, 2400);
    assert.equal(MODES.lsb.low, -2400);
    assert.equal(MODES.lsb.high, -250);

    setSsbPassband(200, 2700);
    assert.equal(MODES.usb.low, 200);
    assert.equal(MODES.lsb.high, -200);
});
