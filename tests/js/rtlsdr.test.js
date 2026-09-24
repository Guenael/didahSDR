'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { req } = require('./load.js');
const {
    RTL_CAPTURE_RATE, RTL_IQ_RATE, RTL_FS4_HZ, RTL_XTAL_HZ,
    rtlNominalHz, rtlUsesPll, rtlApplyCenter, RtlDecimator,
    rtlNumberToBytes, rtlPickDevice, rtlPllPlan, RtlSdrSource
} = req('rtlsdr.js');
const { findSource } = req('sources.js');

function toneU8(freqHz, nComplex, amp) {
    const u8 = new Uint8Array(nComplex * 2);
    const w = (2 * Math.PI * freqHz) / RTL_CAPTURE_RATE;
    for (let n = 0; n < nComplex; n++) {
        const i = Math.round(127.5 + amp * Math.cos(w * n));
        const q = Math.round(127.5 + amp * Math.sin(w * n));
        u8[n * 2] = Math.max(0, Math.min(255, i));
        u8[n * 2 + 1] = Math.max(0, Math.min(255, q));
    }
    return u8;
}

function runDecim(u8) {
    const dec = new RtlDecimator();
    const dst = new Int16Array(Math.ceil(u8.length / 2 / 8) * 2 + 8);
    const n = dec.process(u8, u8.length, dst);
    return dst.subarray(0, n);
}

function rms(int16, skipComplex) {
    let s = 0;
    let n = 0;
    for (let i = skipComplex * 2; i < int16.length; i++) {
        const v = int16[i];
        s += v * v;
        n++;
    }
    return Math.sqrt(s / Math.max(1, n));
}

/** Amplitude of e^{+j w n} in the interleaved int16 block. */
function toneAmp(int16, freqHz, skipComplex) {
    const n = int16.length / 2 - skipComplex;
    const w = (2 * Math.PI * freqHz) / RTL_IQ_RATE;
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
        const I = int16[(skipComplex + i) * 2];
        const Q = int16[(skipComplex + i) * 2 + 1];
        const c = Math.cos(w * i);
        const s = Math.sin(w * i);
        re += I * c + Q * s;
        im += Q * c - I * s;
    }
    return Math.hypot(re, im) / n;
}

test('catalog lists the RTL-SDR source at 14.048 MHz CW', () => {
    const src = findSource('rtlsdr');
    assert.equal(src.protocol, 'rtlsdr');
    assert.equal(src.startFreq, 14048000);
    assert.equal(src.startMod, 'cw');
    assert.equal(src.fftSize, 2048);
});

test('hardware LO is the dial plus 384 kHz, plus the upconverter', () => {
    assert.equal(rtlNominalHz(14048000, 0), 14048000 + RTL_FS4_HZ);
    assert.equal(rtlNominalHz(145500000, 125000000), 145500000 + 125000000 + RTL_FS4_HZ);
});

test('direct sampling below the crystal does not program the R820T PLL', async () => {
    const nominal = rtlNominalHz(14048000, 0);
    assert.ok(nominal < RTL_XTAL_HZ);
    assert.equal(rtlUsesPll('direct-q', nominal), false);
    assert.equal(rtlUsesPll('direct-i', nominal), false);
    assert.equal(rtlUsesPll('tuner', nominal), true);
    assert.equal(rtlUsesPll('direct-q', rtlNominalHz(14048000, 125000000)), true);

    const calls = [];
    const port = {
        ensureFrontEnd: async (front) => { calls.push('front:' + front); },
        setIfFrequency: async (hz) => { calls.push('if:' + hz); },
        openI2C: async () => { calls.push('open'); },
        closeI2C: async () => { calls.push('close'); },
        setTunerFrequency: async (hz) => { calls.push('pll:' + hz); }
    };
    const direct = await rtlApplyCenter(port, 'direct-q', nominal);
    assert.equal(direct.usePll, false);
    assert.deepEqual(calls, ['front:direct-q', 'if:' + nominal]);

    calls.length = 0;
    const tuned = await rtlApplyCenter(port, 'tuner', 145500000 + RTL_FS4_HZ);
    assert.equal(tuned.usePll, true);
    assert.ok(calls.includes('pll:' + (145500000 + RTL_FS4_HZ)));
    assert.equal(calls.some((c) => c.startsWith('if:')), false);
});

test('demod register words are big-endian, USB register words are little-endian', () => {
    assert.deepEqual(Array.from(rtlNumberToBytes(0x1234, 2, true)), [0x12, 0x34]);
    assert.deepEqual(Array.from(rtlNumberToBytes(0x0200, 2, false)), [0x00, 0x02]);
});

test('fs/4 mix keeps the upper sideband and parks DC on the CIC null', () => {
    const amp = 80;
    const n = RTL_CAPTURE_RATE / 10;
    const skip = 4096;
    const passHz = 9000;
    const passed = runDecim(toneU8(-RTL_FS4_HZ + passHz, n, amp));
    const upper = toneAmp(passed, passHz, skip);
    const image = toneAmp(passed, -passHz, skip);
    assert.ok(upper > 1000, 'expected a strong tone at +' + passHz + ', got ' + upper);
    assert.ok(upper / Math.max(image, 1e-6) > 30, 'image ' + image + ' vs upper ' + upper);

    const dc = rms(runDecim(toneU8(0, n, amp)), skip);
    const passRms = rms(passed, skip);
    assert.ok(passRms / Math.max(dc, 1e-9) > 100, 'DC spike rms ' + dc + ' vs pass ' + passRms);

    const nyquist = rms(runDecim(toneU8(RTL_CAPTURE_RATE * 0.49, n, amp)), skip);
    assert.ok(passRms / Math.max(nyquist, 1e-9) > 30, 'nyquist rms ' + nyquist + ' vs pass ' + passRms);
});

