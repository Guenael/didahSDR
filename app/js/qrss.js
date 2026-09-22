/**
 * didahSDR - QRSS spectrum.
 *
 * Complex baseband at the channel rate, already centred on the tuned frequency
 * and taken before the channel FIR, is decimated by halfbands to about 375 Hz.
 * A long Hann FFT then gives bins of a fraction of a hertz. Columns are emitted
 * every `hop` decimated samples (the waterfall scroll). `avgTarget` is the
 * exponential average, in columns, once the window is full.
 */

class QrssSpectrum {
    constructor() {
        this.inRate = 0;
        this.outRate = 0;
        this.fftSize = 4096;
        this.avgTarget = 1;
        this.hop = 4096;
        this.hbs = [];
        this.fills = [];
        this.blockR = new Float32Array(8192);
        this.blockI = new Float32Array(8192);
        this.frameR = new Float32Array(8192);
        this.frameI = new Float32Array(8192);
        this.filled = 0;
        this.since = 0;
        this.fft = new DidahFFT(this.fftSize);
        this.fft.initWindow('hann');
        this.acc = new Float32Array(this.fftSize);
        this.spec = new Float32Array(this.fftSize);
        this.accN = 0;
        this.ready = false;
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

    setFftSize(n) {
        let size = 1024;
        if (n >= 8192) size = 8192;
        else if (n >= 4096) size = 4096;
        else if (n >= 2048) size = 2048;
        if (size === this.fftSize) return;
        this.fftSize = size;
        this.fft.setSize(size);
        this.fft.initWindow('hann');
        this.acc = new Float32Array(size);
        this.spec = new Float32Array(size);
        if (this.hop > size) this.hop = size;
        this.filled = 0;
        this.since = 0;
        this.accN = 0;
        this.ready = false;
    }

    /** New decimated samples between columns. Smaller than the FFT, so the trace scrolls. */
    setHop(n) {
        const hop = Math.max(1, Math.min(this.fftSize, n | 0));
        this.hop = hop;
    }

    setAverage(n) {
        this.avgTarget = Math.max(1, n | 0);
    }

    reset() {
        const hbs = this.hbs;
        for (let s = 0; s < hbs.length; s++) {
            hbs[s].reset();
            this.fills[s] = 0;
        }
        this.filled = 0;
        this.since = 0;
        this.accN = 0;
        this.ready = false;
        this.acc.fill(0);
    }

    /**
     * One complex sample at the channel rate.
     * @returns {Float32Array|null} a dB column when Welch averaging has finished
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
     * middle of the Hann window (the wings are zero) so a carrier is visible
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
        const spec = this.spec;
        const mag = this.fft.mag2Buffer;
        if (m < n) {
            for (let k = 0; k < n; k++) spec[k] = db[k];
            this.ready = true;
            return spec;
        }
        const acc = this.acc;
        if (this.accN === 0) {
            for (let k = 0; k < n; k++) {
                acc[k] = mag[k];
                spec[k] = db[k];
            }
            this.accN = 1;
        } else {
            const a = 1.0 / this.avgTarget;
            for (let k = 0; k < n; k++) {
                const p = acc[k] + a * (mag[k] - acc[k]);
                acc[k] = p;
                mag[k] = p;
                spec[k] = 10.0 * Math.log10(p > 1e-15 ? p : 1e-15);
            }
        }
        this.ready = true;
        return spec;
    }
}

if (typeof globalThis !== 'undefined') globalThis.QrssSpectrum = QrssSpectrum;
if (typeof module !== 'undefined') module.exports = { QrssSpectrum };
