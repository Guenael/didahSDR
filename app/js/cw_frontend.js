/**
 * didahSDR - CW decoder front end (streaming). Mirrors training/didahcw/frontend.py exactly;
 * the contract is training/spec/didahcw_frontend.json and a fixture test enforces parity.
 *
 *   complex baseband (post channel filter, pre BFO/AGC) at the decoder rate (a multiple of 800 Hz, ~12 kHz)
 *     -> polyphase Kaiser FIR decimator to 800 Hz complex
 *     -> 64-pt periodic-Hann STFT, hop 8 (10 ms), fftshift, 33 centre bins (±200 Hz)
 *     -> ln(|X| + 1e-6) minus an EMA of the per-frame median (noise floor)
 *
 * Runs inside cw_decoder_worker.js (importScripts) and in Node for tests. Needs `kaiserNumTaps`,
 * `designLowpass` and `ComplexFIR` (demodulator.js, same formulas as didahcw/dsp.py) and `DidahFFT`
 * (fft.js) as globals. No allocations after construction.
 */

const CW_FRONTEND_SPEC = {
    complexRate: 800,
    decimCutoffHz: 350.0,
    decimTransitionHz: 100.0,
    decimAttenDb: 60.0,
    nfft: 64,
    hop: 8,
    bins: 33,
    binOffset: 16,
    logEps: 1e-6,
    floorAlpha: 0.005,
    // Context and lookahead are model properties: the worker reads them from models/didahcw_v1_rc1.onnx.json.
};

class CWFrontend {
    /**
     * @param {number} inRate  - baseband sample rate (must be an integer multiple of 800)
     * @param {number} capacityFrames - size of the output frame ring
     */
    constructor(inRate, capacityFrames = 4096) {
        const S = CW_FRONTEND_SPEC;
        this.spec = S;
        this.setInputRate(inRate);

        this.nfft = S.nfft;
        this.hop = S.hop;
        this.bins = S.bins;
        // 800 Hz sample ring (double length so a frame is a contiguous slice)
        this.xI = new Float32Array(2 * S.nfft);
        this.xQ = new Float32Array(2 * S.nfft);
        this.xPos = 0;
        this.sinceFrame = 0;
        this.filled = 0;
        this.window = new Float32Array(S.nfft);
        for (let n = 0; n < S.nfft; n++) this.window[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / S.nfft);
        this.fft = new DidahFFT(S.nfft);
        this.fr = new Float32Array(S.nfft);
        this.fi = new Float32Array(S.nfft);
        this.scratch = new Float32Array(S.bins);
        this.floor = 0.0;
        this.hasFloor = false;

        this.capacity = capacityFrames;
        this.frames = new Float32Array(capacityFrames * S.bins);
        this.frameCount = 0; // total frames ever produced (frame k lives at (k % capacity) * bins)
    }

    /** (Re)build the decimator for a new input rate. Resets the decimator state only. */
    setInputRate(inRate) {
        const S = this.spec;
        if (inRate % S.complexRate !== 0) throw new Error(`CWFrontend: ${inRate} is not a multiple of ${S.complexRate}`);
        this.inRate = inRate;
        this.R = inRate / S.complexRate;
        const N = kaiserNumTaps(S.decimAttenDb, S.decimTransitionHz, inRate);
        this.h = designLowpass(N, S.decimCutoffHz, inRate, S.decimAttenDb);
        this.N = N;
        this.decim = new ComplexFIR(this.h, false);
        this.phase = 0;
    }

    reset() {
        if (this.decim) this.decim.reset();
        this.phase = 0;
        this.xI.fill(0); this.xQ.fill(0); this.xPos = 0; this.sinceFrame = 0; this.filled = 0;
        this.floor = 0.0; this.hasFloor = false;
        this.frameCount = 0;
    }

    /**
     * Push `n` complex baseband samples. Returns the number of new frames produced.
     * @param {Float32Array} iArr @param {Float32Array} qArr @param {number} n
     */
    process(iArr, qArr, n) {
        const R = this.R;
        let produced = 0;
        if (R === 1) {
            // Already at 800 Hz: no decimation filter (the Python reference skips it too)
            for (let k = 0; k < n; k++) produced += this._push800(iArr[k], qArr[k]);
            return produced;
        }
        const fir = this.decim;
        let phase = this.phase;
        for (let k = 0; k < n; k++) {
            fir.push(iArr[k], qArr[k]);
            if (phase === 0) {
                fir.compute();
                produced += this._push800(fir.outI, fir.outQ);
            }
            phase = phase === R - 1 ? 0 : phase + 1;
        }
        this.phase = phase;
        return produced;
    }

