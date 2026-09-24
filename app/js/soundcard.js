/**
 * didahSDR - Local sound-card IQ source (SoftRock-style stereo I/Q)
 *
 * Allowed native rates: 48 / 96 / 192 kHz. Other rates (e.g. 44.1 kHz) are listed but not selectable.
 * I = left, Q = right, unless swap is on. Center frequency is 0 (audio/offset Hz).
 */

const SOUND_RATES = [48000, 96000, 192000];
/** Try 96 kHz first (SoftRock), then 48, then 192. Browsers disagree on the unconstrained default. */
const PREFERRED_RATES = [96000, 48000, 192000];

function isSoundRate(rate) {
    const r = Math.round(Number(rate) || 0);
    return SOUND_RATES.indexOf(r) >= 0;
}

/** First rate in PREFERRED_RATES that appears in `working` (already rounded Hz). */
function preferredCaptureRate(working) {
    const set = working || [];
    for (let i = 0; i < PREFERRED_RATES.length; i++) {
        if (set.indexOf(PREFERRED_RATES[i]) >= 0) return PREFERRED_RATES[i];
    }
    return 0;
}

/**
 * Pick 48, 96 or 192 kHz inside [min, max], preferring `native` when it is allowed,
 * otherwise the highest allowed rate. Returns 0 if none fit.
 */
function pickSoundRate(min, max, native) {
    const lo = min == null ? -Infinity : min;
    const hi = max == null ? Infinity : max;
    const n = Math.round(Number(native) || 0);
    if (isSoundRate(n) && n >= lo && n <= hi) return n;
    for (let i = SOUND_RATES.length - 1; i >= 0; i--) {
        const r = SOUND_RATES[i];
        if (r >= lo && r <= hi) return r;
    }
    return 0;
}

/**
 * Pack stereo Float32 channels into interleaved Float32 I/Q (±1).
 * `dstOff` is the complex-sample index in `dst`. `count` frames are read
 * from `srcOff` (default: the whole of `left`). A missing right channel is silence.
 * The capture worklet calls this; do not keep a second copy of the mapping.
 */
function packStereoIq(left, right, swap, dst, dstOff, count, srcOff) {
    const n = count == null ? left.length : count;
    const s0 = srcOff || 0;
    const base = (dstOff || 0) * 2;
    const qSrc = right && right.length ? right : null;
    for (let i = 0; i < n; i++) {
        const s = s0 + i;
        const iSamp = swap ? (qSrc ? qSrc[s] : 0) : left[s];
        const qSamp = swap ? left[s] : (qSrc ? qSrc[s] : 0);
        dst[base + i * 2] = iSamp;
        dst[base + i * 2 + 1] = qSamp;
    }
    return n;
}

/**
 * @param {{ channelCount?: number, sampleRate?: number, sampleRateMin?: number, sampleRateMax?: number }} info
 * @returns {{ ok: boolean, rate: number, channels: number, native: number }}
 */
function classifyCapture(info) {
    const ch = Math.round(Number(info.channelCount) || 1);
    const native = Math.round(Number(info.sampleRate) || 0);
    const min = info.sampleRateMin != null ? info.sampleRateMin : native || null;
    const max = info.sampleRateMax != null ? info.sampleRateMax : native || null;
    const rate = pickSoundRate(min, max, native);
    return { ok: ch >= 2 && rate > 0, rate, channels: ch, native };
}

function trackCaptureInfo(track) {
    const set = (track.getSettings && track.getSettings()) || {};
    const cap = (track.getCapabilities && track.getCapabilities()) || {};
    const sr = cap.sampleRate || {};
    const ch = cap.channelCount || {};
    return classifyCapture({
        channelCount: ch.max || set.channelCount || 1,
        sampleRate: set.sampleRate,
        sampleRateMin: sr.min,
        sampleRateMax: sr.max
    });
}

const AUDIO_CONSTRAINTS_OFF = {
    echoCancellation: false,
    autoGainControl: false,
    noiseSuppression: false
};

class SoundcardSource {
    constructor(options) {
        this.onRawIQ = options.onRawIQ || null;
        this.onReady = options.onReady || null;
        this.onStatusChange = options.onStatusChange || null;
        this.onDevices = options.onDevices || null;

        this.devices = [];
        this.deviceId = '';
        this.swap = false;
        this.connected = false;
        this.sampleRate = 96000;

        this.ctx = null;
        this.stream = null;
        this.node = null;
        this.sourceNode = null;
        this.mute = null;
        this._starting = false;
        this._gen = 0;
        this._feedGen = 0;
    }

    setSwap(on) {
        this.swap = !!on;
        if (this.node) this.node.port.postMessage({ type: 'swap', on: this.swap });
    }

    _status(text, ok) {
        if (this.onStatusChange) this.onStatusChange(text, !!ok);
    }

