/**
 * didahSDR - REC for the CW decoder: captures a labelled-dataset clip at the decoder tap.
 *
 * One clip writes three files for the same instant (format: docs/recording.md):
 *   <name>.wav        stereo int16 I/Q at the decoder rate: exactly what the model reads
 *                     (channel filtered, pre-BFO / AGC / NR, carrier at DC, after CwTapResampler).
 *   <name>.audio.wav  mono int16 demodulated audio at the channel rate: what the operator heard.
 *   <name>.json       sidecar (tuning, rates, gains, live model decode as a draft transcript).
 * Each WAV is peak-normalised to -1 dBFS; the gain is in the sidecar. The model features are
 * ln|X| minus a median floor, so the scale does not change what the model sees.
 */

const REC_MAX_S = 600;
const REC_PEAK = Math.pow(10, -1 / 20);

/** Gain that brings the largest |sample| over all chunks to -1 dBFS (1 for silence). */
function peakGain(chunks) {
    let peak = 0;
    for (const c of chunks) {
        for (let k = 0; k < c.length; k++) {
            const a = Math.abs(c[k]);
            if (a > peak) peak = a;
        }
    }
    return peak > 0 ? REC_PEAK / peak : 1;
}

/** PCM int16 WAV from interleaved float chunks. Values are scaled by `gain` and clipped. */
function encodeWavInt16(chunks, channels, rate, gain = 1) {
    let n = 0;
    for (const c of chunks) n += c.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const str = (o, s) => { for (let k = 0; k < s.length; k++) v.setUint8(o + k, s.charCodeAt(k)); };
    str(0, 'RIFF');
    v.setUint32(4, 36 + n * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, channels, true);
    v.setUint32(24, rate, true);
    v.setUint32(28, rate * channels * 2, true);
    v.setUint16(32, channels * 2, true);
    v.setUint16(34, 16, true);
    str(36, 'data');
    v.setUint32(40, n * 2, true);
    const out = new Int16Array(buf, 44, n);
    let p = 0;
    for (const c of chunks) {
        for (let k = 0; k < c.length; k++) {
            const s = Math.round(c[k] * gain * 32768);
            out[p++] = s > 32767 ? 32767 : (s < -32768 ? -32768 : s);
        }
    }
    return buf;
}

/** didah_20260922_143005_14050800 (UTC), noise_ prefix in noise mode. */
function recName(date, carrierHz, kind) {
    const z = (x) => String(x).padStart(2, '0');
    const d = `${date.getUTCFullYear()}${z(date.getUTCMonth() + 1)}${z(date.getUTCDate())}`;
    const t = `${z(date.getUTCHours())}${z(date.getUTCMinutes())}${z(date.getUTCSeconds())}`;
    return `${kind === 'noise' ? 'noise_' : ''}didah_${d}_${t}_${Math.round(carrierHz)}`;
}

/** How long a stopped clip waits for the decoder to catch up (model lookahead + one step) at most. */
const REC_DRAIN_MS = 3000;
/** Stops after which the decoder keeps running, so the clip's last characters are still coming. */
const REC_DRAIN_REASONS = new Set(['user', 'limit']);

class CWRecorder {
    /** @param {{ onStop?: (clip: object) => void, maxSeconds?: number, drainMs?: number }} [opts] */
    constructor(opts = {}) {
        this.onStop = opts.onStop || null;
        this.maxSeconds = opts.maxSeconds || REC_MAX_S;
        this.drainMs = opts.drainMs != null ? opts.drainMs : REC_DRAIN_MS;
        this.recording = false;
        this.draining = false;
        this.meta = null;
        this._drainTimer = null;
    }

    /**
     * @param {{ rate: number, audioRate: number, carrierHz: number, kind?: string }} meta
     *   rate = decoder tap rate, audioRate = demodulated audio rate; any other key goes to the sidecar.
     */
    start(meta) {
        if (this.draining) this._finish();
        this.meta = { kind: 'signal', ...meta };
        this.started = new Date();
        this.iq = [];
        this.audio = [];
        this.frames = 0;
        this.hyp = '';
        this.startPos = null;   // decoder tap clock (CWDecoder.tapPos) of the first recorded sample
        this.endPos = Infinity;
        this.recording = true;
    }