    /** One 800 Hz complex sample in; maybe one frame out. */
    _push800(i, q) {
        const nfft = this.nfft;
        this.xI[this.xPos] = this.xI[this.xPos + nfft] = i;
        this.xQ[this.xPos] = this.xQ[this.xPos + nfft] = q;
        this.xPos = this.xPos === nfft - 1 ? 0 : this.xPos + 1;
        if (this.filled < nfft) { this.filled++; if (this.filled < nfft) return 0; this.sinceFrame = 0; return this._frame(); }
        this.sinceFrame++;
        if (this.sinceFrame < this.hop) return 0;
        this.sinceFrame = 0;
        return this._frame();
    }

    _frame() {
        const nfft = this.nfft, w = this.window, fr = this.fr, fi = this.fi;
        const base = this.xPos; // oldest sample of the current 64
        for (let n = 0; n < nfft; n++) {
            fr[n] = this.xI[base + n] * w[n];
            fi[n] = this.xQ[base + n] * w[n];
        }
        this.fft.transform(fr, fi);
        const S = this.spec, bins = this.bins, half = nfft >> 1, eps = S.logEps;
        const out = this.frames, o = (this.frameCount % this.capacity) * bins, sc = this.scratch;
        for (let b = 0; b < bins; b++) {
            // fftshift: shifted index s = binOffset + b  ->  raw index (s + half) % nfft
            const r = (S.binOffset + b + half) % nfft;
            const v = Math.log(Math.sqrt(fr[r] * fr[r] + fi[r] * fi[r]) + eps);
            out[o + b] = v;
            sc[b] = v;
        }
        // median of 33 via insertion sort on the scratch copy
        for (let a = 1; a < bins; a++) {
            const v = sc[a]; let j = a - 1;
            while (j >= 0 && sc[j] > v) { sc[j + 1] = sc[j]; j--; }
            sc[j + 1] = v;
        }
        const med = sc[bins >> 1];
        if (!this.hasFloor) { this.floor = med; this.hasFloor = true; }
        this.floor += S.floorAlpha * (med - this.floor);
        const fl = this.floor;
        for (let b = 0; b < bins; b++) out[o + b] -= fl;
        this.frameCount++;
        return 1;
    }

    /**
     * Copy frames [from, to) into `dst` at frame offset `dstFrame`.
     * The ring is walked in at most two contiguous runs (one more if the request
     * is longer than the ring). No per-frame view.
     */
    copyFrames(from, to, dst, dstFrame = 0) {
        const bins = this.bins;
        const cap = this.capacity;
        let left = to - from;
        if (left <= 0) return;
        const frames = this.frames;
        let idx = from % cap;
        if (idx < 0) idx += cap;
        let dstOff = dstFrame * bins;
        while (left > 0) {
            const run = left < cap - idx ? left : cap - idx;
            const src = idx * bins;
            const count = run * bins;
            dst.set(frames.subarray(src, src + count), dstOff);
            dstOff += count;
            left -= run;
            idx = 0;
        }
    }
}

if (typeof module !== 'undefined') module.exports = { CWFrontend, CW_FRONTEND_SPEC };

/**
 * Greedy CTC collapse of log-probs [T, C] (flat Float32Array, row-major). `prev` is the last emitted
 * class carried across chunk boundaries (null = blank). Returns { text, prev, frames }, where
 * frames[k] is the step (0..T-1) at which text[k] was emitted.
 */
function ctcGreedy(logProbs, T, C, chars, blank, prev = null) {
    let text = '';
    const frames = [];
    for (let t = 0; t < T; t++) {
        const o = t * C;
        let best = 0, bv = logProbs[o];
        for (let c = 1; c < C; c++) if (logProbs[o + c] > bv) { bv = logProbs[o + c]; best = c; }
        if (best === blank) { prev = null; continue; }
        if (best !== prev) {
            text += chars[best];
            frames.push(t);
        }
        prev = best;
    }
    return { text, prev, frames };
}

if (typeof module !== 'undefined') module.exports.ctcGreedy = ctcGreedy;
