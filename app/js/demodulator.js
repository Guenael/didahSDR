/**
 * didahSDR - Client-Side CW / SSB Demodulator ("filter method")
 *
 * Signal path, per complex IQ sample:
 *   1. NCO      : phasor, shifts the passband centre to DC. Renormalised once per packet.
 *   2. Halfbands: cascade of 2:1 stages down to the channel rate (CH_RATE ≥ ~11 kHz;
 *                 48/96/192 kHz land on 12 kHz, the 44.1 kHz family on 11.025 kHz).
 *                 Even taps of an fs/4 windowed sinc are zero and are skipped.
 *   3. Channel  : real-coefficient Kaiser lowpass on I and Q. Tap count comes from a
 *                 340 Hz transition at −60 dB (about 129 taps at 12 kHz), so the
 *                 selectivity does not depend on the source rate. This is the sideband selection.
 *   4. BFO      : phasor rotate by +pitch (CW) or the SSB passband centre, then Re().
 *   5. Autonotch / NR (optional, real audio, in place). SSB only: in a CW channel the noise is as
 *      predictable as the tone, so NR cannot tell them apart, and a CW dit is a tone the notch would dig out.
 *   6. AGC (in place). Reset when the tune jumps by more than LARGE_RETUNE_HZ.
 *   7. Squelch gate (optional; power is measured on the pre-AGC buffer).
 *   A tap on the stage-3 output (complex, pre-BFO, pre-AGC) feeds the CW decoder.
 *
 * Image rejection is set by the channel filter stopband (~60 dB).
 * No allocations per packet.
 */

/** Lowest channel rate a halfband stage may produce. 44.1 kHz / 4 = 11025 sits just under 12 kHz. */
const CH_RATE_MIN = 11000;
/**
 * Channel-filter transition at −60 dB. Matches training didahcw/dsp.py.
 * A 170 Hz transition (~255 taps at 12 kHz) is sharper; leave it until decoder CER is checked.
 */
const CH_TRANSITION_HZ = 340;
const CH_ATTEN_DB = 60;
/** Offset step that drops the AGC memory. A wheel tick is smaller than this; a new station is not. */
const LARGE_RETUNE_HZ = 100;

/** Odd Kaiser tap count. Same formula as cw_frontend.js and didahcw/dsp.py. */
function kaiserNumTaps(attenDb, transitionHz, fs) {
    const dw = (2.0 * Math.PI * transitionHz) / fs;
    const n = Math.ceil((attenDb - 8.0) / (2.285 * dw)) + 1;
    return n % 2 === 1 ? n : n + 1;
}

/**
 * How many 2:1 halfbands bring `iqRate` down to CH_RATE.
 * 192/96/48 kHz → 12 kHz. 44.1 kHz → 11.025 kHz. ~12 kHz (Kiwi) is already there.
 */
function channelPlan(iqRate) {
    let rate = iqRate;
    let stages = 0;
    while (stages < 6 && rate >= CH_RATE_MIN * 2) {
        rate /= 2;
        stages++;
    }
    return { rate, stages, decim: 1 << stages };
}

/** Kaiser windowed-sinc lowpass, unity DC gain. numTaps must be odd. */
function designLowpass(numTaps, cutoffHz, fs, attenDb = 60) {
    const besselI0 = (x) => {
        let sum = 1.0, term = 1.0, k = 1;
        const y = (x * x) / 4.0;
        while (term > 1e-12 * sum) {
            term *= y / (k * k);
            sum += term;
            k++;
        }
        return sum;
    };
    const beta = attenDb > 50 ? 0.1102 * (attenDb - 8.7)
        : attenDb > 21 ? 0.5842 * Math.pow(attenDb - 21, 0.4) + 0.07886 * (attenDb - 21) : 0.0;
    const M = (numTaps - 1) / 2;
    const wc = (2.0 * Math.PI * cutoffHz) / fs;
    const h = new Float32Array(numTaps);
    const i0Beta = besselI0(beta);
    let sum = 0.0;
    for (let n = 0; n < numTaps; n++) {
        const k = n - M;
        const sinc = k === 0 ? wc / Math.PI : Math.sin(wc * k) / (Math.PI * k);
        const r = k / M;
        h[n] = sinc * besselI0(beta * Math.sqrt(Math.max(0, 1.0 - r * r))) / i0Beta;
        sum += h[n];
    }
    for (let n = 0; n < numTaps; n++) h[n] /= sum;
    return h;
}

/**
 * Halfband length whose end taps are the non-zero (odd) offsets: N ≡ 3 (mod 4).
 * Passband stays flat through 4 kHz, which covers the widest SSB filter.
 * High-rate stages land near 7–15 taps; the last 24 kHz stage is longer.
 */
