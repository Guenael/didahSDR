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

function escapeHtml(s) {
    return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

/** Completed words become spans; the trailing partial word stays plain (it may still grow). */
function cwHighlightHtml(text) {
    const parts = text.split(' ');
    const tail = parts.pop();
    const done = parts.map((w) => (w ? `<span class="${cwTokenClass(w)}">${escapeHtml(w)}</span>` : '')).join(' ');
    return done + (parts.length ? ' ' : '') + `<span class="cwd-pending">${escapeHtml(tail)}</span>`;
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
        this.rate = 0;
        this.text = '';
        this.maxChars = 4000;
        this.chunkSamples = 0;
        this.pool = [];
        this.cur = null;
        this.fill = 0;
        this.onTap = (i, q, n) => this._tap(i, q, n);
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
            this._status('loading');
        } else if (rate !== this.rate) {
            this.worker.postMessage({ type: 'rate', rate });
        }
        this.rate = rate;
        this._setChunk(rate);
        this.active = true;
        this.demod.tapCallback = this.onTap;
    }

    stop() {
        this.active = false;
        if (this.demod.tapCallback === this.onTap) this.demod.tapCallback = null;
        this._status(this.worker ? 'standby' : 'off');
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
        this.fill = 0;
        if (this._poly) this._poly.reset();
        if (this.worker) this.worker.postMessage({ type: 'reset' });
    }

    clear() {
        this.text = '';
        this._render();
    }

    // ---- internals ------------------------------------------------------------------------------
    _setChunk(rate) {
        this.chunkSamples = Math.round(rate * 0.2); // 200 ms per transfer
        this.pool = [];
        this.cur = null;
        this.fill = 0;
    }

    _buffer() {
        if (this.pool.length) return this.pool.pop();
        return { i: new Float32Array(this.chunkSamples), q: new Float32Array(this.chunkSamples) };
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
        let p = 0;
        while (p < n) {
            if (!this.cur) { this.cur = this._buffer(); this.fill = 0; }
            const room = this.chunkSamples - this.fill;
            const take = Math.min(room, n - p);
            this.cur.i.set(i.subarray(p, p + take), this.fill);
            this.cur.q.set(q.subarray(p, p + take), this.fill);
            this.fill += take;
            p += take;
            if (this.fill === this.chunkSamples) {
                const b = this.cur;
                this.cur = null;
                this.worker.postMessage({ type: 'audio', i: b.i, q: b.q, n: this.chunkSamples }, [b.i.buffer, b.q.buffer]);
            }
        }
    }

    _onMessage(m) {
        switch (m.type) {
            case 'recycle':
                if (m.i.length === this.chunkSamples && this.pool.length < 8) this.pool.push({ i: m.i, q: m.q });
                break;
            case 'text':
                this.text += m.text;
                if (this.text.length > this.maxChars) this.text = this.text.slice(-this.maxChars);
                this._render();
                break;
            case 'status':
                this._status(this.active || m.state === 'error' ? m.state : 'standby', m.detail);
                break;
        }
    }

    _render() {
        const el = this.els.output;
        if (!el) return;
        el.innerHTML = cwHighlightHtml(this.text);
        el.scrollTop = el.scrollHeight;
    }

    _status(state, detail) {
        const el = this.els.status;
        if (!el) return;
        const label = { loading: 'LOADING', ready: 'DECODING', standby: 'STANDBY', off: 'OFF', error: 'ERROR' }[state] || state.toUpperCase();
        el.textContent = label;
        el.className = `cwd-status cwd-status-${state}`;
        el.title = detail || '';
    }
}

if (typeof module !== 'undefined') module.exports = { CWDecoder, cwTokenClass, cwHighlightHtml, CW_HIGHLIGHT };
