/**
 * didahSDR - REC for the CW decoder: captures a labelled-dataset clip at the decoder tap.
 *
 * One clip writes three files for the same instant (see REC-BUTTON.md):
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

class CWRecorder {
    /** @param {{ onStop?: (clip: object) => void, maxSeconds?: number }} [opts] */
    constructor(opts = {}) {
        this.onStop = opts.onStop || null;
        this.maxSeconds = opts.maxSeconds || REC_MAX_S;
        this.recording = false;
        this.meta = null;
    }

    /**
     * @param {{ rate: number, audioRate: number, carrierHz: number, kind?: string }} meta
     *   rate = decoder tap rate, audioRate = demodulated audio rate; any other key goes to the sidecar.
     */
    start(meta) {
        this.meta = { kind: 'signal', ...meta };
        this.started = new Date();
        this.iq = [];
        this.audio = [];
        this.frames = 0;
        this.hyp = '';
        this.recording = true;
    }

    get seconds() {
        return this.recording ? this.frames / this.meta.rate : 0;
    }

    pushTap(i, q, n) {
        if (!this.recording) return;
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

    pushText(text) {
        if (this.recording) this.hyp += text;
    }

    /** Ends the clip, returns it (null if nothing was captured) and hands it to onStop. */
    stop(reason = 'user') {
        if (!this.recording) return null;
        this.recording = false;
        const m = this.meta;
        if (!this.frames) return null;
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
            stop_reason: reason,
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
    module.exports = { CWRecorder, encodeWavInt16, peakGain, recName, saveRecording, REC_MAX_S };
}
