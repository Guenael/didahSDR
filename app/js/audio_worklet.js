/**
 * didahSDR - Audio output engine, running inside an AudioWorklet.
 *
 * DidahAudioEngine holds the jitter ring buffer, fractional resampler with clock-drift
 * compensation, prebuffer/underrun handling with click-free fades, and diagnostics counters.
 * It is a plain class so Node tests can drive it; the AudioWorkletProcessor below is a thin
 * wrapper that feeds it from `port` messages and renders into the output block.
 *
 * Port protocol (main thread -> worklet):
 *   Float32Array            : mono audio at `inputRate` to enqueue (transferred, not copied)
 *   { type: 'reset' }       : drop buffered audio (power off / stop)
 *   { type: 'inputRate', rate } : demodulator output rate (48000 replay, ~12000 Kiwi)
 *   { type: 'debug', on }   : enable once-per-second stats messages
 * (worklet -> main thread):
 *   { type: 'level', peak } : ~15 Hz output peak for the VU meter
 *   { type: 'stats', ... }  : per-second counters when debug is on
 */
class DidahAudioEngine {
    constructor(inputRate = 48000, outputRate = 48000) {
        this.inputRate = inputRate;
        this.outputRate = outputRate;

        // Circular ring buffer (32768 samples = ~682 ms at 48 kHz)
        this.RING_SIZE = 32768;
        this.ring = new Float32Array(this.RING_SIZE);
        this.writePos = 0;
        this.readPos = 0.0;
        this.buffered = 0;

        // Jitter targets. WebSocket delivery bursts by up to ~±40 ms around the 25 ms server cadence,
        // so the steady-state level must sit well above that burst amplitude.
        // - target: ~128 ms held by drift compensation; - minPrebuffer: ~85 ms before (re)starting.
        this.targetBuffer = 6144;
        this.minPrebuffer = 4096;
        this.prebuffering = true;

        // Click-free underrun handling: exponential fade-out of the last sample when the buffer runs
        // dry, linear fade-in over FADE_IN samples when playback resumes.
        this.FADE_IN = 480;   // 10 ms at 48 kHz
        this.fadeInPos = this.FADE_IN;
        this.lastSample = 0.0;

        this.stats = { blocks: 0, underruns: 0, overflows: 0, minBuf: Infinity, maxBuf: 0 };
        this._syncBufferTargets();
    }

    _syncBufferTargets() {
        // ~128 ms target / ~85 ms prebuffer, relative to the demodulator output rate
        const rate = this.inputRate || 48000;
        this.targetBuffer = Math.max(512, Math.round(rate * 0.128));
        this.minPrebuffer = Math.max(256, Math.round(rate * 0.085));
    }

    setInputRate(rate) {
        const next = Math.max(1000, rate);
        if (next === this.inputRate) return;
        this.inputRate = next;
        this._syncBufferTargets();
        this.reset();
    }

    /** Enqueue mono float samples. */
    push(samples) {
        const n = samples.length;
        if (n === 0) return;
        const ring = this.ring, R = this.RING_SIZE;
        let w = this.writePos;
        for (let i = 0; i < n; i++) {
            ring[w] = samples[i];
            w = w === R - 1 ? 0 : w + 1;
        }
        this.writePos = w;
        if (this.buffered + n > R) this.stats.overflows++;
        this.buffered = Math.min(R, this.buffered + n);
        if (this.prebuffering && this.buffered >= this.minPrebuffer) this.prebuffering = false;
    }

    reset() {
        this.buffered = 0;
        this.writePos = 0;
        this.readPos = 0.0;
        this.prebuffering = true;
        this.fadeInPos = 0;
        this.lastSample = 0.0;
    }

