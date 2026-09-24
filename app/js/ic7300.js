/**
 * didahSDR - IC-7300 audio + CI-V facade
 *
 * Audio is the PCM2901 real IF. Open at 48 kHz when the browser allows it.
 * The capture worklet shifts the 12 kHz IF to DC and decimates to ~12 kHz
 * complex before the rest of the pipeline sees a sample. The node is mono
 * so Chrome does not silence a one-channel USB input. CI-V is a separate
 * Web Serial session; this file never sends a frequency.
 */

const IC7300_AUDIO_OFF = {
    echoCancellation: false,
    autoGainControl: false,
    noiseSuppression: false
};

class Ic7300Source {
    constructor(options) {
        const opts = options || {};
        this.onRawIQ = opts.onRawIQ || null;
        this.onReady = opts.onReady || null;
        this.onStatusChange = opts.onStatusChange || null;
        this.onDevices = opts.onDevices || null;
        this.onFrequency = opts.onFrequency || null;
        this.onMode = opts.onMode || null;

        this.devices = [];
        this.deviceId = '';
        this.connected = false;
        this.sampleRate = IC7300_OUT_RATE;
        this.trackRate = 0;
        this.channels = 0;
        this.serialText = 'CI-V not connected.';

        this.ctx = null;
        this.stream = null;
        this.node = null;
        this.sourceNode = null;
        this.mute = null;
        this._starting = false;
        this._gen = 0;
        this._feedGen = 0;

        this.cat = new Ic7300Cat({
            onFrequency: (hz) => { if (this.onFrequency) this.onFrequency(hz); },
            onMode: (mode, filter) => { if (this.onMode) this.onMode(mode, filter); },
            onStatus: (text, ok) => {
                this.serialText = text;
                this._status(text, ok);
            }
        });
    }

    _status(text, ok) {
        if (this.onStatusChange) this.onStatusChange(text, !!ok);
    }

    setBaud(baud) {
        return this.cat.setBaud(parseInt(baud, 10));
    }

    connectSerial() {
        return this.cat.connect();
    }

    disconnectSerial() {
        return this.cat.disconnect();
    }

    setWiring(mode) {
        this.cat.setWiring(mode);
    }

    setFrequency(hz) {
        this.cat.setFrequency(hz);
    }

    setMode(mode, filter) {
        this.cat.setMode(mode, filter);
    }

    setCwSpeed(wpm) {
        this.cat.setKeySpeed(wpm);
    }

    sendCw(text) {
        return this.cat.sendCw(text);
    }

    setLines(keyDown, sendHeld) {
        return this.cat.setLines(keyDown, sendHeld);
    }

    releaseKey() {
        return this.cat.releaseKey();
    }

