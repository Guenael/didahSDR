/**
 * didahSDR - Local sound-card IQ source (SoftRock-style stereo I/Q)
 *
 * Allowed native rates: 48 / 96 / 192 kHz. Other rates (e.g. 44.1 kHz) are listed but not selectable.
 * I = left, Q = right, unless swap is on. Center frequency is 0 (audio/offset Hz).
 */

const SOUND_RATES = [48000, 96000, 192000];

function isSoundRate(rate) {
    const r = Math.round(Number(rate) || 0);
    return SOUND_RATES.indexOf(r) >= 0;
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

    enable() {
        return enableAudioInputs(this, {}, { name: 'Sound card', listing: 'Listing sound-card inputs…' });
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
        }, RAW_AUDIO_CONSTRAINTS, extra || {});
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
                        ...RAW_AUDIO_CONSTRAINTS
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

    _abandon(stream, ctx) {
        return abandonCapture(this, stream, ctx);
    }

    _shutdown() {
        return shutdownCapture(this);
    }
}

if (typeof globalThis !== 'undefined') globalThis.packStereoIq = packStereoIq;

if (typeof module !== 'undefined') {
    module.exports = {
        SoundcardSource, SOUND_RATES, isSoundRate, packStereoIq
    };
}
