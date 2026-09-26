/**
 * didahSDR - CW transmit as complex baseband (TX_IQ, docs/protocol.md), for a zero-IF transmitter
 * that upconverts IQ with the same Tayloe mixer as the receiver.
 *
 *   TxIqModulator : key edges (in TX sample time) -> int16 I/Q of a carrier at `offset` Hz from the
 *                   IQ centre (CW convention: the tuned frequency is the carrier), raised-cosine
 *                   edges of `riseMs`. Full scale (|z| = 32767) is the device's set TX power.
 *   TxIqPump      : paces TX_IQ frames on the wall clock with `latencyMs` of lead, so a key edge that
 *                   reaches the main thread late (worklet message, timer jitter) still lands at its
 *                   own time. PTT is raised before the first frame and dropped after the tail ramp.
 *
 * Edges come from the worklet keyer (onKeyerState), so the timing is the sidetone's to within one
 * render quantum. No allocations per frame.
 */

const TX_EDGE_RING = 64;

class TxIqModulator {
    constructor(sampleRate = 96000, riseMs = 5, amplitude = 32767) {
        this.amplitude = amplitude;
        this.riseMs = riseMs;
        this.edgeAt = new Float64Array(TX_EDGE_RING);
        this.edgeDown = new Uint8Array(TX_EDGE_RING);
        this.offsetHz = 0;
        this.setSampleRate(sampleRate);
        this.reset();
    }

    setSampleRate(rate) {
        this.sampleRate = rate;
        this.rampLen = Math.max(1, Math.round((rate * this.riseMs) / 1000));
        this.setOffset(this.offsetHz);
    }

    setOffset(hz) {
        this.offsetHz = hz;
        const w = (2 * Math.PI * hz) / this.sampleRate;
        this.stepC = Math.cos(w);
        this.stepS = Math.sin(w);
    }

    reset() {
        this.head = 0;
        this.count = 0;
        this.down = false;
        this.rampPos = 0;
        this.c = 1.0;
        this.s = 0.0;
        this.lastEdge = 0;
    }

    /** Queue a key edge at TX sample `at`. Edges are kept in order; an early one is moved to the last. */
    keyEdge(at, down) {
        if (this.count === TX_EDGE_RING) return false;
        const t = Math.max(at, this.lastEdge);
        this.lastEdge = t;
        const i = (this.head + this.count) % TX_EDGE_RING;
        this.edgeAt[i] = t;
        this.edgeDown[i] = down ? 1 : 0;
        this.count++;
        return true;
    }

    /** True while the envelope is not zero or a key-down is pending. */
    get busy() {
        return this.down || this.rampPos > 0 || this.count > 0;
    }

    /**
     * Render n complex samples starting at TX sample `start` into interleaved int16 `out`.
     * @returns {number} peak envelope in this block (0..1)
     */
    render(out, n, start) {
        const R = this.rampLen;
        const amp = this.amplitude;
        const stepC = this.stepC, stepS = this.stepS;
        let c = this.c, s = this.s;
        let down = this.down;
        let pos = this.rampPos;
        let peak = 0;
        for (let k = 0; k < n; k++) {
            const t = start + k;
            while (this.count > 0 && this.edgeAt[this.head] <= t) {
                down = this.edgeDown[this.head] === 1;
                this.head = (this.head + 1) % TX_EDGE_RING;
                this.count--;
            }
            if (down) { if (pos < R) pos++; } else if (pos > 0) pos--;
            const env = 0.5 - 0.5 * Math.cos((Math.PI * pos) / R);
            if (env > peak) peak = env;
            const a = amp * env;
            out[2 * k] = Math.round(a * c);
            out[2 * k + 1] = Math.round(a * s);
            const nc = c * stepC - s * stepS;
            s = c * stepS + s * stepC;
            c = nc;
        }
        const mag = Math.hypot(c, s);
        this.c = c / mag;
        this.s = s / mag;
        this.down = down;
        this.rampPos = pos;
        return peak;
    }
}

