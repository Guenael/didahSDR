/**
 * didahSDR - one capture worklet for stereo I/Q and the IC-7300 real IF.
 *
 * processorOptions.mode is 'stereo-iq' or 'real-if'. Real-IF mode expects
 * demodulator.js and ic7300_if.js to have been addModule'd first.
 * Packs ~25 ms of Float32 interleaved I/Q (±1). Stereo I/Q uses packStereoIq
 * from soundcard.js (addModule that file first). No allocations in process()
 * once the buffer pool is filled.
 */
class AudioCaptureProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const opts = (options && options.processorOptions) || {};
        this.mode = opts.mode === 'real-if' ? 'real-if' : 'stereo-iq';
        this.swap = !!opts.swap;
        if (this.mode === 'real-if') {
            const Converter = globalThis.RealIfConverter;
            this.conv = new Converter(sampleRate);
            this.outRate = this.conv.outRate;
        } else {
            this.conv = null;
            this.outRate = sampleRate;
            if (typeof globalThis.packStereoIq !== 'function') {
                throw new Error('audio-capture needs packStereoIq; load soundcard.js first');
            }
        }
        this.framesTarget = Math.max(64, Math.round(this.outRate * 0.025));
        this.pool = [];
        for (let i = 0; i < 6; i++) this.pool.push(new Float32Array(this.framesTarget * 2));
        this.cur = this.pool.pop();
        this.fill = 0;
        this.port.onmessage = (e) => {
            const m = e.data;
            if (!m) return;
            if (m.type === 'swap') this.swap = !!m.on;
            else if (m.type === 'recycle' && m.samples && m.samples.length === this.framesTarget * 2) {
                if (this.pool.length < 8) this.pool.push(m.samples);
            }
        };
    }

    _emit() {
        this.port.postMessage(
            { type: 'iq', samples: this.cur, rate: this.outRate, n: this.fill },
            [this.cur.buffer]
        );
        this.cur = null;
        this.fill = 0;
    }

    _slot() {
        if (this.cur) return true;
        this.cur = this.pool.pop();
        this.fill = 0;
        return !!this.cur;
    }

    process(inputs, outputs) {
        const out0 = outputs[0] && outputs[0][0];
        if (out0) out0.fill(0);
        const input = inputs[0];
        const ch0 = input && input[0];
        if (!ch0) return true;

        if (this.mode === 'real-if') {
            const conv = this.conv;
            const n = ch0.length;
            for (let i = 0; i < n; i++) {
                if (!this._slot()) continue;
                if (!conv.push(ch0[i], this.cur, this.fill)) continue;
                this.fill++;
                if (this.fill === this.framesTarget) this._emit();
            }
            return true;
        }

        const ch1 = input[1] && input[1].length ? input[1] : null;
        const n = ch0.length;
        const swap = this.swap;
        const pack = globalThis.packStereoIq;
        let i = 0;
        while (i < n) {
            if (!this._slot()) break;
            const take = Math.min(this.framesTarget - this.fill, n - i);
            pack(ch0, ch1, swap, this.cur, this.fill, take, i);
            this.fill += take;
            i += take;
            if (this.fill === this.framesTarget) this._emit();
        }
        return true;
    }
}

registerProcessor('audio-capture', AudioCaptureProcessor);
