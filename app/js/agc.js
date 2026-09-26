/**
 * didahSDR - Two-Sided AGC
 *
 * Per sample:
 *   1. Envelope: instant attack, exponential release (release time = AGC speed).
 *   2. Noise floor: supplied from outside (setNoiseRms, once per block) by ChannelNoiseEstimator below,
 *      which reads the noise off the spectrum *outside* the channel passband (Rocky-style). A steady
 *      carrier or dense CW therefore cannot lift it. noiseFloor = NOISE_FLOOR_K * audio noise rms.
 *   3. Knee: Out = MaxOut * (1 - exp(-In / Beta)), Beta = noiseKnee * noiseFloor.
 *      Weak signals just above the noise get more gain than strong ones (the "two-sided" part),
 *      while the noise itself sits at a fixed, modest output level.
 *   4. Gain smoothing (computed every `dec` samples): sliding minimum of length L followed by a
 *      Blackman FIR of the same length L. Audio is delayed by (L+1)*dec samples. Because both filters
 *      share the same length and the delay matches, the smoothed gain applied to a sample is
 *      never greater than that sample's own instantaneous gain: the output cannot exceed MaxOut,
 *      so no limiter is needed.
 *
 * Processes in place. No allocations after construction.
 */

/**
 * noiseFloor / audio noise rms. The previous in-band estimator (min of 100 ms means of a 20 ms-release
 * envelope, peak-hold biased) read ~1.34x the rms in pure noise through the 150 Hz CW channel; 1.38 puts
 * the 150 Hz noise output within 0.1 dB of it. That estimator read 1.6x at 500 Hz and 2.1x in USB,
 * so wide filters now play the noise ~1 dB (500 Hz) and ~3 dB (USB) louder than before.
 */
const NOISE_FLOOR_K = 1.38;

class AGC {
    constructor(sampleRate = 48000) {
        this.sampleRate = sampleRate;
        this.maxOut = 0.95;         // Output envelope target (peak), 95% of full scale
        this.maxGain = 3000.0;      // +70 dB cap. Real IQ signals sit at -50..-90 dBFS after the channel
                                    // filter, so +35 dB left the AGC pinned and the audio quiet. The knee,
                                    // not this cap, keeps dead-band noise at a modest level.
        this.noiseKnee = 4.0;       // Beta = noiseKnee * noiseFloor; larger => noise sits lower

        // Gain is updated at sampleRate / dec; smoothing window fixed at 8 ms (L odd)
        this.dec = 8;
        const subRate = sampleRate / this.dec;
        let L = Math.floor(subRate * 0.008);
        if (L % 2 === 0) L++;
        this.L = L;

        this.weights = new Float32Array(L);
        let sum = 0.0;
        for (let i = 0; i < L; i++) {
            const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (L - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (L - 1));
            this.weights[i] = w;
            sum += w;
        }
        for (let i = 0; i < L; i++) this.weights[i] /= sum;

        this.minBuf = new Float32Array(L).fill(1.0);
        this.firBuf = new Float32Array(L).fill(1.0);
        this.bufIdx = 0;

        // One extra tap covers the linear ramp toward the next gain update
        this.delayLen = (L + 1) * this.dec;
        this.delayBuf = new Float32Array(this.delayLen);
        this.delayIdx = 0;

        this.env = 0.0;
        this.blockPeak = 0.0;     // max |s| since the last gain update
        this.noiseFloor = 1e-3;   // amplitude, NOISE_FLOOR_K * noise rms once setNoiseRms() has run
        this.gPrev = 1.0;
        this.gNext = 1.0;
        this.phase = 0;           // position within the current `dec` interval, persists across calls

        this.setSpeed('medium');
    }

    /** Drop envelope, gain and the delay line. Used when the tune jumps to a new station. */
    reset() {
        this.minBuf.fill(1.0);
        this.firBuf.fill(1.0);
        this.delayBuf.fill(0.0);
        this.bufIdx = 0;
        this.delayIdx = 0;
        this.env = 0.0;
        this.blockPeak = 0.0;
        this.noiseFloor = 1e-3;
        this.gPrev = 1.0;
        this.gNext = 1.0;
        this.phase = 0;
    }

    /** Noise rms of the (pre-AGC) audio, from ChannelNoiseEstimator. Call before process(). */
    setNoiseRms(rms) {
        const f = NOISE_FLOOR_K * rms;
        this.noiseFloor = f > 1e-7 ? f : 1e-7;
    }

    /** 'fast' | 'medium' | 'slow' : envelope release time 40 / 100 / 300 ms */
    setSpeed(speed) {
        const ms = speed === 'fast' ? 40.0 : speed === 'slow' ? 300.0 : 100.0;
        this.decay = Math.exp(-1.0 / (this.sampleRate * ms / 1000.0));
    }

