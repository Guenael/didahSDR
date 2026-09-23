/**
 * didahSDR - Web Audio Player (main-thread facade)
 *
 * Owns the AudioContext, gain/volume and the AudioWorkletNode running js/audio_worklet.js, where
 * the jitter buffer and resampler live. Audio therefore keeps playing through long main-thread
 * frames (heavy FFT bursts, waterfall drags) that used to cause underruns with ScriptProcessorNode.
 * AudioWorklet is required, like WebGL is for the waterfall.
 */

class WebAudioPlayer {
    constructor() {
        this.ctx = null;
        this.gainNode = null;
        this.node = null;            // AudioWorkletNode, set once the module has loaded
        this.ready = false;
        this.initPromise = null;

        this.volume = 0.8;
        this.muted = false;
        this.INPUT_RATE = 48000;     // demodulator output rate; the AudioContext stays at 48 kHz

        this.onStateChange = null;
        this.onLevel = null;
        this.onKeyerState = null;    // ({ tx, keyed, wantChar, consumed, gen }) from the worklet
        this.unsupported = false;
        this._keyerQueue = [];

        // Diagnostics (enable with ?audiodebug in the URL). One console line per second.
        this.debug = typeof location !== 'undefined' && /[?&]audiodebug/.test(location.search);
        this.extraStats = null;      // optional () => object, merged into the debug line
    }

    /** Creates the context and loads the worklet. Safe to call repeatedly; returns the same promise. */
    init() {
        if (this.initPromise) return this.initPromise;
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) {
            this.unsupported = true;
            console.error('didahSDR: Web Audio API not supported in this browser');
            this.initPromise = Promise.resolve();
            return this.initPromise;
        }
        try {
            this.ctx = new AudioCtx({ sampleRate: 48000, latencyHint: 'interactive' });
        } catch (e) {
            try {
                this.ctx = new AudioCtx({ latencyHint: 'interactive' });
            } catch (e2) {
                this.ctx = new AudioCtx();
            }
        }
        if (!this.ctx.audioWorklet) {
            this.unsupported = true;
            console.error('didahSDR requires AudioWorklet support.');
            this.initPromise = Promise.resolve();
            return this.initPromise;
        }

