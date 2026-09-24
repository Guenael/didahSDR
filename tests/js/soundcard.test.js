'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const { req } = require('./load.js');
const {
    SOUND_RATES, isSoundRate, packStereoIq
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

test('packStereoIq maps L/R to float I/Q and honours swap', () => {
    const left = new Float32Array([1, 0.5]);
    const right = new Float32Array([-1, 0]);
    const dst = new Float32Array(4);
    packStereoIq(left, right, false, dst);
    assert.equal(dst[0], 1);
    assert.equal(dst[1], -1);
    packStereoIq(left, right, true, dst);
    assert.equal(dst[0], -1);
    assert.equal(dst[1], 1);
    const partial = new Float32Array(8);
    packStereoIq(left, right, false, partial, 1, 1, 1);
    assert.equal(partial[2], 0.5);
    assert.equal(partial[3], 0);
    packStereoIq(left, null, false, partial, 0, 1, 0);
    assert.equal(partial[0], 1);
    assert.equal(partial[1], 0);
});

test('capture worklet packs a quantum through packStereoIq', () => {
    global.sampleRate = 48000;
    global.AudioWorkletProcessor = class AudioWorkletProcessor {
        constructor() {
            this.port = { onmessage: null, postMessage() {} };
        }
    };
    let Proc = null;
    global.registerProcessor = (_name, cls) => { Proc = cls; };
    const src = fs.readFileSync(path.resolve(__dirname, '../../app/js/audio_capture_worklet.js'), 'utf8');
    vm.runInThisContext(src);
    const proc = new Proc({ processorOptions: { mode: 'stereo-iq' } });
    const left = new Float32Array(128);
    const right = new Float32Array(128);
    left[3] = 0.25;
    right[3] = -0.5;
    proc.process([[left, right]], [[new Float32Array(128)]]);
    const expect = new Float32Array(256);
    packStereoIq(left, right, false, expect);
    for (let i = 0; i < 256; i++) assert.equal(proc.cur[i], expect[i]);
    proc.port.onmessage({ data: { type: 'swap', on: true } });
    proc.fill = 0;
    proc.process([[left, right]], [[new Float32Array(128)]]);
    packStereoIq(left, right, true, expect);
    assert.equal(proc.cur[6], right[3]);
    assert.equal(proc.cur[7], left[3]);
});

test('capture teardown disconnects the graph, stops tracks and closes the context once', async () => {
    const { shutdownCapture, abandonCapture } = req('audio_devices.js');
    const log = [];
    const node = (name) => ({ disconnect: () => log.push(`${name}.disconnect`) });
    const stream = { getTracks: () => [{ stop: () => log.push('track.stop') }] };
    const ctx = { close: async () => log.push('ctx.close') };
    const owner = { node: node('node'), sourceNode: node('src'), mute: node('mute'), stream, ctx };
    await shutdownCapture(owner);
    assert.deepEqual(log, ['node.disconnect', 'src.disconnect', 'mute.disconnect', 'track.stop', 'ctx.close']);
    assert.deepEqual([owner.node, owner.sourceNode, owner.mute, owner.stream, owner.ctx], [null, null, null, null, null]);

    // A newer start() owns other objects: abandoning the old ones must not clear them.
    log.length = 0;
    const newer = { stream: { getTracks: () => [] }, ctx: { close: async () => {} } };
    const keep = { stream: newer.stream, ctx: newer.ctx };
    await abandonCapture(keep, stream, ctx);
    assert.deepEqual(log, ['track.stop', 'ctx.close']);
    assert.equal(keep.stream, newer.stream);
    assert.equal(keep.ctx, newer.ctx);
});