class TxIqPump {
    /**
     * @param {object} o
     * @param {function(boolean)} o.setPtt           SET_PTT on the link
     * @param {function(Int16Array, number, number)} o.send  (samples, nComplex, txSampleIndex)
     * @param {function(number): Int16Array} o.buffer  interleaved int16 buffer for n complex samples
     * @param {function(): number} [o.now]           ms clock (performance.now)
     * @param {boolean} [o.timer]                    false in tests: call tick() yourself
     */
    constructor(o) {
        this.setPttFn = o.setPtt;
        this.sendFn = o.send;
        this.bufferFn = o.buffer;
        this.now = o.now || (() => performance.now());
        this.useTimer = o.timer !== false;
        this.latencyMs = o.latencyMs || 60;
        this.mod = new TxIqModulator(o.sampleRate || 96000);
        this.chunk = Math.max(1, Math.round(this.mod.sampleRate * 0.025));   // 25 ms, as RX_IQ
        this.ptt = false;
        this.releasing = false;
        this.keyed = false;
        this.timerId = null;
        this.startMs = 0;
        this.sent = 0;
        this.releaseAt = 0;
        this.indexBase = 0;
        this.skipped = 0;
    }

    get sampleRate() { return this.mod.sampleRate; }

    setSampleRate(rate) {
        if (rate !== this.mod.sampleRate) {
            this.abort();
            this.mod.setSampleRate(rate);
            this.chunk = Math.max(1, Math.round(rate * 0.025));
        }
    }

    setOffset(hz) { this.mod.setOffset(hz); }

    /** TX sample position of wall time `ms`. */
    _pos(ms) {
        return Math.round(((ms - this.startMs) * this.sampleRate) / 1000);
    }

    /**
     * Mirror the keyer: ptt = transmitting (keyer tx with hang), keyed = carrier on.
     * @param {number} [indexBase] RX sample index at PTT-on (the device's time base)
     */
    update(ptt, keyed, indexBase = 0) {
        const now = this.now();
        if (ptt && (!this.ptt || this.releasing)) {
            if (!this.ptt) {
                this.mod.reset();
                this.startMs = now;
                this.sent = 0;
                this.indexBase = indexBase;
                this.setPttFn(true);
                if (this.useTimer && this.timerId === null) this.timerId = setInterval(() => this.tick(), 10);
            }
            this.ptt = true;
            this.releasing = false;
        }
        if (!this.ptt) return;
        if (keyed !== this.keyed) {
            this.keyed = keyed;
            this.mod.keyEdge(Math.max(this._pos(now), this.sent), keyed);
        }
        if (!ptt && !this.releasing) {
            if (this.keyed) {
                this.keyed = false;
                this.mod.keyEdge(Math.max(this._pos(now), this.sent), false);
            }
            this.releasing = true;
            this.releaseAt = Math.max(this._pos(now), this.sent);
        }
    }

    tick() {
        if (!this.ptt) return;
        const due = this._pos(this.now() - this.latencyMs);
        const chunk = this.chunk;
        if (due - this.sent > this.sampleRate) {
            // Timers stalled for over a second (tab throttled): skip ahead rather than burst.
            this.skipped += due - chunk - this.sent;
            this.sent = due - chunk;
        }
        while (due - this.sent >= chunk) {
            const buf = this.bufferFn(chunk);
            this.mod.render(buf, chunk, this.sent);
            this.sendFn(buf, chunk, this.indexBase + this.sent);
            this.sent += chunk;
            if (this.releasing && this.sent >= this.releaseAt + this.mod.rampLen && !this.mod.busy) {
                this._finish();
                return;
            }
        }
    }

    _finish() {
        this.ptt = false;
        this.releasing = false;
        this.keyed = false;
        if (this.timerId !== null) {
            clearInterval(this.timerId);
            this.timerId = null;
        }
        this.setPttFn(false);
    }

    /** Stop now (link lost, power off, rate change). */
    abort() {
        if (this.ptt) this._finish();
        this.mod.reset();
    }
}

if (typeof module !== 'undefined') {
    module.exports = { TxIqModulator, TxIqPump };
}
