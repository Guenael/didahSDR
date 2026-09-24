/**
 * didahSDR - CW decoder (main-thread controller) + CW-Skimmer-style text highlighter.
 *
 * Takes the demodulator's complex baseband tap, batches it into pooled transferable buffers, feeds the
 * worker (cw_decoder_worker.js) and renders the returned text into the decoder window. Runs only
 * while the window is visible and the mode is CW. `reset()` on retune / bandwidth / source change.
 */

// resampler.js already declares ComplexPolyphase in the page scope. A second
// const/class of that name is a syntax error and stops the rest of the app.
const CwTapResampler = (typeof globalThis !== 'undefined' && globalThis.ComplexPolyphase)
    ? globalThis.ComplexPolyphase
    : require('./resampler.js').ComplexPolyphase;

const CW_HIGHLIGHT = {
    exchange: /^(5NN|599|57N|579|58N|589|55N|559|56N|569|EN|TU|TNX|TKS)$/,
    keyword: /^(CQ|TEST|DE|BK|73|88|UR|CFM|KN|SK|AR|QRZ|QRL|QTH|QSL|QSB|QRM|QRN|OP|ES|FB|GA|GE|GM|GL|CUL|OM|YL|RST|AGN|PSE|HW|RIG|ANT|WX|DX|=|\+)$/,
    callsign: /^[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,3}[A-Z](\/[A-Z0-9]+)?$/,
};

/** Class name for one token (exchanges first, then keywords, then callsigns). */
function cwTokenClass(tok) {
    if (CW_HIGHLIGHT.exchange.test(tok)) return 'cwd-exch';
    if (CW_HIGHLIGHT.keyword.test(tok)) return 'cwd-kw';
    if (CW_HIGHLIGHT.callsign.test(tok)) return 'cwd-call';
    return 'cwd-plain';
}

/**
 * Fold `chunk` onto the unfinished word. Completed words are `words` (an empty
 * string is a repeated space). `pending` is the tail that may still grow.
 */
function cwConsumeText(pending, chunk) {
    const parts = (pending + chunk).split(' ');
    const next = parts.pop();
    return { words: parts, pending: next };
}

class CWDecoder {
    /**
     * @param {DidahDemodulator} demodulator
     * @param {{ output: HTMLElement, status: HTMLElement }} els
     */
    constructor(demodulator, els) {
        this.demod = demodulator;
        this.els = els;
        this.worker = null;
        this.active = false;
        this.modelState = 'off';
        this.modelDetail = '';
        this.rate = 0;
        this.pending = '';
        this.pendingEl = null;
        this.len = 0;
        this.maxChars = 4000;
        this.chunkSamples = 0;
        this.pool = [];
        this.hold = [];
        this.cur = null;
        this.fill = 0;
        this.made = 0;
        this.inFlight = 0;
        this.epoch = 0;
        this.onTap = (i, q, n) => this._tap(i, q, n);
        /** CWRecorder fed with the tap at the decoder rate; any reset ends its clip. */
        this.recorder = null;
        /** Set when the model or onnxruntime files are not served (they are not in git). */
        this.missing = '';
    }

    /** The decoder cannot run: say why instead of starting a worker that will fail. */
    setMissing(detail) {
        this.missing = detail || '';
        if (this.missing) {
            this.stop();
            this._status('missing', this.missing);
        }
    }

    /** Nearest multiple of 800 (Kiwi reports e.g. 12001.2 Hz; the 0.01 % error is irrelevant). */
    static usableRate(rate) {
        const r = Math.round(rate / 800) * 800;
        return Math.abs(r - rate) / rate < 0.01 ? r : 0;
    }

    /**
     * Rate the worker's frontend is built at. A channel rate that does not snap
     * (the 44.1 kHz family lands on 11025) is resampled to 12000. Anything else is refused.
     */
    static ratePlan(audioRate) {
        const direct = CWDecoder.usableRate(audioRate);
        if (direct) return { rate: direct, resample: false };
        if (audioRate >= 8000 && audioRate <= 48000) return { rate: 12000, resample: true };
        return { rate: 0, resample: false };
    }