function halfbandTaps(fs) {
    const fpass = 4000;
    let tw = fs / 2 - 2 * fpass;
    if (tw < fs * 0.05) tw = fs * 0.05;
    let n = kaiserNumTaps(CH_ATTEN_DB, tw, fs);
    if (n < 7) n = 7;
    if (n > 63) n = 63;
    while ((n % 4) !== 3) n++;
    if (n > 63) n -= 4;
    return n;
}

/** fs/4 lowpass with the even offsets forced to 0 (they are already ~1e-17). */
function designHalfband(fs) {
    const n = halfbandTaps(fs);
    const h = designLowpass(n, fs / 4, fs, CH_ATTEN_DB);
    const mid = (n - 1) >> 1;
    for (let k = 2; k <= mid; k += 2) {
        h[mid - k] = 0;
        h[mid + k] = 0;
    }
    return h;
}

/**
 * FIR with real, symmetric taps on a complex signal. The dot product folds each pair
 * into one multiply. Halfband mode also skips the zero even offsets.
 * Double-length history so the window is contiguous.
 */
class ComplexFIR {
    constructor(taps, halfband) {
        this.setTaps(taps, halfband);
    }

    setTaps(taps, halfband) {
        if (!this.h || this.h.length !== taps.length) {
            const N = taps.length;
            this.bufI = new Float32Array(2 * N);
            this.bufQ = new Float32Array(2 * N);
            this.pos = 0;
        }
        this.h = taps;
        this.N = taps.length;
        this.mid = (this.N - 1) >> 1;
        this.halfband = !!halfband;
        this.outI = 0.0;
        this.outQ = 0.0;
    }

    reset() {
        if (this.bufI) this.bufI.fill(0);
        if (this.bufQ) this.bufQ.fill(0);
        this.pos = 0;
        this.outI = 0.0;
        this.outQ = 0.0;
    }

    push(i, q) {
        const p = this.pos;
        this.bufI[p] = this.bufI[p + this.N] = i;
        this.bufQ[p] = this.bufQ[p + this.N] = q;
        this.pos = p === this.N - 1 ? 0 : p + 1;
    }

    /** Output for the most recently pushed sample. */
    compute() {
        const h = this.h;
        const bi = this.bufI;
        const bq = this.bufQ;
        const mid = this.mid;
        const base = this.pos + mid;
        let accI = h[mid] * bi[base];
        let accQ = h[mid] * bq[base];
        // Halfband: odd offsets from the centre are the non-zero taps.
        const step = this.halfband ? 2 : 1;
        for (let k = 1; k <= mid; k += step) {
            const hk = h[mid - k];
            const i0 = base - k;
            const i1 = base + k;
            accI += hk * (bi[i0] + bi[i1]);
            accQ += hk * (bq[i0] + bq[i1]);
        }
        this.outI = accI;
        this.outQ = accQ;
    }
}

class DidahDemodulator {
    constructor(sampleRate = 96000) {
        this.iqRate = sampleRate;
        const plan = channelPlan(sampleRate);
        this.stages = plan.stages;
        this.decim = plan.decim;
        this.decimate2 = this.decim >= 2;
        this.audioRate = plan.rate; // channel rate; the worklet resamples to the context rate

        this.offsetFreq = 0.0;
        this.modulation = 'cw';
        this.cwBandwidth = 150.0;
        this.bfoPitch = 700.0;

        this.ncoC = 1.0;
        this.ncoS = 0.0;
        this.bfoC = 1.0;
        this.bfoS = 0.0;
        this.ncoStepC = 1.0;
        this.ncoStepS = 0.0;
        this.bfoStepC = 1.0;
        this.bfoStepS = 0.0;

        this.hbs = [];
        this.hbFill = [0, 0, 0, 0, 0, 0];
        for (let s = 0; s < 6; s++) this.hbs.push(new ComplexFIR(designHalfband(48000), true));
        this._rebuildHalfbands();

        this.channel = new ComplexFIR(new Float32Array([1]));
        this.channelCutoff = -1;

        this.agcSpeed = 'medium';
        this.agc = new AGC(this.audioRate);

        this.autoNotch = new DidahAutoNotch(this.audioRate);
        this.nr = new DidahNoiseReduction(this.audioRate);
        this.squelch = new DidahSquelch(this.audioRate);

        this.audioOut = new Float32Array(0);
        this.tapCallback = null;
        this.qrssPush = null;
        this.tapI = new Float32Array(0);
        this.tapQ = new Float32Array(0);

        this.updateFilters();
    }

    _rebuildHalfbands() {
        let fs = this.iqRate;
        for (let s = 0; s < this.stages; s++) {
            this.hbs[s].setTaps(designHalfband(fs), true);
            this.hbs[s].reset();
            this.hbFill[s] = 0;
            fs *= 0.5;
        }
        for (let s = this.stages; s < this.hbFill.length; s++) this.hbFill[s] = 0;
    }

