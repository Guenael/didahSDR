'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { iqTone, floatIq } = require('./load.js');
global.capRingAvailable = require('../../app/js/sources_controller.js').capRingAvailable;
const { QrssSpectrum } = require('../../app/js/qrss.js');
const { createSpectrumPipeline, SPECTRUM_RING_SIZE } = require('../../app/js/spectrum_pipeline.js');

const RATE = 96000;
const PACKET = RATE / 40;   // 25 ms, as the replay server sends

/** Real DSP objects, fake display / audio sinks that count what they receive. */
function makeCtx(overrides = {}) {
    const state = {
        running: true, sampleRate: RATE, centerFreq: 14048000, tunedFreq: 14050000, modulation: 'cw',
        cwBandwidth: 150, cwOffset: 700, fftSize: 2048, speedMultiplier: 3, filterEnabled: true,
        qrssEnabled: false, lowCut: -75, highCut: 75
    };
    const demodulator = new DidahDemodulator(RATE);
    demodulator.configure({ offsetFreq: 2000 });
    const qrss = new QrssSpectrum();
    qrss.setInputRate(demodulator.audioRate);
    const n = { slices: 0, meter: 0, audio: 0, recorded: 0, audioResets: 0, decoderResets: 0, leds: 0, clears: 0 };
    const ctx = {
        state, demodulator, qrss,
        clientFft: new DidahFFT(state.fftSize),
        cwFilter: new CWAdaptiveFilter(state.fftSize),
        waterfall: {
            addSlice: () => n.slices++, clear: () => n.clears++, setCenterFreq() {}, setTunedFreq() {},
            zoom: 2.67, panOffset: 0
        },
        smeter: { updateFromSpectrum: () => n.meter++, reset() {} },
        audioPlayer: { pushFloatAudio: (a) => { n.audio += a.length; }, resetBuffer: () => n.audioResets++ },
        cwRecorder: { pushAudio: () => n.recorded++ },
        cwDecoder: { reset: () => n.decoderResets++ },
        isLocalTx: () => false,
        updateTrxLeds: () => n.leds++,
        isHidden: () => false,
        ...overrides
    };
    return { ctx, n, pipeline: createSpectrumPipeline(ctx) };
}

const packet = floatIq(iqTone(2000, RATE, PACKET, 0.3));

test('one second of IQ: ~12 kHz of audio and one column per hop', () => {
    const { n, pipeline } = makeCtx();
    for (let p = 0; p < 40; p++) pipeline.processRawIQ(packet, PACKET);
    const hop = pipeline.spectrumHopSize();
    assert.equal(hop, Math.floor(2048 / 3));   // above the 200 col/s cap (480 samples at 96 kHz)
    const expected = Math.floor((RATE - 2048) / hop) + 1;
    assert.ok(Math.abs(n.slices - expected) <= 1, `slices ${n.slices}, expected ~${expected}`);
    assert.equal(n.meter, n.slices);
    assert.ok(Math.abs(n.audio - 12000) <= 2, `audio ${n.audio}`);
    assert.equal(n.recorded, 40);
    assert.ok(pipeline.samplesAvailable < 2048);
});

test('the column rate is capped at 200/s, whatever the speed', () => {
    const { ctx, n, pipeline } = makeCtx();
    ctx.state.speedMultiplier = 8;
    for (let p = 0; p < 40; p++) pipeline.processRawIQ(packet, PACKET);
    assert.equal(pipeline.spectrumHopSize(), 480);
    assert.ok(n.slices <= 200 && n.slices >= 190, `slices ${n.slices}`);
});

test('local TX mutes RX: no audio or columns, and each edge resets the buffers once', () => {
    let tx = false;
    const { n, pipeline } = makeCtx({ isLocalTx: () => tx });
    pipeline.processRawIQ(packet, PACKET);
    const audioBefore = n.audio;
    tx = true;
    for (let p = 0; p < 10; p++) pipeline.processRawIQ(packet, PACKET);
    assert.equal(n.audio, audioBefore);
    assert.equal(n.decoderResets, 1);
    assert.equal(n.audioResets, 1);
    assert.equal(pipeline.samplesAvailable, 0);
    tx = false;
    pipeline.processRawIQ(packet, PACKET);
    assert.equal(n.audioResets, 2);
    assert.equal(n.decoderResets, 1);   // RX again: the decoder keeps going
    assert.ok(n.audio > audioBefore);
});

test('a hidden tab demodulates but paints nothing, and the ring index stays in range', () => {
    const { n, pipeline } = makeCtx({ isHidden: () => true });
    for (let p = 0; p < 40; p++) pipeline.processRawIQ(packet, PACKET);
    assert.equal(n.slices, 0);
    assert.ok(n.audio > 11000);
    assert.equal(pipeline.samplesAvailable, SPECTRUM_RING_SIZE);
});

test('power off drops packets entirely', () => {
    const { ctx, n, pipeline } = makeCtx();
    ctx.state.running = false;
    pipeline.processRawIQ(packet, PACKET);
    assert.equal(n.audio, 0);
    assert.equal(n.slices, 0);
});

test('QRSS replaces the wideband columns with its own narrow ones, and restores the view', () => {
    const { ctx, n, pipeline } = makeCtx();
    ctx.waterfall.zoom = 4;
    ctx.waterfall.panOffset = 123;
    pipeline.setQrssEnabled(true);
    assert.equal(ctx.state.qrssEnabled, true);
    assert.equal(typeof ctx.demodulator.qrssPush, 'function');
    assert.equal(ctx.waterfall.zoom, 1);
    for (let p = 0; p < 80; p++) pipeline.processRawIQ(packet, PACKET);   // 2 s
    assert.ok(n.slices > 0, 'QRSS columns');
    assert.ok(n.slices < 20, `no wideband columns (${n.slices})`);
    pipeline.setQrssEnabled(false);
    assert.equal(ctx.demodulator.qrssPush, null);
    assert.deepEqual([ctx.waterfall.zoom, ctx.waterfall.panOffset], [4, 123]);
});