    async enable() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            this._status('IC-7300 audio needs a secure context (https or localhost).', false);
            return false;
        }
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: Object.assign({ sampleRate: { ideal: IC7300_NATIVE_RATE } }, IC7300_AUDIO_OFF)
            });
        } catch (e) {
            this._status('Microphone permission denied.', false);
            return false;
        }
        stream.getTracks().forEach((t) => t.stop());
        this._status('Listing audio inputs (48 kHz)…', false);
        await this.refreshDevices();
        onAudioDevicesChanged(() => { this.refreshDevices(); }, this);
        return true;
    }

    async refreshDevices() {
        this.devices = await listAudioInputs();
        if (this.onDevices) this.onDevices(this.devices);
        return this.devices;
    }

    _gum(deviceId, extra) {
        const audio = Object.assign({
            deviceId: deviceId ? { exact: deviceId } : undefined
        }, IC7300_AUDIO_OFF, extra || {});
        return navigator.mediaDevices.getUserMedia({ audio });
    }

    async start(deviceId) {
        if (this._starting) return;
        this._starting = true;
        const gen = ++this._gen;
        try {
            await this._shutdown();
            if (gen !== this._gen) return;
            if (!deviceId) {
                this._status('Select the IC-7300 audio input.', false);
                return;
            }
            let stream;
            try {
                stream = await this._gum(deviceId, {
                    sampleRate: { ideal: IC7300_NATIVE_RATE },
                    channelCount: { ideal: 1 }
                });
            } catch (e) {
                stream = await this._gum(deviceId, {});
            }
            this.stream = stream;
            const track = stream.getAudioTracks()[0];
            const settings = (track && track.getSettings && track.getSettings()) || {};
            this.trackRate = Math.round(Number(settings.sampleRate) || 0);
            this.channels = Math.round(Number(settings.channelCount) || 1);

            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            let ctx;
            try {
                ctx = new AudioCtx({ sampleRate: IC7300_NATIVE_RATE });
            } catch (e) {
                ctx = new AudioCtx();
            }
            this.ctx = ctx;
            await ctx.resume();
            if (!ctx.audioWorklet) {
                await this._abandon(stream, ctx);
                this._status('IC-7300 capture needs AudioWorklet.', false);
                return;
            }

            if (gen !== this._gen) {
                await this._abandon(stream, ctx);
                return;
            }
            await ctx.audioWorklet.addModule('js/demodulator.js');
            await ctx.audioWorklet.addModule('js/ic7300_if.js');
            await ctx.audioWorklet.addModule('js/audio_capture_worklet.js');
            if (gen !== this._gen) {
                await this._abandon(stream, ctx);
                return;
            }
            const sourceNode = ctx.createMediaStreamSource(stream);
            const node = new AudioWorkletNode(ctx, 'audio-capture', {
                processorOptions: { mode: 'real-if' },
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [1],
                channelCount: 1,
                channelCountMode: 'explicit',
                channelInterpretation: 'speakers'
            });
            node.port.onmessage = (e) => {
                const m = e.data;
                if (!m || m.type !== 'iq' || !m.samples) return;
                if (gen !== this._gen) return;
                if (this.onRawIQ) this.onRawIQ(m.samples, m.n || (m.samples.length >> 1));
                node.port.postMessage({ type: 'recycle', samples: m.samples }, [m.samples.buffer]);
            };

            const mute = ctx.createGain();
            mute.gain.value = 0;
            const plan = ic7300DecimPlan(ctx.sampleRate);
            this.stream = stream;
            this.ctx = ctx;
            this.node = node;
            this.sourceNode = sourceNode;
            this.mute = mute;
            this.deviceId = deviceId;
            this.sampleRate = plan.outRate;
            this._feedGen = gen;
            this.connected = true;
            const trackTxt = this.trackRate ? (this.trackRate / 1000) + ' kHz' : 'unknown';
            this._status(
                'IC-7300 IF · track ' + trackTxt + ' · ' + this.channels + ' ch · '
                + (ctx.sampleRate / 1000) + ' kHz → ' + (plan.outRate / 1000) + ' kHz IQ.',
                true
            );
            // Publish the decimated rate before the graph runs, so the first
            // packet is demodulated at 12 kHz rather than the previous source rate.
            if (this.onReady) {
                this.onReady({
                    sampleRate: this.sampleRate,
                    trackRate: this.trackRate,
                    channels: this.channels,
                    contextRate: Math.round(ctx.sampleRate),
                    deviceId
                });
            }
            sourceNode.connect(node);
            node.connect(mute);
            mute.connect(ctx.destination);
        } catch (e) {
            this._status((e && e.message) ? e.message : 'IC-7300 audio open failed.', false);
            await this.stop();
        } finally {
            this._starting = false;
        }
    }

    async stop() {
        this._gen++;
        this.connected = false;
        await this._shutdown();
    }

    /** Stop a capture that this start() still owns. A newer start keeps its own stream. */
    async _abandon(stream, ctx) {
        if (stream) {
            if (this.stream === stream) this.stream = null;
            stream.getTracks().forEach((t) => t.stop());
        }
        if (ctx) {
            if (this.ctx === ctx) this.ctx = null;
            try { await ctx.close(); } catch (e) { /* already closed */ }
        }
    }

    async _shutdown() {
        if (this.node) {
            try { this.node.disconnect(); } catch (e) { /* already gone */ }
            this.node = null;
        }
        if (this.sourceNode) {
            try { this.sourceNode.disconnect(); } catch (e) { /* already gone */ }
            this.sourceNode = null;
        }
        if (this.mute) {
            try { this.mute.disconnect(); } catch (e) { /* already gone */ }
            this.mute = null;
        }
        if (this.stream) {
            this.stream.getTracks().forEach((t) => t.stop());
            this.stream = null;
        }
        if (this.ctx) {
            const ctx = this.ctx;
            this.ctx = null;
            try { await ctx.close(); } catch (e) { /* already closed */ }
        }
    }
}

if (typeof globalThis !== 'undefined') globalThis.Ic7300Source = Ic7300Source;
if (typeof module !== 'undefined') module.exports = { Ic7300Source };