    /**
     * Rebuild the NCO / halfband / channel chain for a new IQ sample rate.
     * The channel rate stays near 12 kHz for every source the app tunes.
     */
    setIqRate(iqRate) {
        const rate = Math.max(1000, iqRate);
        const plan = channelPlan(rate);
        if (rate === this.iqRate && plan.stages === this.stages) return;
        this.iqRate = rate;
        this.stages = plan.stages;
        this.decim = plan.decim;
        this.decimate2 = this.decim >= 2;
        const audioRate = plan.rate;
        const rateChanged = audioRate !== this.audioRate;
        if (rateChanged) {
            this.audioRate = audioRate;
            this.agc = new AGC(this.audioRate);
            this.agc.setSpeed(this.agcSpeed);
            this.squelch.setSampleRate(this.audioRate);
            this.autoNotch.setSampleRate(this.audioRate);
            this.nr.setSampleRate(this.audioRate);
            this.channelCutoff = -1;
        }
        this._rebuildHalfbands();
        this.updateFilters();
        if (rateChanged) this.channel.reset();
        this._resetAudioFx();
    }

    setAgcSpeed(speed) {
        this.agcSpeed = speed;
        this.agc.setSpeed(speed);
    }

    /**
     * Set any subset of the tuning parameters and rebuild the NCO/BFO/filter state once.
     * @param {{offsetFreq?: number, modulation?: string, cwBandwidth?: number, bfoPitch?: number}} p
     */
    configure(p) {
        const prevOffset = this.offsetFreq;
        const prevMod = this.modulation;
        if (p.offsetFreq !== undefined) this.offsetFreq = p.offsetFreq;
        if (p.modulation !== undefined) this.modulation = p.modulation.toLowerCase();
        if (p.cwBandwidth !== undefined) this.cwBandwidth = Math.max(CW_BW_MIN, Math.min(CW_BW_MAX, p.cwBandwidth));
        if (p.bfoPitch !== undefined) this.bfoPitch = Math.max(300, Math.min(1200, p.bfoPitch));
        this.updateFilters();
        this.squelch.setHangForMode(this.modulation);
        const modeChanged = this.modulation !== prevMod;
        const jump = p.offsetFreq !== undefined && Math.abs(this.offsetFreq - prevOffset) > LARGE_RETUNE_HZ;
        // A wheel tick must not wipe the NLMS weights. Mode changes and large retunes do.
        if (modeChanged || jump) this._resetAudioFx();
        if (jump) this.agc.reset();
    }

    /** @param {number} freq - tuned frequency relative to the IQ centre, Hz */
    setOffsetFrequency(freq) {
        const prev = this.offsetFreq;
        this.offsetFreq = freq;
        this.updateFilters();
        if (Math.abs(freq - prev) > LARGE_RETUNE_HZ) {
            this._resetAudioFx();
            this.agc.reset();
        }
    }

    setModulation(mod) {
        this.modulation = mod.toLowerCase();
        this.updateFilters();
        this.squelch.setHangForMode(this.modulation);
        this._resetAudioFx();
    }

    setCwBandwidth(bw) {
        this.cwBandwidth = Math.max(CW_BW_MIN, Math.min(CW_BW_MAX, bw));
        this.updateFilters();
        this._resetAudioFx();
    }

    setBfoPitch(pitch) {
        this.bfoPitch = Math.max(300, Math.min(1200, pitch));
        this.updateFilters();
        this._resetAudioFx();
    }

    setAutonotchEnabled(on) { this.autoNotch.setEnabled(on); }
    setAutonotchDepth(pct) { this.autoNotch.setDepth(pct); }
    setNrEnabled(on) { this.nr.setEnabled(on); }
    setNrStrength(pct) { this.nr.setStrength(pct); }
    setSquelchEnabled(on) { this.squelch.setEnabled(on); }
    setSquelchMarginDb(db) { this.squelch.setMarginDb(db); }

    _resetAudioFx() {
        this.autoNotch.reset();
        this.nr.reset();
    }

    updateFilters() {
        let pbCenter, cutoff, bfo;
        const m = MODES[this.modulation];
        if (m && m.low !== null) {
            pbCenter = (m.low + m.high) / 2;
            cutoff = (m.high - m.low) / 2;
            bfo = pbCenter;
        } else {
            pbCenter = 0.0;
            cutoff = this.cwBandwidth / 2;
            bfo = this.bfoPitch;
        }
        const nyq = this.audioRate * 0.45;
        if (cutoff > nyq) cutoff = nyq;

        const ncoStep = (-2.0 * Math.PI * (this.offsetFreq + pbCenter)) / this.iqRate;
        const bfoStep = (2.0 * Math.PI * bfo) / this.audioRate;
        this.ncoStepC = Math.cos(ncoStep);
        this.ncoStepS = Math.sin(ncoStep);
        this.bfoStepC = Math.cos(bfoStep);
        this.bfoStepS = Math.sin(bfoStep);

        if (cutoff !== this.channelCutoff) {
            this.channelCutoff = cutoff;
            const n = kaiserNumTaps(CH_ATTEN_DB, CH_TRANSITION_HZ, this.audioRate);
            this.channel.setTaps(designLowpass(n, cutoff, this.audioRate, CH_ATTEN_DB), false);
        }
    }

