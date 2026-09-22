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
        this._watchingDevices = false;

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
        if (!this._watchingDevices && navigator.mediaDevices.addEventListener) {
            this._watchingDevices = true;
            navigator.mediaDevices.addEventListener('devicechange', () => {
                this.refreshDevices();
            });
        }
        return true;
    }

    async refreshDevices() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
            this.devices = [];
            if (this.onDevices) this.onDevices(this.devices);
            return this.devices;
        }
        const all = await navigator.mediaDevices.enumerateDevices();
        const inputs = all.filter((d) => d.kind === 'audioinput');
        const listed = [];
        for (let i = 0; i < inputs.length; i++) {
            const d = inputs[i];
            const probed = await this._probeDevice(d.deviceId);
            listed.push({
                id: d.deviceId,
                label: d.label || `Audio input ${i + 1}`,
                ok: probed.ok,
                rate: probed.rate,
                channels: probed.channels,
                native: probed.native
            });
        }
        this.devices = listed;
        if (this.onDevices) this.onDevices(listed);
        return listed;
    }

    _gum(deviceId, extra) {
        const audio = Object.assign({
            deviceId: deviceId ? { exact: deviceId } : undefined
        }, IC7300_AUDIO_OFF, extra || {});
        return navigator.mediaDevices.getUserMedia({ audio });
    }

    async _probeDevice(deviceId) {
        if (!deviceId) return { ok: false, rate: 0, channels: 1, native: 0 };
        let stream;
        try {
            stream = await this._gum(deviceId, { sampleRate: { ideal: IC7300_NATIVE_RATE } });
        } catch (e) {
            try {
                stream = await this._gum(deviceId, {});
            } catch (e2) {
                return { ok: false, rate: 0, channels: 1, native: 0 };
            }
        }
        try {
            const track = stream.getAudioTracks()[0];
            const set = (track && track.getSettings && track.getSettings()) || {};
            const native = Math.round(Number(set.sampleRate) || 0);
            const channels = Math.round(Number(set.channelCount) || 1);
            return { ok: true, rate: native || IC7300_NATIVE_RATE, channels, native };
        } finally {
            stream.getTracks().forEach((t) => t.stop());
        }
    }

    async start(deviceId) {
        if (this._starting) return;
        this._starting = true;
        try {
            await this.stop();
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
            await ctx.resume();
            if (!ctx.audioWorklet) {
                stream.getTracks().forEach((t) => t.stop());
                try { await ctx.close(); } catch (err) { /* ignore */ }
                this._status('IC-7300 capture needs AudioWorklet.', false);
                return;
            }

            await ctx.audioWorklet.addModule('js/demodulator.js');
            await ctx.audioWorklet.addModule('js/ic7300_if.js');
            await ctx.audioWorklet.addModule('js/ic7300_capture_worklet.js');
            const sourceNode = ctx.createMediaStreamSource(stream);
            const node = new AudioWorkletNode(ctx, 'ic7300-capture', {
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
                if (this.onRawIQ) this.onRawIQ(m.samples);
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
        this.connected = false;
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
