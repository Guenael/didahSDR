/**
 * didahSDR - IC-7300 real-IF capture worklet
 *
 * Expects `ic7300_if.js` to have been addModule'd first (RealIfConverter, designHilbert).
 * The node is opened mono; Chrome downmixes a stereo PCM2901. Packs ~25 ms analytic
 * Int16 I/Q. No allocations in process() once the buffer pool is filled.
 */
class Ic7300CaptureProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        const taps = globalThis.IC7300_HILBERT_TAPS;
        const design = globalThis.designHilbert;
        const Converter = globalThis.RealIfConverter;
        this.conv = new Converter(design(taps));
        this.framesTarget = Math.max(128, Math.round(sampleRate * 0.025));
        this.pool = [];
        for (let i = 0; i < 6; i++) this.pool.push(new Int16Array(this.framesTarget * 2));
        this.cur = this.pool.pop();
        this.fill = 0;
        this.port.onmessage = (e) => {
            const m = e.data;
            if (!m) return;
            if (m.type === 'recycle' && m.samples && m.samples.length === this.framesTarget * 2) {
                if (this.pool.length < 8) this.pool.push(m.samples);
            }
        };
    }

    process(inputs, outputs) {
        const out0 = outputs[0] && outputs[0][0];
        if (out0) out0.fill(0);

        const input = inputs[0];
        const ch0 = input && input[0];
        if (!ch0) return true;
        const n = ch0.length;
        const conv = this.conv;

        for (let i = 0; i < n; i++) {
            if (!this.cur) {
                this.cur = this.pool.pop();
                this.fill = 0;
                if (!this.cur) continue;
            }
            conv.step(ch0[i], this.cur, this.fill);
            this.fill++;
            if (this.fill === this.framesTarget) {
                this.port.postMessage({ type: 'iq', samples: this.cur, rate: sampleRate }, [this.cur.buffer]);
                this.cur = null;
                this.fill = 0;
            }
        }
        return true;
    }
}

registerProcessor('ic7300-capture', Ic7300CaptureProcessor);
