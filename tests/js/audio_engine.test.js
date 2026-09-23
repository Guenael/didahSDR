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
    e.push(tone(e.targetBuffer + 3000));          // start 3000 samples over target, under the 2× resync
    const start = e.buffered;
    // Real-time feed. The trim is clamped at ±0.1 %, so ten seconds only walks the level a little.
    for (let i = 0; i < 4000; i++) { e.push(tone(128)); e.render(out); }
    assert.ok(e.buffered < start - 40, `buffered ${e.buffered} should fall from ${start}`);
    assert.ok(e.buffered > e.targetBuffer, `buffered ${e.buffered} should stay above the target while catching up`);
});

test('a buffer past twice the target resyncs, and overflow keeps the newest window', () => {
    const e = new DidahAudioEngine(12000, 48000);
    const out = new Float32Array(128);
    e.push(tone(e.minPrebuffer, 700, 12000));
    e.render(out);
    e.push(tone(e.targetBuffer * 3, 700, 12000));
    e.render(out);
    assert.ok(e.buffered <= e.targetBuffer + 64, `resync buffered ${e.buffered}, target ${e.targetBuffer}`);

    const full = new DidahAudioEngine(48000, 48000);
    full.push(tone(full.RING_SIZE + 1000));
    assert.equal(full.stats.overflows, 1);
    assert.equal(full.buffered, full.targetBuffer);
    const behind = (full.writePos - full.readPos + full.RING_SIZE) % full.RING_SIZE;
    assert.ok(Math.abs(behind - full.targetBuffer) < 1, `read is ${behind} behind write`);
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

test('polyphase upsample keeps the 11 kHz image well below a 1 kHz tone', () => {
    const e = new DidahAudioEngine(12000, 48000);
    const out = new Float32Array(16384);
    const block = new Float32Array(512);
    const hop = block.length * e.inputRate / e.outputRate;
    const src = tone(e.minPrebuffer + hop * (out.length / block.length) + 64, 1000, 12000, 0.5);
    let pos = 0;
    const feed = (n) => { e.push(src.subarray(pos, pos + n)); pos += n; };
    feed(e.minPrebuffer);
    for (let filled = 0; filled < out.length; filled += block.length) {
        feed(hop);
        e.render(block);
        out.set(block, filled);
    }
    const fftSize = 8192;
    const fft = new DidahFFT(fftSize);
    const re = new Float32Array(fftSize);
    re.set(out.subarray(out.length - fftSize));
    const spec = fft.computeSpectrumDb(re, new Float32Array(fftSize));
    const bin = (hz) => {
        const k = fftSize / 2 + Math.round((hz / 48000) * fftSize);
        return Math.max(spec[k - 1], spec[k], spec[k + 1]);
    };
    const gap = bin(1000) - bin(11000);
    assert.ok(gap > 30, `1 kHz is ${gap.toFixed(1)} dB above the 11 kHz image`);
});

test('setInputRate(12000) resamples toward the context rate and resets the ring', () => {
    const e = new DidahAudioEngine(48000, 48000);
    e.push(tone(8000));
    e.setInputRate(12000);
    assert.equal(e.inputRate, 12000);
    assert.equal(e.buffered, 0);
    assert.equal(e.prebuffering, true);
    const out = new Float32Array(480);        // 10 ms of 48 kHz output
    e.push(tone(e.minPrebuffer + 400, 1000, 12000));
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