    async enable() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            this._status('Sound card needs a secure context (https or localhost).', false);
            return false;
        }
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: Object.assign({}, AUDIO_CONSTRAINTS_OFF)
            });
        } catch (e) {
            this._status('Microphone permission denied.', false);
            return false;
        }
        stream.getTracks().forEach((t) => t.stop());
        this._status('Listing sound-card inputs…', false);
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
            deviceId: { exact: deviceId },
            channelCount: { ideal: 2 }
        }, AUDIO_CONSTRAINTS_OFF, extra || {});
        return navigator.mediaDevices.getUserMedia({ audio });
    }

    _readTrack(stream) {
        const track = stream.getAudioTracks()[0];
        if (!track) return { channels: 1, sampleRate: 0 };
        const set = (track.getSettings && track.getSettings()) || {};
        return {
            channels: Math.round(Number(set.channelCount) || 1),
            sampleRate: Math.round(Number(set.sampleRate) || 0)
        };
    }

    async start(deviceId) {
        if (this._starting) return;
        this._starting = true;
        const gen = ++this._gen;
        try {
            await this._shutdown();
            if (gen !== this._gen) return;
            if (!deviceId) {
                this._status('Select a sound-card device.', false);
                return;
            }
            const listed = this.devices.find((d) => d.id === deviceId);
            if (listed && !listed.ok) {
                this._status('That device is not 48 / 96 / 192 kHz stereo IQ.', false);
                return;
            }

            const want = (listed && listed.rate) || 96000;
            let stream;
            try {
                stream = await this._gum(deviceId, { sampleRate: { ideal: want }, channelCount: { ideal: 2 } });
            } catch (e) {
                stream = await this._gum(deviceId, {});
            }
            this.stream = stream;
            const track = stream.getAudioTracks()[0];
            if (track && track.applyConstraints) {
                try {
                    await track.applyConstraints({
                        deviceId: { exact: deviceId },
                        channelCount: { ideal: 2 },
                        sampleRate: { ideal: want },
                        echoCancellation: false,
                        autoGainControl: false,
                        noiseSuppression: false
                    });
                } catch (e) { /* Chrome often rejects these */ }
            }
            const settings = (track && track.getSettings && track.getSettings()) || {};

            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            let ctx;
            try {
                ctx = new AudioCtx({ sampleRate: want });
            } catch (e) {
                ctx = new AudioCtx();
            }
            this.ctx = ctx;
            if (!isSoundRate(ctx.sampleRate)) {
                await this._abandon(null, ctx);
                try { ctx = new AudioCtx({ sampleRate: 48000 }); } catch (e2) { ctx = new AudioCtx(); }
                this.ctx = ctx;
            }
            if (!isSoundRate(ctx.sampleRate)) {
                const got = ctx.sampleRate;
                await this._abandon(stream, ctx);
                this._status('AudioContext is ' + got + ' Hz; need 48, 96 or 192 kHz.', false);
                return;
            }
            await ctx.resume();
            if (!ctx.audioWorklet) {
                await this._abandon(stream, ctx);
                this._status('Sound card capture needs AudioWorklet.', false);
                return;
            }

            if (gen !== this._gen) {
                await this._abandon(stream, ctx);
                return;
            }
            const trackInfo = this._readTrack(stream);
            await ctx.audioWorklet.addModule('js/soundcard.js');
            await ctx.audioWorklet.addModule('js/audio_capture_worklet.js');
            if (gen !== this._gen) {
                await this._abandon(stream, ctx);
                return;
            }
            const sourceNode = ctx.createMediaStreamSource(stream);
            sourceNode.channelCount = 2;
            sourceNode.channelCountMode = 'explicit';
            sourceNode.channelInterpretation = 'speakers';
            const node = new AudioWorkletNode(ctx, 'audio-capture', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [1],
                channelCount: 2,
                channelCountMode: 'explicit',
                processorOptions: { mode: 'stereo-iq', swap: this.swap }
            });
            node.port.onmessage = (e) => {
                const m = e.data;
                if (!m || m.type !== 'iq' || !m.samples) return;
                if (gen !== this._gen) return;
                if (this.onRawIQ) this.onRawIQ(m.samples, m.n || (m.samples.length >> 1));
                node.port.postMessage({ type: 'recycle', samples: m.samples }, [m.samples.buffer]);
            };
            node.port.postMessage({ type: 'swap', on: this.swap });

            const mute = ctx.createGain();
            mute.gain.value = 0;
            sourceNode.connect(node);
            node.connect(mute);
            mute.connect(ctx.destination);

            this.stream = stream;
            this.ctx = ctx;
            this.node = node;
            this.sourceNode = sourceNode;
            this.mute = mute;
            this.deviceId = deviceId;
            this.sampleRate = ctx.sampleRate;
            this._feedGen = gen;
            this.connected = true;
            const openedId = settings.deviceId || '';
            const chromeHint = (openedId && openedId !== deviceId)
                ? ' Chrome may be using another mic — in pavucontrol → Recording, route this tab to didahSDR_IQ.'
                : '';
            const monoWarn = trackInfo.channels < 2
                ? ' Mono input: I/Q wants stereo (left = I, right = Q).'
                : '';
            this._status('Sound card IQ · ' + (this.sampleRate / 1000) + ' kHz.' + monoWarn + chromeHint, true);
            if (this.onReady) this.onReady({ sampleRate: this.sampleRate, centerFreq: 0, deviceId });
        } catch (e) {
            this._status((e && e.message) ? e.message : 'Sound card open failed.', false);
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

if (typeof globalThis !== 'undefined') globalThis.packStereoIq = packStereoIq;

if (typeof module !== 'undefined') {
    module.exports = {
        SoundcardSource, SOUND_RATES, PREFERRED_RATES, isSoundRate, pickSoundRate,
        preferredCaptureRate, packStereoIq, classifyCapture
    };
}