    /**
     * Apply AGC in place.
     * @param {Float32Array} samples - mono audio, modified in place
     * @returns {Float32Array} the same array
     */
    process(samples) {
        const N = samples.length;
        const L = this.L;
        const dec = this.dec;
        const weights = this.weights;
        const minBuf = this.minBuf;
        const firBuf = this.firBuf;
        const delayBuf = this.delayBuf;
        const delayLen = this.delayLen;
        const maxOut = this.maxOut;
        const maxGain = this.maxGain;
        const knee = this.noiseKnee;
        const decay = this.decay;
        const beta = knee * this.noiseFloor;

        let env = this.env;
        let blockPeak = this.blockPeak;
        let bufIdx = this.bufIdx;
        let gPrev = this.gPrev;
        let gNext = this.gNext;
        let phase = this.phase;
        let delayIdx = this.delayIdx;

        for (let i = 0; i < N; i++) {
            const s = samples[i];
            const absS = s < 0 ? -s : s;
            env = absS > env ? absS : env * decay;
            if (absS > blockPeak) blockPeak = absS;

            if (phase === 0) {
                // Block peak (not the decayed envelope) so the gain covers every sample in the block
                let inMag = env > blockPeak ? env : blockPeak;
                if (inMag < 1e-6) inMag = 1e-6;
                blockPeak = 0.0;
                const gInst = Math.min(maxGain, (maxOut * (1.0 - Math.exp(-inMag / beta))) / inMag);

                minBuf[bufIdx] = gInst;
                let gMin = minBuf[0];
                for (let k = 1; k < L; k++) if (minBuf[k] < gMin) gMin = minBuf[k];
                firBuf[bufIdx] = gMin;

                let gFilt = 0.0;
                let r = bufIdx;
                for (let k = 0; k < L; k++) {
                    gFilt += firBuf[r] * weights[k];
                    r = r === 0 ? L - 1 : r - 1;
                }

                gPrev = gNext;
                gNext = gFilt;
                bufIdx = bufIdx === L - 1 ? 0 : bufIdx + 1;
            }

            // Linear ramp between consecutive gain updates
            const g = gPrev + (gNext - gPrev) * ((phase + 1) / dec);
            phase = phase === dec - 1 ? 0 : phase + 1;

            const delayed = delayBuf[delayIdx];
            delayBuf[delayIdx] = s;
            delayIdx = delayIdx === delayLen - 1 ? 0 : delayIdx + 1;

            samples[i] = delayed * g;
        }

        this.env = env;
        this.blockPeak = blockPeak;
        this.bufIdx = bufIdx;
        this.gPrev = gPrev;
        this.gNext = gNext;
        this.phase = phase;
        this.delayIdx = delayIdx;
        return samples;
    }
}

/**
 * Channel noise from the spectrum around the channel (Rocky-style: "estimates the input noise r.m.s. from
 * the spectrum of the unfiltered signal"). Fed the complex baseband *before* the channel FIR, at the channel
 * rate, where the passband is centred on 0 Hz with half-width = the channel cutoff.
 *
 * Every FRAME samples (no overlap): Hann window, complex FFT, |X|², then the median of the bins that are
 *   - outside the passband + guard (cutoff + transition + Hann main lobe), and
 *   - inside min(0.4 fs, 4 kHz): the outer bins hold the source roll-off (Kiwi, IC-7300) and, above 4 kHz,
 *     the aliased transition of the last halfband.
 * A signal in the passband never reaches these bins, and the median ignores the few occupied ones.
 * Median of an exponential = ln2 · mean, so the complex noise variance per sample is
 *   σ² = median / (ln2 · Σw²)
 * and the noise power in the real demodulated audio (channel FIR of unity passband gain, then Re()) is
 *   noisePower = σ² · Σh² / 2.
 * σ² is smoothed in the log domain (~0.5 s); the first estimates after reset() are a running mean, so
 * the value is usable after one frame (~21 ms at 12 kHz). No allocations after setSampleRate/setChannel.
 */
