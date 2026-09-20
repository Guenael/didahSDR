'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { req, peakAbs } = require('./load.js');
const DidahAudioEngine = req('audio_worklet.js');

const tone = (n, f = 1000, rate = 48000, amp = 0.5) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / rate));

test('stays silent while prebuffering, then plays with a fade-in and no underrun', () => {
    const e = new DidahAudioEngine(48000, 48000);
    const out = new Float32Array(128);
    assert.equal(e.render(out), 0);
    assert.equal(e.stats.underruns, 0, 'prebuffering is not an underrun');

    e.push(tone(e.minPrebuffer + 2048));
    assert.equal(e.prebuffering, false);
    let firstPeak = e.render(out);
    assert.ok(firstPeak < 0.2, `fade-in should start quiet, got ${firstPeak}`);
    for (let i = 0; i < 8; i++) e.render(out);      // past the 480-sample fade
    assert.ok(e.render(out) > 0.45, 'full level after fade-in');
    assert.equal(e.stats.underruns, 0);
});

test('running dry counts one underrun and fades out instead of clicking', () => {
    const e = new DidahAudioEngine(48000, 48000);
    e.push(tone(e.minPrebuffer));
    const out = new Float32Array(128);
    let blocks = 0;
    while (!e.prebuffering && blocks < 1000) { e.render(out); blocks++; }
    assert.ok(e.stats.underruns >= 1);
    // the block that ran dry must not contain a jump larger than the fade allows
    let maxJump = 0; for (let i = 1; i < out.length; i++) maxJump = Math.max(maxJump, Math.abs(out[i] - out[i - 1]));
    assert.ok(maxJump < 0.1, `max sample jump ${maxJump}`);
});

test('drift compensation pulls the buffer level toward the target', () => {
    const e = new DidahAudioEngine(48000, 48000);
    const out = new Float32Array(128);
    e.push(tone(e.targetBuffer + 3000));          // start 3000 samples over target
    // Feed exactly real-time: 128 in per 128 out, so only the rate trim can move the level
    for (let i = 0; i < 4000; i++) { e.push(tone(128)); e.render(out); }
    assert.ok(Math.abs(e.buffered - e.targetBuffer) < 3000 * 0.7, `buffered ${e.buffered}, target ${e.targetBuffer}`);
});

test('resamples when the context rate differs from the input rate', () => {
    const e = new DidahAudioEngine(48000, 44100);
    const out = new Float32Array(441);           // 10 ms of output
    e.push(tone(e.minPrebuffer + 4800));
    const before = e.buffered;
    e.render(out);
    assert.ok(Math.abs((before - e.buffered) - 480) < 5, `consumed ${before - e.buffered}, expected ~480 input samples`);
});

test('reset drops everything and returns to prebuffering', () => {
    const e = new DidahAudioEngine();
    e.push(tone(8000));
    e.reset();
    assert.equal(e.buffered, 0);
    assert.equal(e.prebuffering, true);
    assert.equal(peakAbs(Object.assign(new Float32Array(128), {})), 0);
});

test('setInputRate(12000) resamples toward the context rate and resets the ring', () => {
    const e = new DidahAudioEngine(48000, 48000);
    e.push(tone(8000));
    e.setInputRate(12000);
    assert.equal(e.inputRate, 12000);
    assert.equal(e.buffered, 0);
    assert.equal(e.prebuffering, true);
    const out = new Float32Array(480);        // 10 ms of 48 kHz output
    e.push(tone(e.minPrebuffer + 2400, 1000, 12000));
    const before = e.buffered;
    e.render(out);
    assert.ok(Math.abs((before - e.buffered) - 120) < 8, `consumed ${before - e.buffered}, expected ~120 input samples`);
});

test('sidetone bypasses the RX jitter buffer', () => {
    const renderSidetoneOrRx = DidahAudioEngine.renderSidetoneOrRx;
    const engine = new DidahAudioEngine(48000, 48000);
    const rx = new Float32Array(engine.targetBuffer);
    rx.fill(0.9);
    engine.push(rx);
    const keyer = new CwKeyer();
    keyer.setWpm(20);
    keyer.setPaddle('dit', true);
    const out = new Float32Array(128);
    const txState = { wasTx: false };
    const peak = renderSidetoneOrRx(txState, engine, keyer, out, 48000, 700, false);
    assert.equal(txState.wasTx, true);
    assert.ok(Math.abs(out[0]) < 0.05, 'first sample is the sidetone rise, not queued RX');
    assert.ok(peak > 0.05, `sidetone peak ${peak}`);
});

test('leaving TX drops the RX ring so playback re-prebuffers', () => {
    const renderSidetoneOrRx = DidahAudioEngine.renderSidetoneOrRx;
    const engine = new DidahAudioEngine(48000, 48000);
    engine.push(tone(engine.targetBuffer));
    const keyer = new CwKeyer();
    keyer.setWpm(20);
    keyer.setPaddle('dit', true);
    const out = new Float32Array(128);
    const txState = { wasTx: false };
    renderSidetoneOrRx(txState, engine, keyer, out, 48000, 700, false);
    keyer.setPaddle('dit', false);
    keyer.abort();
    const peak = renderSidetoneOrRx(txState, engine, keyer, out, 48000, 700, false);
    assert.equal(txState.wasTx, false);
    assert.equal(engine.prebuffering, true);
    assert.equal(peak, 0);
});
