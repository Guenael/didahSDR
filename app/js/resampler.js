/**
 * didahSDR - Polyphase windowed-sinc resampler
 *
 * 16 taps, 64 phases, linear interpolation between adjacent phases.
 * Used by the audio worklet (real, any ratio) and by the CW decoder when the
 * channel rate is not a multiple of 800 Hz (complex, typically 11025 → 12000).
 * No allocations on the per-sample path after the first buffer grow.
 */

const POLY_TAPS = 16;
const POLY_PHASES = 64;
const POLY_CENTER = 7;

function polyBesselI0(x) {
    let sum = 1.0, term = 1.0, k = 1;
    const y = (x * x) / 4.0;
    while (term > 1e-12 * sum) {
        term *= y / (k * k);
        sum += term;
        k++;
    }
    return sum;
}

/**
 * Prototype rows: index p (0..64) is the fractional input position p/64.
 * Row 64 is the frac=1 endpoint so phase 63 can blend toward the next sample.
 * Each row sums to 1 (unity DC gain). Cutoff sits 10% below the lower Nyquist.
 * @returns {Float32Array}
 */
function designPolyphase(inRate, outRate) {
    const inR = Math.max(1, inRate);
    const outR = Math.max(1, outRate);
    const fc = 0.45 * Math.min(1, outR / inR);
    const beta = 5.653026; // Kaiser β for ~60 dB
    const i0b = polyBesselI0(beta);
    const rows = POLY_PHASES + 1;
    const h = new Float32Array(rows * POLY_TAPS);
    const half = POLY_TAPS / 2;
    for (let p = 0; p < rows; p++) {
        const frac = p / POLY_PHASES;
        const base = p * POLY_TAPS;
        let sum = 0;
        for (let k = 0; k < POLY_TAPS; k++) {
            const t = k - POLY_CENTER - frac;
            const s = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t);
            const wpos = t / half;
            const w = (wpos > -1 && wpos < 1)
                ? polyBesselI0(beta * Math.sqrt(1 - wpos * wpos)) / i0b
                : 0;
            const c = s * w;
            h[base + k] = c;
            sum += c;
        }
        if (sum !== 0) {
            for (let k = 0; k < POLY_TAPS; k++) h[base + k] /= sum;
        }
    }
    return h;
}

/**
 * Streaming complex resampler. I and Q share one phase so they cannot drift apart.
 * `process` writes `outI`/`outQ` and returns the number of output samples.
 */
class ComplexPolyphase {
    constructor(inRate, outRate) {
        this.inRate = inRate;
        this.outRate = outRate;
        this.step = inRate / outRate;
        this.h = designPolyphase(inRate, outRate);
        this.RING = 8192;
        this.ringI = new Float32Array(this.RING);
        this.ringQ = new Float32Array(this.RING);
        this.write = 0;
        this.pos = 0;
        this.primed = 0;
        this.outI = new Float32Array(0);
        this.outQ = new Float32Array(0);
        this.outN = 0;
    }

    reset() {
        this.ringI.fill(0);
        this.ringQ.fill(0);
        this.write = 0;
        this.pos = 0;
        this.primed = 0;
        this.outN = 0;
    }

    process(iArr, qArr, n) {
        const expect = Math.ceil(n / this.step) + POLY_TAPS;
        if (this.outI.length < expect) {
            this.outI = new Float32Array(expect);
            this.outQ = new Float32Array(expect);
        }
        const h = this.h;
        const ringI = this.ringI;
        const ringQ = this.ringQ;
        const R = this.RING;
        const step = this.step;
        const outI = this.outI;
        const outQ = this.outQ;
        const lookahead = POLY_TAPS / 2;
        let write = this.write;
        let pos = this.pos;
        let primed = this.primed;
        let o = 0;
        for (let s = 0; s < n; s++) {
            ringI[write] = iArr[s];
            ringQ[write] = qArr[s];
            write = write === R - 1 ? 0 : write + 1;
            if (primed < lookahead) {
                primed++;
                continue;
            }
            let ahead = write - pos;
            if (ahead < 0) ahead += R;
            while (ahead > lookahead && o < expect) {
                const i0 = Math.floor(pos);
                const frac = pos - i0;
                let p0 = Math.floor(frac * POLY_PHASES);
                let blend = frac * POLY_PHASES - p0;
                if (p0 >= POLY_PHASES) {
                    p0 = POLY_PHASES - 1;
                    blend = 1;
                }
                const row0 = p0 * POLY_TAPS;
                const row1 = row0 + POLY_TAPS;
                let aI = 0, aQ = 0, bI = 0, bQ = 0;
                for (let k = 0; k < POLY_TAPS; k++) {
                    let idx = i0 - POLY_CENTER + k;
                    if (idx >= R) idx -= R;
                    else if (idx < 0) idx += R;
                    const xi = ringI[idx];
                    const xq = ringQ[idx];
                    const c0 = h[row0 + k];
                    const c1 = h[row1 + k];
                    aI += c0 * xi;
                    aQ += c0 * xq;
                    bI += c1 * xi;
                    bQ += c1 * xq;
                }
                outI[o] = aI + (bI - aI) * blend;
                outQ[o] = aQ + (bQ - aQ) * blend;
                o++;
                pos += step;
                if (pos >= R) pos -= R;
                ahead = write - pos;
                if (ahead < 0) ahead += R;
            }
        }
        this.write = write;
        this.pos = pos;
        this.primed = primed;
        this.outN = o;
        return o;
    }
}

if (typeof globalThis !== 'undefined') {
    globalThis.designPolyphase = designPolyphase;
    globalThis.ComplexPolyphase = ComplexPolyphase;
    globalThis.POLY_TAPS = POLY_TAPS;
    globalThis.POLY_PHASES = POLY_PHASES;
    globalThis.POLY_CENTER = POLY_CENTER;
}
if (typeof module !== 'undefined') {
    module.exports = { designPolyphase, ComplexPolyphase, POLY_TAPS, POLY_PHASES, POLY_CENTER };
}
