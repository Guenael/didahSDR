/**
 * didahSDR - Client-Side CW / SSB Demodulator ("filter method")
 *
 * Signal path, per complex IQ sample at 96 kHz:
 *   1. NCO      : shifts the centre of the wanted passband to DC
 *                 (CW: the carrier itself; SSB: tuned + passband centre from MODES).
 *   2. Halfband : 31-tap FIR anti-alias lowpass, decimate 2:1 -> 48 kHz complex.
 *   3. Channel  : real-coefficient Kaiser windowed-sinc lowpass applied to I and Q,
 *                 cutoff = passband / 2. Everything outside the wanted passband, including the
 *                 opposite sideband, is gone after this stage. This is the sideband selection.
 *   4. BFO      : rotate by +pitch (CW) or the SSB passband centre (USB +, LSB −) and take Re().
 *   5. AGC (in place).
 *   A tap on the stage-3 output (complex, pre-BFO, pre-AGC) feeds the CW decoder (cw_decoder.js).
 *
 * Image rejection is set by the channel filter stopband (~60 dB), not by IQ balance tricks.
 * No allocations per packet.
 */

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
        h[n] = sinc * besselI0(beta * Math.sqrt(1.0 - r * r)) / i0Beta;
        sum += h[n];
    }
    for (let n = 0; n < numTaps; n++) h[n] /= sum;
    return h;
}

/**
 * FIR with real, symmetric taps applied to a complex signal. Double-length history buffer so the
 * dot product runs over a contiguous range without modulo.
 */
class ComplexFIR {
    constructor(taps) {
        this.setTaps(taps);
    }

    setTaps(taps) {
        if (!this.h || this.h.length !== taps.length) {
            const N = taps.length;
            this.bufI = new Float32Array(2 * N);
            this.bufQ = new Float32Array(2 * N);
            this.pos = 0;
        }
        this.h = taps;
        this.N = taps.length;
        this.outI = 0.0;
        this.outQ = 0.0;
    }

    push(i, q) {
        const p = this.pos;
        this.bufI[p] = this.bufI[p + this.N] = i;
        this.bufQ[p] = this.bufQ[p + this.N] = q;
        this.pos = p === this.N - 1 ? 0 : p + 1;
    }

    /** Compute the output for the most recently pushed sample (taps symmetric, so order is irrelevant). */
    compute() {
        const h = this.h, bi = this.bufI, bq = this.bufQ, N = this.N, base = this.pos;
        let accI = 0.0, accQ = 0.0;
        for (let m = 0; m < N; m++) {
            accI += h[m] * bi[base + m];
            accQ += h[m] * bq[base + m];
        }
        this.outI = accI;
        this.outQ = accQ;
    }
}

class DidahDemodulator {
    constructor(sampleRate = 96000, audioRate = 48000) {
        this.iqRate = sampleRate;     // 96000
        this.audioRate = audioRate;   // 48000

        this.offsetFreq = 0.0;        // tuned - center, Hz
        this.modulation = 'cw';
        this.cwBandwidth = 150.0;     // 50 to 350 Hz
        this.bfoPitch = 700.0;        // CW audio pitch

        // Channel filter length: 511 taps at 48 kHz ~ 340 Hz transition at -60 dB.
        // Raise for sharper skirts; above ~1500 taps consider FFT overlap-save instead.
        this.CHANNEL_TAPS = 511;

        this.ncoPhase = 0.0;
        this.bfoPhase = 0.0;
        this.ncoStep = 0.0;
        this.bfoStep = 0.0;

        this.halfband = new ComplexFIR(designLowpass(31, sampleRate / 4, sampleRate, 60));
        this.channel = new ComplexFIR(designLowpass(this.CHANNEL_TAPS, 75.0, audioRate, 60));
        this.channelCutoff = 0.0;

        // AGC (processes in place)
        this.agcSpeed = 'medium';
        this.agc = new AGC(this.audioRate);

        // 96 kHz IQ is halfband-decimated 2:1 to 48 kHz audio. Kiwi IQ (~12 kHz) is already
        // audio-rate, so NCO / channel / BFO run at iqRate with no decimator.
        this.decimate2 = this.iqRate >= 72000;

        // Output buffer, reused across calls (re-allocated only if the packet size changes)
        this.audioOut = new Float32Array(0);

        // Optional tap on the channel-filtered complex baseband (before BFO / Re() / AGC), used by the
        // CW decoder. Called once per packet as tapCallback(i, q, n) with pre-allocated buffers.
        this.tapCallback = null;
        this.tapI = new Float32Array(0);
        this.tapQ = new Float32Array(0);

        this.updateFilters();
    }