    get seconds() {
        return this.recording ? this.frames / this.meta.rate : 0;
    }

    /** `pos`: decoder tap clock of i[0], used to align the live decode with the clip. */
    pushTap(i, q, n, pos) {
        if (!this.recording) return;
        if (this.startPos == null && pos != null) this.startPos = pos;
        const c = new Float32Array(2 * n);
        for (let k = 0; k < n; k++) {
            c[2 * k] = i[k];
            c[2 * k + 1] = q[k];
        }
        this.iq.push(c);
        this.frames += n;
        if (this.frames >= this.maxSeconds * this.meta.rate) this.stop('limit');
    }

    pushAudio(buf, n = buf.length) {
        if (this.recording) this.audio.push(buf.slice(0, n));
    }

    /**
     * Live decode for the draft transcript. The model answers about a second late, so the first text
     * after REC describes audio from before the clip: with `at` (tap position of each character) only
     * the characters inside [start, end) are kept. `upTo` (decoded so far) ends a draining clip.
     */
    pushText(text, at, upTo) {
        if (!this.recording && !this.draining) return;
        if (!at || this.startPos == null) {
            if (this.recording) this.hyp += text;
        } else {
            for (let k = 0; k < text.length; k++) {
                const p = at[k];
                if (p == null || (p >= this.startPos && p < this.endPos)) this.hyp += text[k];
            }
        }
        if (this.draining && upTo != null && upTo >= this.endPos) this._finish();
    }

    /**
     * Ends the clip. After a user stop (or the length cap) the decoder is still running, so the clip is
     * saved once the decode has caught up with its last sample (or after drainMs); stop() then returns
     * null and onStop gets the clip. Any other stop (reset, decoder off) saves at once and returns it.
     */
    stop(reason = 'user') {
        if (this.draining) return this._finish();
        if (!this.recording) return null;
        this.recording = false;
        if (!this.frames) return null;
        this.stopReason = reason;
        if (this.startPos != null && REC_DRAIN_REASONS.has(reason) && this.drainMs > 0) {
            this.endPos = this.startPos + this.frames;
            this.draining = true;
            this._drainTimer = setTimeout(() => this._finish(), this.drainMs);
            return null;
        }
        return this._finish();
    }

    _finish() {
        if (this._drainTimer) {
            clearTimeout(this._drainTimer);
            this._drainTimer = null;
        }
        this.draining = false;
        const m = this.meta;
        const gain = peakGain(this.iq);
        const audioGain = peakGain(this.audio);
        const { rate, audioRate, carrierHz, ...rest } = m;
        const name = recName(this.started, carrierHz, m.kind);
        const sidecar = {
            ...rest,
            carrier_hz: Math.round(carrierHz),
            rate,
            audio_rate: audioRate,
            gain,
            audio_gain: audioGain,
            started_utc: this.started.toISOString(),
            duration_s: +(this.frames / rate).toFixed(3),
            stop_reason: this.stopReason,
            hyp: this.hyp.trim(),
        };
        const clip = {
            name,
            sidecar,
            iqWav: encodeWavInt16(this.iq, 2, rate, gain),
            audioWav: encodeWavInt16(this.audio, 1, Math.round(audioRate), audioGain),
        };
        this.iq = [];
        this.audio = [];
        if (this.onStop) this.onStop(clip);
        return clip;
    }
}

/** Browser download of the three files of a clip. */
function saveRecording(clip) {
    const files = [
        [`${clip.name}.wav`, new Blob([clip.iqWav], { type: 'audio/wav' })],
        [`${clip.name}.audio.wav`, new Blob([clip.audioWav], { type: 'audio/wav' })],
        [`${clip.name}.json`, new Blob([JSON.stringify(clip.sidecar, null, 2) + '\n'], { type: 'application/json' })],
    ];
    for (const [fname, blob] of files) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fname;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
}

if (typeof module !== 'undefined') {
    module.exports = { CWRecorder, encodeWavInt16, peakGain, recName, saveRecording, REC_MAX_S, REC_DRAIN_MS };
}