    start(audioRate) {
        if (this.missing) { this._status('missing', this.missing); return; }
        const plan = CWDecoder.ratePlan(audioRate);
        if (!plan.rate) { this._status('error', `unsupported rate ${audioRate}`); return; }
        this._bindResampler(audioRate, plan);
        const rate = plan.rate;
        if (!this.worker) {
            this.worker = new Worker('js/cw_decoder_worker.js');
            this.worker.onmessage = (ev) => this._onMessage(ev.data);
            this.worker.onerror = (e) => this._status('error', e.message || 'worker error');
            this.worker.postMessage({
                type: 'init', rate,
                ortUrl: new URL('lib/ort.wasm.min.js', document.baseURI).href,
                wasmPath: new URL('lib/', document.baseURI).href,
                modelUrl: new URL('models/didahcw.onnx', document.baseURI).href,
                metaUrl: new URL('models/didahcw.onnx.json', document.baseURI).href,
            });
            this.modelState = 'loading';
            this.modelDetail = '';
        } else if (rate !== this.rate) {
            this.worker.postMessage({ type: 'rate', rate });
        }
        if (this.worker) this.worker.postMessage({ type: 'run', on: true });
        this.rate = rate;
        this._setChunk(rate);
        this.active = true;
        this.demod.tapCallback = this.onTap;
        // The worker reports ready only once. A later start (CW again, or the window reopened)
        // must repaint that state; stop() has left the badge on STANDBY.
        this._status(this.modelState, this.modelDetail);
    }

    stop() {
        this.active = false;
        if (this.recorder) this.recorder.stop('decoder off');
        if (this.demod.tapCallback === this.onTap) this.demod.tapCallback = null;
        if (this.worker) this.worker.postMessage({ type: 'run', on: false });
        if (this.missing) this._status('missing', this.missing);
        else this._status(this.worker ? 'standby' : 'off');
    }

    setRate(audioRate) {
        if (!this.active) return;
        const plan = CWDecoder.ratePlan(audioRate);
        if (!plan.rate) {
            this.stop();
            this._status('error', `unsupported rate ${audioRate}`);
            return;
        }
        this._bindResampler(audioRate, plan);
        if (plan.rate !== this.rate) {
            this.rate = plan.rate;
            this._setChunk(plan.rate);
            if (this.worker) this.worker.postMessage({ type: 'rate', rate: plan.rate });
        }
    }

    /** Drop the decoder state (retune, bandwidth or source change). Keeps the transcript. */
    reset() {
        if (this.recorder) this.recorder.stop('reset');
        this.fill = 0;
        if (this._poly) this._poly.reset();
        if (this.worker) this.worker.postMessage({ type: 'reset' });
    }

    clear() {
        this.pending = '';
        this.pendingEl = null;
        this.len = 0;
        const el = this.els.output;
        if (el) el.textContent = '';
    }

    // ---- internals ------------------------------------------------------------------------------
    _setChunk(rate) {
        this.chunkSamples = Math.round(rate * 0.2); // 200 ms per transfer
        this.pool = [];
        this.hold = [];
        this.cur = null;
        this.fill = 0;
        this.made = 0;
        this.inFlight = 0;
        this.epoch++;
    }

    /**
     * A recycled buffer, or a new one until eight exist. After that the oldest
     * chunk still waiting to be sent is dropped and its storage reused. If every
     * buffer is in the worker, the caller drops the new samples.
     */
    _takeBuffer() {
        if (this.pool.length) return this.pool.pop();
        if (this.made < 8) {
            this.made++;
            return { i: new Float32Array(this.chunkSamples), q: new Float32Array(this.chunkSamples) };
        }
        if (this.hold.length) return this.hold.shift();
        return null;
    }

    _drain() {
        if (this.inFlight || !this.hold.length || !this.worker) return;
        const b = this.hold.shift();
        this.inFlight = 1;
        this.worker.postMessage(
            { type: 'audio', i: b.i, q: b.q, n: this.chunkSamples, epoch: this.epoch },
            [b.i.buffer, b.q.buffer]
        );
    }