    /**
     * Rebuild the NCO/halfband/channel chain for a new IQ sample rate.
     * Rates >= 72 kHz keep the 2:1 halfband to 48 kHz audio; slower IQ (Kiwi ~12 kHz)
     * is demodulated at the IQ rate and resampled in the audio worklet.
     */
    setIqRate(iqRate) {
        const rate = Math.max(1000, iqRate);
        if (rate === this.iqRate && ((rate >= 72000) === this.decimate2)) return;
        this.iqRate = rate;
        this.decimate2 = rate >= 72000;
        const audioRate = this.decimate2 ? 48000 : rate;
        this.halfband.setTaps(designLowpass(31, this.iqRate / 4, this.iqRate, 60));
        if (audioRate !== this.audioRate) {
            this.audioRate = audioRate;
            this.agc = new AGC(this.audioRate);
            this.agc.setSpeed(this.agcSpeed);
        }
        this.channelCutoff = -1;
        this.updateFilters();
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
        if (p.offsetFreq !== undefined) this.offsetFreq = p.offsetFreq;
        if (p.modulation !== undefined) this.modulation = p.modulation.toLowerCase();
        if (p.cwBandwidth !== undefined) this.cwBandwidth = Math.max(30, Math.min(500, p.cwBandwidth));
        if (p.bfoPitch !== undefined) this.bfoPitch = Math.max(300, Math.min(1200, p.bfoPitch));
        this.updateFilters();
    }

    /** @param {number} freq - tuned frequency relative to the IQ centre, Hz */
    setOffsetFrequency(freq) {
        this.offsetFreq = freq;
        this.updateFilters();
    }

    setModulation(mod) {
        this.modulation = mod.toLowerCase();
        this.updateFilters();
    }

    setCwBandwidth(bw) {
        this.cwBandwidth = Math.max(30, Math.min(500, bw));
        this.updateFilters();
    }

    setBfoPitch(pitch) {
        this.bfoPitch = Math.max(300, Math.min(1200, pitch));
        this.updateFilters();
    }

    updateFilters() {
        // Passband centre relative to the tuned frequency, and the BFO that brings it back to audio
        let pbCenter, cutoff, bfo;
        const m = MODES[this.modulation];
        if (m && m.low !== null) {
            // SSB: passband [low, high] relative to the carrier; a negative centre (LSB) makes the
            // BFO rotate the other way so the spectrum comes out inverted, as LSB should.
            pbCenter = (m.low + m.high) / 2;
            cutoff = (m.high - m.low) / 2;
            bfo = pbCenter;
        } else {
            pbCenter = 0.0;
            cutoff = this.cwBandwidth / 2;
            bfo = this.bfoPitch;
        }

        this.ncoStep = (-2.0 * Math.PI * (this.offsetFreq + pbCenter)) / this.iqRate;
        this.bfoStep = (2.0 * Math.PI * bfo) / this.audioRate;

        if (cutoff !== this.channelCutoff) {
            this.channelCutoff = cutoff;
            this.channel.setTaps(designLowpass(this.CHANNEL_TAPS, cutoff, this.audioRate, 60));
        }
    }

    /**
     * Demodulates interleaved 16-bit complex IQ into float audio at `this.audioRate`.
     * @param {Int16Array} int16IQ - Interleaved [I0, Q0, I1, Q1, ...]
     * @returns {Float32Array} Mono audio. Internal buffer: valid until the next call.
     */
    process(int16IQ) {
        const numComplex = int16IQ.length / 2;
        const decim = this.decimate2;
        const outLen = decim ? numComplex >> 1 : numComplex;
        if (this.audioOut.length !== outLen) {
            this.audioOut = new Float32Array(outLen);
            this.tapI = new Float32Array(outLen);
            this.tapQ = new Float32Array(outLen);
        }
        const out = this.audioOut;
        const tapI = this.tapI, tapQ = this.tapQ;

        const halfband = this.halfband;
        const channel = this.channel;
        const ncoStep = this.ncoStep;
        const bfoStep = this.bfoStep;
        const TWO_PI = 2.0 * Math.PI;
        const inv32768 = 1.0 / 32768.0;
        let ncoPhase = this.ncoPhase;
        let bfoPhase = this.bfoPhase;

        for (let n = 0, o = 0; n < numComplex; ) {
            const samplesThisOut = decim ? 2 : 1;
            if (n + samplesThisOut > numComplex) break;
            for (let k = 0; k < samplesThisOut; k++) {
                const idx = (n + k) * 2;
                const i = int16IQ[idx] * inv32768;
                const q = int16IQ[idx + 1] * inv32768;
                const c = Math.cos(ncoPhase);
                const s = Math.sin(ncoPhase);
                const si = i * c - q * s;
                const sq = i * s + q * c;
                ncoPhase += ncoStep;
                if (ncoPhase > TWO_PI) ncoPhase -= TWO_PI;
                else if (ncoPhase < -TWO_PI) ncoPhase += TWO_PI;
                if (decim) {
                    halfband.push(si, sq);
                } else {
                    channel.push(si, sq);
                }
            }
            n += samplesThisOut;
            if (decim) {
                halfband.compute();
                channel.push(halfband.outI, halfband.outQ);
            }
            channel.compute();
            tapI[o] = channel.outI;
            tapQ[o] = channel.outQ;
            out[o] = channel.outI * Math.cos(bfoPhase) - channel.outQ * Math.sin(bfoPhase);
            bfoPhase += bfoStep;
            if (bfoPhase > TWO_PI) bfoPhase -= TWO_PI;
            else if (bfoPhase < -TWO_PI) bfoPhase += TWO_PI;
            o++;
        }

        this.ncoPhase = ncoPhase;
        this.bfoPhase = bfoPhase;

        if (this.tapCallback) this.tapCallback(tapI, tapQ, outLen);
        return this.agc.process(out);
    }
}

if (typeof module !== 'undefined') module.exports = { DidahDemodulator, ComplexFIR, designLowpass };
