'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./load.js');
const { CWRecorder, encodeWavInt16, peakGain, recName } = require('../../app/js/cw_recorder.js');
const { CWDecoder } = require('../../app/js/cw_decoder.js');

const PEAK = Math.pow(10, -1 / 20);

function parseWav(buf) {
    const v = new DataView(buf);
    const tag = (o) => String.fromCharCode(...new Uint8Array(buf, o, 4));
    return {
        riff: tag(0), wave: tag(8), fmt: tag(12), data: tag(36),
        riffSize: v.getUint32(4, true),
        format: v.getUint16(20, true),
        channels: v.getUint16(22, true),
        rate: v.getUint32(24, true),
        byteRate: v.getUint32(28, true),
        align: v.getUint16(32, true),
        bits: v.getUint16(34, true),
        dataSize: v.getUint32(40, true),
        samples: new Int16Array(buf, 44, v.getUint32(40, true) / 2),
    };
}

test('int16 WAV header and samples round trip, with clipping', () => {
    const w = parseWav(encodeWavInt16([Float32Array.from([0.5, -0.5]), Float32Array.from([2, -2])], 2, 12000));
    assert.deepEqual(
        [w.riff, w.wave, w.fmt, w.data, w.format, w.channels, w.rate, w.byteRate, w.align, w.bits],
        ['RIFF', 'WAVE', 'fmt ', 'data', 1, 2, 12000, 48000, 4, 16]
    );
    assert.equal(w.dataSize, 8);
    assert.equal(w.riffSize, 36 + 8);
    assert.deepEqual(Array.from(w.samples), [16384, -16384, 32767, -32768]);
});

test('peak gain brings the largest sample to -1 dBFS, silence stays at unity', () => {
    const g = peakGain([Float32Array.from([0.01, -0.02]), Float32Array.from([0.005])]);
    assert.ok(Math.abs(g * 0.02 - PEAK) < 1e-6); // 0.02 is stored as float32
    assert.equal(peakGain([new Float32Array(4)]), 1);
});

test('clip names are UTC and prefixed in noise mode', () => {
    const d = new Date(Date.UTC(2026, 8, 22, 14, 3, 5));
    assert.equal(recName(d, 14050800.4, 'signal'), 'didah_20260922_140305_14050800');
    assert.equal(recName(d, 7030000, 'noise'), 'noise_didah_20260922_140305_7030000');
});

test('recorder interleaves the tap, normalises, and fills the sidecar', () => {
    let got = null;
    const rec = new CWRecorder({ onStop: (c) => { got = c; } });
    rec.start({ rate: 800, audioRate: 12000, carrierHz: 14050800, kind: 'noise', bandwidth: 250 });
    rec.pushTap(Float32Array.from([0.1, 0.2]), Float32Array.from([-0.1, -0.4]), 2);
    rec.pushAudio(Float32Array.from([0.3, 0.6, 9]), 2);
    rec.pushText('CQ ');
    rec.pushText('TEST ');
    const clip = rec.stop();
    assert.equal(got, clip);
    assert.equal(rec.recording, false);
    const iq = parseWav(clip.iqWav);
    assert.equal(iq.channels, 2);
    assert.equal(iq.rate, 800);
    const s = Array.from(iq.samples).map((x) => x / 32768);
    const want = [0.1, -0.1, 0.2, -0.4].map((x) => (x * PEAK) / 0.4);
    s.forEach((x, k) => assert.ok(Math.abs(x - want[k]) < 1e-4));
    const au = parseWav(clip.audioWav);
    assert.equal(au.channels, 1);
    assert.equal(au.samples.length, 2); // n = 2 drops the third sample
    assert.equal(clip.sidecar.kind, 'noise');
    assert.equal(clip.sidecar.carrier_hz, 14050800);
    assert.equal(clip.sidecar.bandwidth, 250);
    assert.equal(clip.sidecar.duration_s, 0.003); // 2 frames at 800 Hz, ms precision
    assert.equal(clip.sidecar.hyp, 'CQ TEST');
    assert.equal(clip.sidecar.stop_reason, 'user');
    assert.ok(clip.name.startsWith('noise_didah_'));
    assert.equal(rec.stop(), null);
});

test('recorder stops itself at the length cap', () => {
    const rec = new CWRecorder({ maxSeconds: 1 });
    rec.start({ rate: 800, audioRate: 12000, carrierHz: 0 });
    const z = new Float32Array(500);
    rec.pushTap(z, z, 500);
    assert.equal(rec.recording, true);
    rec.pushTap(z, z, 500);
    assert.equal(rec.recording, false);
});

test('decoder reset and stop end the clip', () => {
    const dec = new CWDecoder({ tapCallback: null }, { output: null, status: null });
    dec._status = () => {};
    const reasons = [];
    dec.recorder = new CWRecorder({ onStop: (c) => reasons.push(c.sidecar.stop_reason) });
    for (const end of [() => dec.reset(), () => dec.stop()]) {
        dec.recorder.start({ rate: 800, audioRate: 12000, carrierHz: 0 });
        dec.recorder.pushTap(new Float32Array(8), new Float32Array(8), 8);
        end();
        assert.equal(dec.recorder.recording, false);
    }
    assert.deepEqual(reasons, ['reset', 'decoder off']);
});

test('hyp keeps only the characters decoded from inside the clip, and waits for the tail', () => {
    let got = null;
    const rec = new CWRecorder({ onStop: (c) => { got = c; } });
    rec.start({ rate: 12000, audioRate: 12000, carrierHz: 7030000 });
    const z = new Float32Array(12000);
    rec.pushTap(z, z, 12000, 50000);                     // the clip is tap samples [50000, 62000)
    rec.pushText('OLD ', [40000, 42000, 44000, 49999]);  // decoded late, but from before REC
    rec.pushText('CQ', [51000, 53000], 55000);
    assert.equal(rec.stop('user'), null);               // the decoder is ~1 s behind: wait
    assert.equal(rec.draining, true);
    assert.equal(got, null);
    rec.pushText(' DE', [60000, 61000, 61500], 61000);   // still short of the clip's end
    assert.equal(got, null);
    rec.pushText(' AFTER', [62000, 62500, 63000, 63500, 64000, 64500], 67000);
    assert.ok(got, 'saved once the decode passed the end of the clip');
    assert.equal(got.sidecar.hyp, 'CQ DE');
    assert.equal(got.sidecar.stop_reason, 'user');
    assert.equal(rec.draining, false);
});

test('a draining clip is saved on timeout, and a reset saves it at once', async () => {
    const saved = [];
    const rec = new CWRecorder({ onStop: (c) => saved.push(c.sidecar.hyp), drainMs: 20 });
    const z = new Float32Array(100);
    rec.start({ rate: 12000, audioRate: 12000, carrierHz: 0 });
    rec.pushTap(z, z, 100, 0);
    rec.pushText('K', [10], 50);
    rec.stop('user');
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(saved, ['K']);

    rec.start({ rate: 12000, audioRate: 12000, carrierHz: 0 });
    rec.pushTap(z, z, 100, 1000);
    rec.stop('user');
    rec.stop('reset');                                   // decoder reset: no tail will come
    assert.equal(saved.length, 2);
    assert.equal(rec.draining, false);
});
