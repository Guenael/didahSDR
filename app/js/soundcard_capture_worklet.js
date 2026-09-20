/**
 * didahSDR - Stereo capture worklet (SoftRock-style I/Q on L/R).
 *
 * Packs Float32 input to interleaved Int16 I/Q in ~25 ms packets. No allocations in process()
 * once the buffer pool has been filled. Outputs silence so the node can stay connected.
 */
class SoundcardCaptureProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.swap = false;
        this.framesTarget = Math.max(128, Math.round(sampleRate * 0.025));
        this.pool = [];
        for (let i = 0; i < 6; i++) this.pool.push(new Int16Array(this.framesTarget * 2));
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

    process(inputs, outputs) {
        const out0 = outputs[0] && outputs[0][0];
        if (out0) out0.fill(0);

        const input = inputs[0];
        const ch0 = input && input[0];
        if (!ch0) return true;
        const ch1 = input[1] && input[1].length ? input[1] : null;
        const n = ch0.length;
        const swap = this.swap;
        const scale = 32767;

        for (let i = 0; i < n; i++) {
            if (!this.cur) {
                this.cur = this.pool.pop();
                this.fill = 0;
                if (!this.cur) continue;
            }
            const iSamp = swap ? (ch1 ? ch1[i] : 0) : ch0[i];
            const qSamp = swap ? ch0[i] : (ch1 ? ch1[i] : 0);
            let ii = iSamp * scale;
            let qq = qSamp * scale;
            if (ii > 32767) ii = 32767;
            else if (ii < -32768) ii = -32768;
            if (qq > 32767) qq = 32767;
            else if (qq < -32768) qq = -32768;
            const o = this.fill * 2;
            this.cur[o] = ii;
            this.cur[o + 1] = qq;
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

registerProcessor('soundcard-capture', SoundcardCaptureProcessor);