test('CIC compensator keeps ±80 kHz within about 1 dB', () => {
    const amp = 80;
    const n = RTL_CAPTURE_RATE / 10;
    const skip = 4096;
    const offsets = [10000, 40000, 80000];
    const levels = offsets.map((off) => toneAmp(runDecim(toneU8(-RTL_FS4_HZ + off, n, amp)), off, skip));
    const ref = levels[0];
    for (let i = 0; i < levels.length; i++) {
        const db = 20 * Math.log10(levels[i] / ref);
        assert.ok(Math.abs(db) < 1, offsets[i] + ' Hz is ' + db.toFixed(2) + ' dB from 10 kHz');
    }
});

test('CIC N=5 rejects the alias at −384 kHz + 192 kHz − 50 kHz', () => {
    const amp = 80;
    const n = RTL_CAPTURE_RATE / 10;
    const skip = 8192;
    const wantedHz = 50000;
    const wanted = toneAmp(runDecim(toneU8(-RTL_FS4_HZ + wantedHz, n, amp)), wantedHz, skip);
    const aliasIn = runDecim(toneU8(-RTL_FS4_HZ + RTL_IQ_RATE - wantedHz, n, amp));
    const aliasPos = toneAmp(aliasIn, wantedHz, skip);
    const aliasNeg = toneAmp(aliasIn, -wantedHz, skip);
    const alias = Math.max(aliasPos, aliasNeg);
    const db = 20 * Math.log10(wanted / Math.max(alias, 1e-9));
    assert.ok(db >= 40, `alias rejection ${db.toFixed(1)} dB`);
});

test('decimator phase continues across bulk buffers', () => {
    const u8 = toneU8(-RTL_FS4_HZ + 9000, 4096 * 8, 60);
    const one = runDecim(u8);
    const dec = new RtlDecimator();
    const dst = new Int16Array(one.length + 8);
    const mid = u8.length / 2;
    const n1 = dec.process(u8.subarray(0, mid), mid, dst);
    const n2 = dec.process(u8.subarray(mid), u8.length - mid, dst.subarray(n1));
    assert.equal(n1 + n2, one.length);
    for (let i = 0; i < one.length; i++) assert.equal(dst[i], one[i]);
});

test('rtlPllPlan rejects an nint outside 0..63', () => {
    assert.equal(rtlPllPlan(0, 28800000), null);
    assert.equal(rtlPllPlan(4e9, 28800000), null);
    const plan = rtlPllPlan(1.8e9, 28800000);
    assert.ok(plan);
    assert.equal(plan.nint, 31);
    assert.ok(plan.nint >= 0 && plan.nint <= 63);
    assert.equal(plan.ni, Math.floor((31 - 13) / 4));
    assert.equal(plan.si, (31 - 13) % 4);
});

test('rtlPickDevice uses a granted stick and does not open the picker', async () => {
    const stick = { vendorId: 0x0bda, productId: 0x2838 };
    let asked = false;
    const usb = {
        getDevices: async () => [stick, { vendorId: 0x1234, productId: 1 }],
        requestDevice: async () => { asked = true; return null; }
    };
    assert.equal(await rtlPickDevice(usb), stick);
    assert.equal(asked, false);
});

test('rtlPickDevice opens the picker only when nothing granted matches', async () => {
    const picked = { vendorId: 0x0bda, productId: 0x2832 };
    let filters = null;
    const usb = {
        getDevices: async () => [{ vendorId: 0x1111, productId: 0x2222 }],
        requestDevice: async (opts) => { filters = opts.filters; return picked; }
    };
    assert.equal(await rtlPickDevice(usb), picked);
    assert.ok(filters.some((f) => f.vendorId === 0x0bda && f.productId === 0x2832));
});

test('power off then on does not keep the previous USB read loop', async () => {
    const src = new RtlSdrSource({ onRawIQ() {}, onStatusChange() {} });
    let reads = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    src._com = {
        resetBuffer: async () => {},
        readBulk: () => {
            reads++;
            if (reads >= 3) return new Promise(() => {});
            return gate.then(() => new Uint8Array(8));
        }
    };
    src._decimator = { reset() {}, process() { return 0; } };
    src._gen = 1;
    src._stream();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(reads, 1);
    src.stop();
    src._stream();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(reads, 2);
    release();
    await gate;
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(reads, 3, 'only the new generation queues another read');
});

test('tune and gain share one hardware queue', async () => {
    const src = new RtlSdrSource({ onStatusChange() {} });
    const order = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    src._enqueueHw(() => {
        order.push('tune-start');
        return gate.then(() => { order.push('tune-end'); });
    });
    src._enqueueHw(async () => { order.push('gain'); });
    await Promise.resolve();
    assert.deepEqual(order, ['tune-start']);
    release();
    await src._hwChain;
    assert.deepEqual(order, ['tune-start', 'tune-end', 'gain']);
});

test('USB disconnect closes only the open stick', () => {
    const src = new RtlSdrSource({ onStatusChange() {} });
    const device = { vendorId: 0x0bda, productId: 0x2838 };
    let closed = 0;
    src.close = () => { closed++; };
    src._device = device;
    src._handleUsbDisconnect({ device });
    assert.equal(closed, 1);
    src._handleUsbDisconnect({ device: { vendorId: 0x0bda, productId: 0x2838 } });
    assert.equal(closed, 1);
    src._device = null;
    src._handleUsbDisconnect({ device });
    assert.equal(closed, 1);
});