    _bindResampler(audioRate, plan) {
        if (!plan.resample) {
            this._poly = null;
            return;
        }
        if (!this._poly || this._poly.inRate !== audioRate || this._poly.outRate !== plan.rate) {
            this._poly = new CwTapResampler(audioRate, plan.rate);
        }
    }

    _tap(i, q, n) {
        if (!this.active || !this.worker) return;
        if (this._poly) {
            n = this._poly.process(i, q, n);
            if (n <= 0) return;
            i = this._poly.outI;
            q = this._poly.outQ;
        }
        if (this.recorder) this.recorder.pushTap(i, q, n);
        let p = 0;
        const samples = this.chunkSamples;
        while (p < n) {
            if (!this.cur) {
                this.cur = this._takeBuffer();
                this.fill = 0;
                if (!this.cur) return;
            }
            const room = samples - this.fill;
            const take = room < n - p ? room : n - p;
            const dstI = this.cur.i;
            const dstQ = this.cur.q;
            const fill = this.fill;
            for (let j = 0; j < take; j++) {
                dstI[fill + j] = i[p + j];
                dstQ[fill + j] = q[p + j];
            }
            this.fill = fill + take;
            p += take;
            if (this.fill === samples) {
                this.hold.push(this.cur);
                this.cur = null;
                this._drain();
            }
        }
    }

    _onMessage(m) {
        switch (m.type) {
            case 'recycle':
                if (m.epoch !== this.epoch) break;
                this.inFlight = 0;
                if (m.i && m.i.length === this.chunkSamples && this.pool.length < 8) this.pool.push({ i: m.i, q: m.q });
                this._drain();
                break;
            case 'text':
                if (this.recorder) this.recorder.pushText(m.text);
                this._appendChunk(m.text || '');
                break;
            case 'status':
                this.modelState = m.state;
                this.modelDetail = m.detail || '';
                this._status(this.active || m.state === 'error' ? m.state : 'standby', m.detail);
                break;
        }
    }

    _appendChunk(chunk) {
        if (!chunk) return;
        const el = this.els.output;
        if (!el || typeof document === 'undefined') return;
        const step = cwConsumeText(this.pending, chunk);
        this.pending = step.pending;
        for (let w = 0; w < step.words.length; w++) this._commitWord(step.words[w]);
        this._setPending(this.pending);
        this.len += chunk.length;
        this._trim();
        el.scrollTop = el.scrollHeight;
    }

    _ensurePending() {
        const el = this.els.output;
        if (this.pendingEl && this.pendingEl.parentNode === el) return;
        const span = document.createElement('span');
        span.className = 'cwd-pending';
        el.appendChild(span);
        this.pendingEl = span;
    }

    _commitWord(word) {
        const el = this.els.output;
        this._ensurePending();
        if (word) {
            const span = document.createElement('span');
            span.className = cwTokenClass(word);
            span.textContent = word;
            el.insertBefore(span, this.pendingEl);
        }
        el.insertBefore(document.createTextNode(' '), this.pendingEl);
    }

    _setPending(tail) {
        this._ensurePending();
        this.pendingEl.textContent = tail;
        this.pendingEl.className = 'cwd-pending';
    }

    _trim() {
        const el = this.els.output;
        while (this.len > this.maxChars && el.firstChild && el.firstChild !== this.pendingEl) {
            const node = el.firstChild;
            this.len -= node.textContent.length;
            el.removeChild(node);
        }
        if (this.len > this.maxChars && this.pendingEl) {
            const extra = this.len - this.maxChars;
            const t = this.pendingEl.textContent;
            if (extra < t.length) {
                this.pending = t.slice(extra);
                this.pendingEl.textContent = this.pending;
                this.len = this.maxChars;
            }
        }
    }

    _status(state, detail) {
        const el = this.els.status;
        if (!el) return;
        const label = { loading: 'LOADING', ready: 'DECODING', standby: 'STANDBY', off: 'OFF', error: 'ERROR', missing: 'NO MODEL' }[state] || state.toUpperCase();
        el.textContent = label;
        el.className = `cwd-status cwd-status-${state}`;
        el.title = detail || '';
    }
}

if (typeof module !== 'undefined') module.exports = { CWDecoder, cwTokenClass, cwConsumeText, CW_HIGHLIGHT };
