/**
 * didahSDR - single-producer single-consumer audio ring in a SharedArrayBuffer.
 *
 * The main thread writes demod samples; the audio worklet reads them. Indices are
 * Int32 atomics. Float samples are published before the write index, so the reader
 * never sees a half-written frame. Transfer via postMessage remains the fallback
 * when SharedArrayBuffer is unavailable.
 */

const SAB_CAP = 16384; // power of two, ~1.3 s at 12 kHz

function createSabRing() {
    const sab = new SharedArrayBuffer(8 + SAB_CAP * 4);
    return {
        sab,
        ctrl: new Int32Array(sab, 0, 2),
        data: new Float32Array(sab, 8, SAB_CAP),
        mask: SAB_CAP - 1
    };
}

function sabViews(sab) {
    return {
        sab,
        ctrl: new Int32Array(sab, 0, 2),
        data: new Float32Array(sab, 8, SAB_CAP),
        mask: SAB_CAP - 1
    };
}

/** Copy `samples` into the ring. Returns how many were stored. */
function sabWrite(ring, samples) {
    const ctrl = ring.ctrl;
    const data = ring.data;
    const mask = ring.mask;
    const cap = mask + 1;
    const w = Atomics.load(ctrl, 0);
    const r = Atomics.load(ctrl, 1);
    const free = cap - (w - r) - 1;
    const n = samples.length < free ? samples.length : (free > 0 ? free : 0);
    for (let i = 0; i < n; i++) data[(w + i) & mask] = samples[i];
    if (n) Atomics.store(ctrl, 0, w + n);
    return n;
}

/** Copy up to `dst.length` samples into `dst`. Returns the count. */
function sabRead(ring, dst) {
    const ctrl = ring.ctrl;
    const data = ring.data;
    const mask = ring.mask;
    const cap = mask + 1;
    const w = Atomics.load(ctrl, 0);
    let r = Atomics.load(ctrl, 1);
    let avail = w - r;
    if (avail > cap) {
        r = w - (cap >> 1);
        avail = w - r;
    }
    let n = avail < dst.length ? avail : dst.length;
    if (n < 0) n = 0;
    for (let i = 0; i < n; i++) dst[i] = data[(r + i) & mask];
    if (n) Atomics.store(ctrl, 1, r + n);
    return n;
}

if (typeof globalThis !== 'undefined') {
    globalThis.createSabRing = createSabRing;
    globalThis.sabViews = sabViews;
    globalThis.sabWrite = sabWrite;
    globalThis.sabRead = sabRead;
    globalThis.SAB_CAP = SAB_CAP;
}
if (typeof module !== 'undefined') {
    module.exports = { createSabRing, sabViews, sabWrite, sabRead, SAB_CAP };
}
