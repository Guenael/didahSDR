/**
 * didahSDR - QRSS spectrum.
 *
 * Complex baseband at the channel rate, already centred on the tuned frequency and taken before the
 * channel FIR, is decimated by halfbands to about 375 Hz. A long 4-term Blackman-Harris FFT then gives
 * sub-hertz bins with ~90 dB sidelobe rejection. Frames overlap by 75 % (hop = N / 4), so each column
 * is a fresh spectrum and a keyed carrier prints as a line whose edges are only one window long.
 * No averaging between columns: that is what smeared dits into blocks.
 */

/** FFT length per WF Speed (1..8): 22 s windows (QRSS60) down to 0.7 s (fast DFCW). */
const QRSS_SIZES = [8192, 4096, 2048, 1024, 512, 256, 256, 256];
/** Visible span of the QRSS view, Hz (the decimated band is ~375 Hz wide). */
const QRSS_VIEW_HZ = 200;

class QrssSpectrum {
    constructor() {
        this.inRate = 0;
        this.outRate = 0;
        this.fftSize = 4096;
        this.hop = 1024;
        this.hbs = [];
        this.fills = [];
        this.blockR = new Float32Array(8192);
        this.blockI = new Float32Array(8192);
        this.frameR = new Float32Array(8192);
        this.frameI = new Float32Array(8192);
        this.filled = 0;
        this.since = 0;
        this.fft = new DidahFFT(this.fftSize);
        this.fft.initWindow('bh4');
        this.spec = new Float32Array(this.fftSize);
    }

    setInputRate(rate) {
        const next = rate > 0 ? rate : 12000;
        if (next === this.inRate && this.hbs.length) return;
        this.inRate = next;
        const hbs = [];
        const fills = [];
        let fs = next;
        while (hbs.length < 6 && fs / 2 >= 300) {
            hbs.push(new ComplexFIR(designHalfband(fs), true));
            fills.push(0);
            fs *= 0.5;
        }
        this.hbs = hbs;
        this.fills = fills;
        this.outRate = fs;
        this.reset();
    }

    /** 256..8192 points (power of two). The hop follows at N / 4. */
    setFftSize(n) {
        let size = 256;
        while (size < 8192 && size * 2 <= n) size *= 2;
        if (size === this.fftSize) return;
        this.fftSize = size;
        this.fft.setSize(size);
        this.fft.initWindow('bh4');
        this.spec = new Float32Array(size);
        this.hop = size >> 2;
        this.filled = 0;
        this.since = 0;
    }

    /** New decimated samples between columns (normally N / 4). */
    setHop(n) {
        this.hop = Math.max(1, Math.min(this.fftSize, n | 0));
    }

    /** Waterfall zoom that shows QRSS_VIEW_HZ of the decimated band. */
    viewZoom() {
        return this.outRate > QRSS_VIEW_HZ ? this.outRate / QRSS_VIEW_HZ : 1;
    }

    reset() {
        const hbs = this.hbs;
        for (let s = 0; s < hbs.length; s++) {
            hbs[s].reset();
            this.fills[s] = 0;
        }
        this.filled = 0;
        this.since = 0;
    }

    /**
     * One complex sample at the channel rate.
     * @returns {Float32Array|null} a dB column (fftshifted) every `hop` decimated samples
     */
    push(i, q) {
        let si = i;
        let sq = q;
        const hbs = this.hbs;
        const fills = this.fills;
        for (let s = 0; s < hbs.length; s++) {
            const hb = hbs[s];
            hb.push(si, sq);
            if (++fills[s] < 2) return null;
            fills[s] = 0;
            hb.compute();
            si = hb.outI;
            sq = hb.outQ;
        }
        const n = this.fftSize;
        this.blockR[this.filled] = si;
        this.blockI[this.filled] = sq;
        this.filled++;
        this.since++;
        // A full window must be transformed before the next sample overwrites it.
        // A shorter hop still paints a column so the waterfall is not black for a minute.
        if (this.since < this.hop && this.filled < n) return null;
        this.since = 0;
        const spec = this._column(n);
        if (this.filled >= n) {
            const hop = this.hop;
            if (hop >= n) {
                this.filled = 0;
            } else {
                this.blockR.copyWithin(0, hop, n);
                this.blockI.copyWithin(0, hop, n);
                this.filled = n - hop;
            }
        }
        return spec;
    }