    /**
     * Render one output block. Returns the block peak (0 while faded/silent).
     * @param {Float32Array} out
     */
    render(out) {
        const outLen = out.length;
        const nominalStep = this.inputRate / this.outputRate;
        const st = this.stats;
        st.blocks++;
        if (this.buffered < st.minBuf) st.minBuf = this.buffered;
        if (this.buffered > st.maxBuf) st.maxBuf = this.buffered;

        // Prebuffering or starving: fade the last sample out instead of cutting hard
        if (this.prebuffering || this.buffered < outLen * nominalStep) {
            if (!this.prebuffering) st.underruns++;
            this.prebuffering = true;
            this.fadeInPos = 0;
            let tail = this.lastSample;
            for (let i = 0; i < outLen; i++) { tail *= 0.995; out[i] = tail; }
            this.lastSample = tail;
            return 0.0;
        }

        // Clock drift compensation: ±0.5 % playback-rate trim toward the target latency
        const drift = (this.buffered - this.targetBuffer) * 0.00002;
        const step = nominalStep * (1.0 + Math.max(-0.005, Math.min(0.005, drift)));

        const ring = this.ring, R = this.RING_SIZE, fadeLen = this.FADE_IN;
        let rPos = this.readPos, consumed = 0, peak = 0, fadePos = this.fadeInPos, last = this.lastSample;

        for (let i = 0; i < outLen; i++) {
            if (this.buffered - consumed < 2) {
                if (!this.prebuffering) st.underruns++;
                this.prebuffering = true;
                fadePos = 0;
                last *= 0.995;
                out[i] = last;
                continue;
            }
            const i0 = Math.floor(rPos);
            const idx0 = i0 >= R ? i0 - R : i0;
            const idx1 = idx0 === R - 1 ? 0 : idx0 + 1;
            const frac = rPos - i0;
            let s = ring[idx0] * (1.0 - frac) + ring[idx1] * frac;   // linear interpolation
            if (fadePos < fadeLen) { s *= fadePos / fadeLen; fadePos++; }
            out[i] = s;
            last = s;
            const a = s < 0 ? -s : s;
            if (a > peak) peak = a;
            rPos += step;
            if (rPos >= R) rPos -= R;
            consumed += step;
        }

        this.fadeInPos = fadePos;
        this.lastSample = last;
        this.readPos = rPos;
        this.buffered = Math.max(0, this.buffered - consumed);
        return peak;
    }

    /** Snapshot and reset the per-period counters (underruns/overflows are cumulative). */
    takeStats() {
        const st = this.stats;
        const snap = { blocks: st.blocks, underruns: st.underruns, overflows: st.overflows,
            minBuf: Math.round(st.minBuf), maxBuf: Math.round(st.maxBuf), target: this.targetBuffer };
        st.blocks = 0; st.minBuf = Infinity; st.maxBuf = 0;
        return snap;
    }
}

if (typeof registerProcessor !== 'undefined') {
    class DidahAudioProcessor extends AudioWorkletProcessor {
        constructor() {
            super();
            this.engine = new DidahAudioEngine(48000, sampleRate);   // `sampleRate` is the worklet global
            this.debug = false;
            this.framesSinceLevel = 0;
            this.framesSinceStats = 0;
            this.levelPeak = 0.0;
            this.port.onmessage = (e) => {
                const m = e.data;
                if (m instanceof Float32Array) this.engine.push(m);
                else if (m && m.type === 'reset') this.engine.reset();
                else if (m && m.type === 'inputRate') this.engine.setInputRate(m.rate);
                else if (m && m.type === 'debug') this.debug = !!m.on;
            };
        }

        process(inputs, outputs) {
            const out = outputs[0][0];
            const peak = this.engine.render(out);
            if (peak > this.levelPeak) this.levelPeak = peak;

            this.framesSinceLevel += out.length;
            if (this.framesSinceLevel >= sampleRate * 0.06) {          // ~15 Hz VU updates
                this.framesSinceLevel = 0;
                this.port.postMessage({ type: 'level', peak: this.levelPeak });
                this.levelPeak = 0.0;
            }
            if (this.debug) {
                this.framesSinceStats += out.length;
                if (this.framesSinceStats >= sampleRate) {
                    this.framesSinceStats = 0;
                    this.port.postMessage({ type: 'stats', ...this.engine.takeStats() });
                }
            }
            return true;
        }
    }
    registerProcessor('didah-audio', DidahAudioProcessor);
}

if (typeof module !== 'undefined') module.exports = DidahAudioEngine;