        this.gainNode = this.ctx.createGain();
        this.gainNode.gain.setValueAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime);
        this.gainNode.connect(this.ctx.destination);

        this.ctx.onstatechange = () => this.emitState();

        this.initPromise = this.ctx.audioWorklet.addModule('js/audio_ring.js')
            .then(() => this.ctx.audioWorklet.addModule('js/resampler.js'))
            .then(() => this.ctx.audioWorklet.addModule('js/cw_keyer.js'))
            .then(() => this.ctx.audioWorklet.addModule('js/audio_worklet.js'))
            .then(() => {
                this.node = new AudioWorkletNode(this.ctx, 'didah-audio', {
                    numberOfInputs: 0,
                    outputChannelCount: [1],
                    processorOptions: { inputRate: this.INPUT_RATE }
                });
                this.node.port.onmessage = (e) => this.handleWorkletMessage(e.data);
                this._sab = null;
                const isolated = typeof crossOriginIsolated === 'undefined' || crossOriginIsolated;
                if (isolated && typeof SharedArrayBuffer !== 'undefined' && typeof createSabRing === 'function') {
                    try {
                        this._sab = createSabRing();
                        this.node.port.postMessage({ type: 'sab', sab: this._sab.sab });
                    } catch (e) {
                        this._sab = null;
                    }
                }
                this.node.connect(this.gainNode);
                if (this.debug) this.node.port.postMessage({ type: 'debug', on: true });
                this.ready = true;
                const queued = this._keyerQueue;
                this._keyerQueue = [];
                for (let i = 0; i < queued.length; i++) this.node.port.postMessage(queued[i]);
                this.emitState();
            }).catch((err) => {
                this.unsupported = true;
                console.error('didahSDR: failed to load the audio worklet:', err);
                this.emitState();
            });
        this.emitState();
        return this.initPromise;
    }

    handleWorkletMessage(m) {
        if (m.type === 'keyer') {
            if (this.onKeyerState) this.onKeyerState(m);
        } else if (m.type === 'level') {
            if (this.onLevel) this.onLevel(m.peak);
        } else if (m.type === 'stats') {
            const extra = this.extraStats ? this.extraStats() : {};
            console.log(
                `[audio] blocks=${m.blocks} underruns=${m.underruns} overflows=${m.overflows} ` +
                `buf=${m.minBuf}..${m.maxBuf} (target ${m.target}) ctxRate=${this.ctx.sampleRate} ` +
                `base=${this.ctx.baseLatency?.toFixed(3)} ` +
                Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(' ')
            );
        }
    }

    emitState() {
        if (this.onStateChange) this.onStateChange(this.getState());
    }

    getState() {
        if (this.unsupported) return 'unsupported';
        if (!this.ctx || !this.ready) return 'uninitialized';
        if (this.muted) return 'muted';
        return this.ctx.state;   // 'suspended' | 'running' | 'closed'
    }

    async resume() {
        await this.init();
        if (this.ctx && this.ctx.state === 'suspended') await this.ctx.resume();
        this.emitState();
    }

    setVolume(vol) {
        this.volume = Math.max(0.0, Math.min(1.0, vol));
        if (this.gainNode && this.ctx) {
            this.gainNode.gain.setValueAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime);
        }
    }

    setMute(muteState) {
        this.muted = muteState;
        this.setVolume(this.volume);
        this.emitState();
    }

    toggleMute() {
        if (!this.ready || (this.ctx && this.ctx.state === 'suspended')) {
            this.resume();
            this.setMute(false);
            return;
        }
        this.setMute(!this.muted);
    }

    /**
     * Push Float32 mono audio (demodulator output rate) into the worklet's jitter buffer.
     * The array is copied (the demodulator reuses its output buffer) and the copy is transferred.
     * @param {Float32Array} floatArray - Mono audio samples [-1.0, 1.0]
     */
    pushFloatAudio(floatArray) {
        if (!this.initPromise) this.init();
        if (!this.ready || !this.ctx || this.ctx.state !== 'running') return;
        if (floatArray.length === 0) return;
        if (this._sab) {
            sabWrite(this._sab, floatArray);
            return;
        }
        const copy = new Float32Array(floatArray);
        this.node.port.postMessage(copy, [copy.buffer]);
    }

    /** Tell the worklet the demodulator output rate (48 kHz replay, ~12 kHz Kiwi). */
    setInputRate(rate) {
        this.INPUT_RATE = Math.max(1000, rate);
        if (this.node) this.node.port.postMessage({ type: 'inputRate', rate: this.INPUT_RATE });
    }

    resetBuffer() {
        if (this.node) this.node.port.postMessage({ type: 'reset' });
    }

    /** Control messages for the worklet-side keyer (sidetone, paddles, typeahead). */
    postKeyer(msg) {
        if (this.node) this.node.port.postMessage(msg);
        else this._keyerQueue.push(msg);
    }

    setKeyerPaddle(which, down) { this.postKeyer({ type: 'paddle', which, down: !!down }); }
    setKeyerStraight(down) { this.postKeyer({ type: 'straight', down: !!down }); }
    setKeyerWpm(wpm) { this.postKeyer({ type: 'wpm', wpm }); }
    setKeyerIambic(mode) { this.postKeyer({ type: 'iambic', mode }); }
    setSidetoneHz(hz) { this.postKeyer({ type: 'sidetone', hz }); }
    setKeyerArmed(on) { this.postKeyer({ type: 'arm', on: !!on }); }
    setKeyerHasText(on) { this.postKeyer({ type: 'hasText', on: !!on }); }
    setKeyerText(text, gen) { this.postKeyer({ type: 'setText', text: String(text || ''), gen: gen | 0 }); }
    sendKeyerChar(ch) { this.postKeyer({ type: 'char', ch: String(ch) }); }
    abortKeyer() { this.postKeyer({ type: 'abort' }); }

    stop() {
        if (this.ctx) this.ctx.suspend();
        if (this.node) this.node.port.postMessage({ type: 'reset' });
        this.emitState();
    }
}

if (typeof globalThis !== 'undefined') globalThis.WebAudioPlayer = WebAudioPlayer;
if (typeof module !== 'undefined') module.exports = WebAudioPlayer;