    /**
     * Demodulates interleaved float IQ (±1) into audio at `this.audioRate`.
     * @param {Float32Array} iq - Interleaved [I0, Q0, I1, Q1, ...]
     * @param {number} [nComplex] - complex sample count; defaults to iq.length / 2
     * @returns {Float32Array} Mono audio. Internal buffer: valid until the next call.
     */
    process(iq, nComplex) {
        const numComplex = nComplex == null ? (iq.length >> 1) : nComplex | 0;
        const decim = this.decim;
        const maxOut = Math.ceil(numComplex / decim) + 1;
        if (this.audioOut.length < maxOut) {
            this.audioOut = new Float32Array(maxOut);
            this.tapI = new Float32Array(maxOut);
            this.tapQ = new Float32Array(maxOut);
        }
        const out = this.audioOut;
        const tapI = this.tapI;
        const tapQ = this.tapQ;
        const hbs = this.hbs;
        const fills = this.hbFill;
        const stages = this.stages;
        const channel = this.channel;
        const ncoStepC = this.ncoStepC;
        const ncoStepS = this.ncoStepS;
        const bfoStepC = this.bfoStepC;
        const bfoStepS = this.bfoStepS;
        let ncoC = this.ncoC;
        let ncoS = this.ncoS;
        let bfoC = this.bfoC;
        let bfoS = this.bfoS;
        let o = 0;

        for (let n = 0; n < numComplex; n++) {
            const idx = n * 2;
            const i = iq[idx];
            const q = iq[idx + 1];
            const si0 = i * ncoC - q * ncoS;
            const sq0 = i * ncoS + q * ncoC;
            const nc = ncoC * ncoStepC - ncoS * ncoStepS;
            ncoS = ncoC * ncoStepS + ncoS * ncoStepC;
            ncoC = nc;

            let si = si0;
            let sq = sq0;
            let alive = true;
            for (let s = 0; s < stages; s++) {
                const hb = hbs[s];
                hb.push(si, sq);
                if (++fills[s] < 2) {
                    alive = false;
                    break;
                }
                fills[s] = 0;
                hb.compute();
                si = hb.outI;
                sq = hb.outQ;
            }
            if (!alive) continue;

            if (this.qrssPush) this.qrssPush(si, sq);
            channel.push(si, sq);
            channel.compute();
            const ci = channel.outI;
            const cq = channel.outQ;
            tapI[o] = ci;
            tapQ[o] = cq;
            out[o] = ci * bfoC - cq * bfoS;
            const bc = bfoC * bfoStepC - bfoS * bfoStepS;
            bfoS = bfoC * bfoStepS + bfoS * bfoStepC;
            bfoC = bc;
            o++;
        }

        let nmag = Math.hypot(ncoC, ncoS);
        if (nmag > 0) { ncoC /= nmag; ncoS /= nmag; }
        if (o > 0) {
            const bmag = Math.hypot(bfoC, bfoS);
            if (bmag > 0) { bfoC /= bmag; bfoS /= bmag; }
        }
        this.ncoC = ncoC;
        this.ncoS = ncoS;
        this.bfoC = bfoC;
        this.bfoS = bfoS;

        if (this.tapCallback) this.tapCallback(tapI, tapQ, o);
        // SSB only (see the header): in CW the autonotch digs out dits and NR lifts the channel noise.
        if (this.modulation !== 'cw') {
            if (this.autoNotch.enabled) this.autoNotch.process(out, o);
            if (this.nr.enabled) this.nr.process(out, o);
        }
        this.squelch.observe(out, o, this.agc.noiseFloor);
        this.agc.process(out.subarray(0, o));
        this.squelch.gate(out, o);
        return out.subarray(0, o);
    }
}

if (typeof globalThis !== 'undefined') {
    globalThis.designLowpass = designLowpass;
    globalThis.kaiserNumTaps = kaiserNumTaps;
    globalThis.designHalfband = designHalfband;
    globalThis.ComplexFIR = ComplexFIR;
    globalThis.channelPlan = channelPlan;
}
if (typeof module !== 'undefined') {
    module.exports = {
        DidahDemodulator, ComplexFIR, designLowpass, kaiserNumTaps, designHalfband, channelPlan,
        halfbandTaps, CH_RATE_MIN, CH_TRANSITION_HZ, CH_ATTEN_DB, LARGE_RETUNE_HZ
    };
}