    /**
     * One fftshifted dB column. Until the window is full the samples sit in the
     * middle of the window (the wings are zero) so a carrier is visible
     * immediately and then tightens to the real bin width.
     */
    _column(n) {
        const m = this.filled;
        let db;
        if (m >= n) {
            db = this.fft.computeSpectrumDb(this.blockR, this.blockI, true);
        } else {
            const fr = this.frameR;
            const fi = this.frameI;
            fr.fill(0, 0, n);
            fi.fill(0, 0, n);
            const off = (n - m) >> 1;
            const br = this.blockR;
            const bi = this.blockI;
            for (let i = 0; i < m; i++) {
                fr[off + i] = br[i];
                fi[off + i] = bi[i];
            }
            db = this.fft.computeSpectrumDb(fr, fi, true);
        }
        this.spec.set(db.subarray(0, n));
        return this.spec;
    }
}

/** Candidate spacings of the QRSS elapsed-time ticks, seconds. */
const QRSS_TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

/**
 * Tick interval for a column duration: the shortest step at least `minPx` columns (= canvas pixels)
 * apart, so ticks land roughly 80-150 px apart. Falls back to the longest step.
 */
function qrssTickSeconds(colSec, minPx = 80) {
    const steps = QRSS_TICK_STEPS;
    if (!(colSec > 0)) return steps[steps.length - 1];
    for (let i = 0; i < steps.length; i++) {
        if (steps[i] / colSec >= minPx) return steps[i];
    }
    return steps[steps.length - 1];
}

/** 0.68 -> "0.68 s", 5.46 -> "5.5 s", 30 -> "30 s", 60 -> "1 min", 90 -> "1 min 30 s". */
function formatQrssDuration(sec) {
    const s = Number(sec);
    if (!Number.isFinite(s) || s < 0) return '--';
    if (s < 1) return `${s.toFixed(2)} s`;
    if (s < 60) return Number.isInteger(s) ? `${s} s` : `${s.toFixed(1)} s`;
    const whole = Math.round(s);
    const m = Math.floor(whole / 60);
    const r = whole % 60;
    return r ? `${m} min ${r} s` : `${m} min`;
}

/** 14047900 -> "14 047.900 kHz" (Hz resolution, space-grouped kHz). */
function formatQrssFreq(hz) {
    const v = Math.round(Number(hz));
    if (!Number.isFinite(v)) return '--';
    const abs = Math.abs(v);
    const khz = String(Math.floor(abs / 1000)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    const frac = String(abs % 1000).padStart(3, '0');
    return `${v < 0 ? '-' : ''}${khz}.${frac} kHz`;
}

/** Epoch ms -> "2026-09-26 18:13:14Z". */
function formatQrssUtc(ms) {
    const iso = new Date(ms).toISOString();
    return `${iso.slice(0, 10)} ${iso.slice(11, 19)}Z`;
}

/**
 * Centre of the QRSS band. The demodulator NCO shifts by offset + passband centre (0 in CW,
 * (low + high) / 2 in USB/LSB), so the QRSS tap is centred there, not on the dial.
 */
function qrssCenterFreq(tunedFreq, modulation) {
    const m = typeof MODES !== 'undefined' ? MODES[modulation] : null;
    return m && m.low !== null ? tunedFreq + (m.low + m.high) / 2 : tunedFreq;
}

if (typeof globalThis !== 'undefined') {
    globalThis.QRSS_TICK_STEPS = QRSS_TICK_STEPS;
    globalThis.qrssTickSeconds = qrssTickSeconds;
    globalThis.formatQrssDuration = formatQrssDuration;
    globalThis.formatQrssFreq = formatQrssFreq;
    globalThis.formatQrssUtc = formatQrssUtc;
    globalThis.qrssCenterFreq = qrssCenterFreq;
    globalThis.QrssSpectrum = QrssSpectrum;
    globalThis.QRSS_SIZES = QRSS_SIZES;
    globalThis.QRSS_VIEW_HZ = QRSS_VIEW_HZ;
}
if (typeof module !== 'undefined') {
    module.exports = {
        QrssSpectrum, QRSS_SIZES, QRSS_VIEW_HZ, QRSS_TICK_STEPS,
        qrssTickSeconds, formatQrssDuration, formatQrssFreq, formatQrssUtc, qrssCenterFreq
    };
}