class ChannelNoiseEstimator {
    constructor(sampleRate = 12000, frame = 256) {
        this.N = frame;
        const N = frame;
        let bits = 0;
        while ((1 << bits) < N) bits++;
        this.bitrev = new Uint16Array(N);
        for (let i = 0; i < N; i++) {
            let r = 0;
            for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
            this.bitrev[i] = r;
        }
        this.cosT = new Float32Array(N >> 1);
        this.sinT = new Float32Array(N >> 1);
        for (let k = 0; k < N >> 1; k++) {
            this.cosT[k] = Math.cos((2 * Math.PI * k) / N);
            this.sinT[k] = Math.sin((2 * Math.PI * k) / N);
        }
        this.win = new Float32Array(N);
        let sw2 = 0.0;
        for (let n = 0; n < N; n++) {
            const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N);
            this.win[n] = w;
            sw2 += w * w;
        }
        this.medianScale = 1.0 / (Math.LN2 * sw2);   // median |X|² -> σ²
        this.bufI = new Float32Array(N);
        this.bufQ = new Float32Array(N);
        this.re = new Float32Array(N);
        this.im = new Float32Array(N);
        this.sel = new Float32Array(N);
        this.useBin = new Uint8Array(N);
        this.nUsed = 0;
        this.fill = 0;
        this.cutoff = 0.0;
        this.guard = 0.0;
        this.sumH2 = 1.0;
        this.logSigma2 = 0.0;
        this.frames = 0;
        this.valid = false;
        this.setSampleRate(sampleRate);
    }

    setSampleRate(rate) {
        this.sampleRate = rate;
        this.alphaMin = 1.0 - Math.exp(-this.N / (rate * 0.5));
        this._buildMask();
        this.reset();
    }

    /**
     * @param {number} cutoffHz - channel half-width (passband is ±cutoff around 0 Hz)
     * @param {number} guardHz  - extra exclusion past the cutoff (transition band)
     * @param {Float32Array} taps - channel FIR, unity passband gain; Σh² sets the audio noise power
     */
    setChannel(cutoffHz, guardHz, taps) {
        this.cutoff = cutoffHz;
        this.guard = guardHz;
        let s = 0.0;
        for (let i = 0; i < taps.length; i++) s += taps[i] * taps[i];
        this.sumH2 = s;
        this._buildMask();
    }

    _buildMask() {
        const N = this.N;
        const binHz = this.sampleRate / N;
        const lo = this.cutoff + this.guard + 2 * binHz;   // Hann main lobe is ±2 bins
        const hi = Math.min(0.4 * this.sampleRate, 4000);
        let used = 0;
        for (let k = 0; k < N; k++) {
            const f = Math.abs((k < N / 2 ? k : k - N) * binHz);
            const on = f >= lo && f <= hi ? 1 : 0;
            this.useBin[k] = on;
            used += on;
        }
        this.nUsed = used;
    }

    /** Next frame starts empty and its estimate is taken as is. The last value stays readable. */
    reset() {
        this.fill = 0;
        this.frames = 0;
    }

    /** Complex variance per sample at the channel rate (full-scale units²). */
    get sigma2() { return Math.exp(this.logSigma2); }
    /** Noise power of the real, channel-filtered audio (pre-AGC). */
    get noisePower() { return this.valid ? Math.exp(this.logSigma2) * this.sumH2 * 0.5 : 0.0; }
    get noiseRms() { return Math.sqrt(this.noisePower); }

    /** Pre-channel complex baseband, n samples at the channel rate. */
    process(bi, bq, n) {
        const N = this.N;
        let fill = this.fill;
        for (let i = 0; i < n; i++) {
            this.bufI[fill] = bi[i];
            this.bufQ[fill] = bq[i];
            if (++fill === N) {
                fill = 0;
                this._frame();
            }
        }
        this.fill = fill;
    }

    _frame() {
        const N = this.N;
        const re = this.re, im = this.im, win = this.win, rev = this.bitrev;
        if (this.nUsed < 8) return;
        for (let i = 0; i < N; i++) {
            const j = rev[i];
            re[j] = this.bufI[i] * win[i];
            im[j] = this.bufQ[i] * win[i];
        }
        const cosT = this.cosT, sinT = this.sinT;
        for (let size = 2; size <= N; size <<= 1) {
            const half = size >> 1;
            const step = N / size;
            for (let s = 0; s < N; s += size) {
                for (let k = 0, t = 0; k < half; k++, t += step) {
                    const a = s + k, b = a + half;
                    const wr = cosT[t], wi = -sinT[t];
                    const tr = wr * re[b] - wi * im[b];
                    const ti = wr * im[b] + wi * re[b];
                    re[b] = re[a] - tr;
                    im[b] = im[a] - ti;
                    re[a] += tr;
                    im[a] += ti;
                }
            }
        }
        const sel = this.sel, use = this.useBin;
        let m = 0;
        for (let k = 0; k < N; k++) if (use[k]) sel[m++] = re[k] * re[k] + im[k] * im[k];
        let med = quickselect(sel, m, m >> 1);
        if (!(med > 1e-30)) med = 1e-30;
        const x = Math.log(med * this.medianScale);
        this.frames++;
        const a = Math.max(this.alphaMin, 1.0 / this.frames);
        this.logSigma2 += a * (x - this.logSigma2);   // a = 1 on the first frame
        this.valid = true;
    }
}

/** k-th smallest of a[0..n-1], in place (Hoare selection). */
function quickselect(a, n, k) {
    let lo = 0, hi = n - 1;
    while (hi > lo) {
        const pivot = a[(lo + hi) >> 1];
        let i = lo, j = hi;
        while (i <= j) {
            while (a[i] < pivot) i++;
            while (a[j] > pivot) j--;
            if (i <= j) {
                const t = a[i]; a[i] = a[j]; a[j] = t;
                i++; j--;
            }
        }
        if (k <= j) hi = j;
        else if (k >= i) lo = i;
        else break;
    }
    return a[k];
}

if (typeof module !== 'undefined') {
    module.exports = { AGC, ChannelNoiseEstimator, NOISE_FLOOR_K };
}
