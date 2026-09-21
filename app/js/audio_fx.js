/**
 * didahSDR - RX audio FX (post-BFO / pre-AGC)
 *
 *   Autonotch (NLMS ANF)  : output = error   x − ŷ  (kills steady tones)
 *   Noise Reduction (ANR) : output = prediction ŷ   (keeps correlated CW/SSB)
 *   Squelch               : pre-AGC power meter + post-AGC soft gate
 *
 * No allocations after construction. process()/observe()/gate() skip work when disabled.
 */

function nextPow2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
}

/**
 * Shared NLMS predictor. History is a power-of-two ring so the delayed tap walk is a mask.
 * @param {boolean} keepPrediction  true → ANR (output ŷ); false → ANF (output x − ŷ)
 */
class NlmsPredictor {
    constructor(taps, delay, baseMu, keepPrediction) {
        this.taps = taps;
        this.delay = delay;
        this.baseMu = baseMu;
        this.keepPrediction = keepPrediction;
        this.scale = 1.0;
        this.enabled = false;
        this.weights = new Float32Array(taps);
        const histLen = nextPow2(taps + delay);
        this.history = new Float32Array(histLen);
        this.mask = histLen - 1;
        this.write = 0;
    }

    reset() {
        this.weights.fill(0);
        this.history.fill(0);
        this.write = 0;
    }

    setEnabled(on) {
        const next = !!on;
        if (next && !this.enabled) this.reset();
        this.enabled = next;
    }

    /** @param {number} frac  0.25 … 1.0, scales μ */
    setScale(frac) {
        this.scale = Math.max(0.25, Math.min(1, frac));
    }

    /**
     * In-place. No-op when disabled.
     * @param {Float32Array} buf
     * @param {number} n
     */
    process(buf, n) {
        if (!this.enabled || n <= 0) return buf;
        const weights = this.weights;
        const history = this.history;
        const mask = this.mask;
        const taps = this.taps;
        const delay = this.delay;
        const mu = this.baseMu * this.scale;
        const histLen = history.length;
        const keep = this.keepPrediction;
        let write = this.write;
        let bad = false;

        for (let i = 0; i < n; i++) {
            let x = buf[i];
            if (!Number.isFinite(x)) x = 0.0;
            write = (write + 1) & mask;
            history[write] = x;

            const base = write + histLen - delay;
            let predicted = 0.0;
            let refP = 0.0;
            for (let k = 0; k < taps; k++) {
                const r = history[(base - k) & mask];
                predicted += weights[k] * r;
                refP += r * r;
            }
            const error = x - predicted;
            const step = mu * error / (refP + 1e-6);
            for (let k = 0; k < taps; k++) {
                weights[k] += step * history[(base - k) & mask];
            }
            const y = keep ? predicted : error;
            if (Number.isFinite(y)) buf[i] = y;
            else {
                buf[i] = 0.0;
                bad = true;
            }
        }
        this.write = write;
        if (bad) this.reset();
        return buf;
    }
}

class DidahAutoNotch {
    constructor() {
        this._lms = new NlmsPredictor(64, 4, 0.02, false);
        this.setDepth(70);
    }

    get enabled() { return this._lms.enabled; }

    reset() { this._lms.reset(); }

    setEnabled(on) { this._lms.setEnabled(on); }

    /** Operator depth 25–100 (% of base μ). */
    setDepth(pct) { this._lms.setScale(pct / 100); }

    process(buf, n) { return this._lms.process(buf, n); }
}

class DidahNoiseReduction {
    constructor() {
        this._lms = new NlmsPredictor(32, 2, 0.01, true);
        this.setStrength(50);
    }

    get enabled() { return this._lms.enabled; }

    reset() { this._lms.reset(); }

    setEnabled(on) { this._lms.setEnabled(on); }

    /** Operator strength 25–100 (% of base μ). */
    setStrength(pct) { this._lms.setScale(pct / 100); }

    process(buf, n) { return this._lms.process(buf, n); }
}

class DidahSquelch {
    constructor(sampleRate = 48000) {
        this.enabled = false;
        this.marginDb = 10;
        this.hysteresisDb = 6;
        this.fadeSec = 0.008;
        this.hangCw = 0.4;
        this.hangSsb = 0.15;
        this.hangSec = this.hangCw;
        this.power = 0.0;
        this.open = false;
        this.below = 0;
        this.gain = 0.0;
        this.marginLin = 1.0;
        this.hysteresisLin = 1.0;
        this.setSampleRate(sampleRate);
        this._recompute();
    }

    setSampleRate(rate) {
        this.sampleRate = Math.max(1000, rate);
        this.powerCoeff = 1.0 - Math.exp(-1.0 / (this.sampleRate * 0.001));
        this.holdSamples = Math.max(1, Math.round(this.hangSec * this.sampleRate));
        this.fadeSamples = Math.max(1, Math.round(this.fadeSec * this.sampleRate));
        this.fadeStep = 1.0 / this.fadeSamples;
    }

    setHangForMode(mod) {
        const m = String(mod || 'cw').toLowerCase();
        this.hangSec = (m === 'usb' || m === 'lsb') ? this.hangSsb : this.hangCw;
        this.holdSamples = Math.max(1, Math.round(this.hangSec * this.sampleRate));
    }

    /** Open when pre-AGC power is this many dB above the AGC noise floor (0–40). */
    setMarginDb(db) {
        this.marginDb = Math.max(0, Math.min(40, db));
        this._recompute();
    }

    setEnabled(on) {
        const next = !!on;
        if (next && !this.enabled) this.reset();
        this.enabled = next;
    }

    reset() {
        this.power = 0.0;
        this.open = false;
        this.below = 0;
        this.gain = 0.0;
    }

    _recompute() {
        this.marginLin = Math.pow(10, this.marginDb / 10);
        this.hysteresisLin = Math.pow(10, -this.hysteresisDb / 10);
    }

    /**
     * Track pre-AGC mean-square power against AGC envelope noiseFloor (amplitude).
     * Open when power >= floor² · 10^(margin/10).
     */
    observe(buf, n, noiseFloor) {
        if (!this.enabled || n <= 0) return;
        const floorAmp = noiseFloor > 1e-7 ? noiseFloor : 1e-7;
        const openLin = floorAmp * floorAmp * this.marginLin;
        const closeLin = openLin * this.hysteresisLin;
        const c = this.powerCoeff;
        const hold = this.holdSamples;
        let p = this.power;
        let open = this.open;
        let below = this.below;
        for (let i = 0; i < n; i++) {
            const x = buf[i];
            p += c * (x * x - p);
            if (p >= openLin) {
                open = true;
                below = 0;
            } else if (p < closeLin) {
                below++;
                if (below >= hold) open = false;
            } else {
                below = 0;
            }
        }
        this.power = p;
        this.open = open;
        this.below = below;
    }

    /** Soft-mute post-AGC audio toward 0 (closed) or 1 (open). */
    gate(buf, n) {
        if (!this.enabled || n <= 0) return buf;
        const target = this.open ? 1.0 : 0.0;
        const step = this.fadeStep;
        let g = this.gain;
        for (let i = 0; i < n; i++) {
            if (g < target) {
                g += step;
                if (g > target) g = target;
            } else if (g > target) {
                g -= step;
                if (g < target) g = target;
            }
            buf[i] *= g;
        }
        this.gain = g;
        return buf;
    }
}

if (typeof module !== 'undefined') {
    module.exports = { DidahAutoNotch, DidahNoiseReduction, DidahSquelch, NlmsPredictor };
}
