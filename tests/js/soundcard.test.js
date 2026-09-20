'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { req } = require('./load.js');
const {
    SOUND_RATES, isSoundRate, pickSoundRate, preferredCaptureRate, packStereoIq, classifyCapture
} = req('soundcard.js');
const { findSource } = req('sources.js');

test('catalog has soundcard between replay and kiwi, centre 0 Hz', () => {
    const sc = findSource('soundcard');
    assert.equal(sc.protocol, 'soundcard');
    assert.equal(sc.startFreq, 0);
    assert.equal(sc.startMod, 'cw');
});

test('allowed rates are 48 / 96 / 192 kHz', () => {
    assert.deepEqual(SOUND_RATES, [48000, 96000, 192000]);
    assert.equal(isSoundRate(96000), true);
    assert.equal(isSoundRate(44100), false);
    assert.equal(isSoundRate(48000.4), true);
});

test('preferredCaptureRate walks 96 kHz then 48 then 192', () => {
    assert.equal(preferredCaptureRate([44100]), 0);
    assert.equal(preferredCaptureRate([192000, 48000]), 48000);
    assert.equal(preferredCaptureRate([192000, 96000, 48000]), 96000);
    assert.equal(preferredCaptureRate([192000]), 192000);
});

test('pickSoundRate prefers native when allowed, else highest in range', () => {
    assert.equal(pickSoundRate(44100, 44100, 44100), 0);
    assert.equal(pickSoundRate(44100, 48000, 44100), 48000);
    assert.equal(pickSoundRate(44100, 192000, 96000), 96000);
    assert.equal(pickSoundRate(8000, 192000, 44100), 192000);
});

test('classifyCapture requires stereo and an allowed rate', () => {
    assert.equal(classifyCapture({ channelCount: 1, sampleRate: 48000 }).ok, false);
    assert.equal(classifyCapture({ channelCount: 2, sampleRate: 44100 }).ok, false);
    const ok = classifyCapture({ channelCount: 2, sampleRate: 48000 });
    assert.equal(ok.ok, true);
    assert.equal(ok.rate, 48000);
    const ranged = classifyCapture({
        channelCount: 2, sampleRate: 44100, sampleRateMin: 44100, sampleRateMax: 96000
    });
    assert.equal(ranged.ok, true);
    assert.equal(ranged.rate, 96000);
});

test('packStereoIq maps L/R to I/Q and honours swap', () => {
    const left = new Float32Array([1, 0.5]);
    const right = new Float32Array([-1, 0]);
    const dst = new Int16Array(4);
    packStereoIq(left, right, false, dst);
    assert.equal(dst[0], 32767);
    assert.equal(dst[1], -32767);
    packStereoIq(left, right, true, dst);
    assert.equal(dst[0], -32767);
    assert.equal(dst[1], 32767);
});
