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

if (typeof globalThis !== 'undefined') {
    globalThis.QrssSpectrum = QrssSpectrum;
    globalThis.QRSS_SIZES = QRSS_SIZES;
    globalThis.QRSS_VIEW_HZ = QRSS_VIEW_HZ;
}
if (typeof module !== 'undefined') module.exports = { QrssSpectrum, QRSS_SIZES, QRSS_VIEW_HZ };
