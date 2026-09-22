/**
 * didahSDR - Fast Client-Side Radix-2 FFT Engine
 * Zero external dependencies, pure typed arrays, microsecond execution.
 * Includes window functions and STFT overlap helper.
 */

class DidahFFT {
    constructor(size = 2048) {
        this.size = size;
        this.cosTable = null;
        this.sinTable = null;
        this.bitRev = null;
        this.window = null;
        this.windowName = 'bh4';
        this.enbw = 2;
        this.tempReal = new Float32Array(size);
        this.tempImag = new Float32Array(size);
        this.powerBuffer = new Float32Array(size);
        this.mag2Buffer = new Float32Array(size);

        this.initTables(size);
        this.initWindow(this.windowName);
    }

    initTables(size) {
        this.size = size;
        const half = size / 2;
        this.cosTable = new Float32Array(half);
        this.sinTable = new Float32Array(half);

        for (let i = 0; i < half; i++) {
            const angle = (-2.0 * Math.PI * i) / size;
            this.cosTable[i] = Math.cos(angle);
            this.sinTable[i] = Math.sin(angle);
        }

        this.bitRev = new Uint32Array(size);
        const log2n = Math.round(Math.log2(size));
        for (let i = 0; i < size; i++) {
            let rev = 0;
            for (let j = 0, n = i; j < log2n; j++) {
                rev = (rev << 1) | (n & 1);
                n >>= 1;
            }
            this.bitRev[i] = rev;
        }

        if (this.tempReal.length !== size) {
            this.tempReal = new Float32Array(size);
            this.tempImag = new Float32Array(size);
            this.powerBuffer = new Float32Array(size);
            this.mag2Buffer = new Float32Array(size);
        }
    }

    initWindow(name = 'bh4') {
        const known = name === 'flattop' || name === 'blackman' || name === 'hann' || name === 'bh4';
        this.windowName = known ? name : 'bh4';
        const n = this.size;
        this.window = new Float32Array(n);
        this.windowSum = 0.0;
        let sum2 = 0.0;

        if (this.windowName === 'flattop') {
            // ISO flat-top. Wide main lobe; the CW click filter sharpens it back.
            const a0 = 0.21557895, a1 = 0.41663158, a2 = 0.277263158, a3 = 0.083578947, a4 = 0.006947368;
            for (let i = 0; i < n; i++) {
                const z = (2.0 * Math.PI * i) / (n - 1);
                this.window[i] = a0 - a1 * Math.cos(z) + a2 * Math.cos(2 * z) - a3 * Math.cos(3 * z) + a4 * Math.cos(4 * z);
            }
        } else if (this.windowName === 'blackman') {
            for (let i = 0; i < n; i++) {
                const z = (2.0 * Math.PI * i) / (n - 1);
                this.window[i] = 0.42 - 0.5 * Math.cos(z) + 0.08 * Math.cos(2 * z);
            }
        } else if (this.windowName === 'hann') {
            for (let i = 0; i < n; i++) {
                this.window[i] = 0.5 * (1.0 - Math.cos((2.0 * Math.PI * i) / (n - 1)));
            }
        } else {
            // 4-term Blackman-Harris. Used when the CW filter is off (voice and other wide signals).
            const a0 = 0.35875, a1 = 0.48829, a2 = 0.14128, a3 = 0.01168;
            for (let i = 0; i < n; i++) {
                const z = (2.0 * Math.PI * i) / (n - 1);
                this.window[i] = a0 - a1 * Math.cos(z) + a2 * Math.cos(2 * z) - a3 * Math.cos(3 * z);
            }
        }
        for (let i = 0; i < n; i++) {
            const w = this.window[i];
            this.windowSum += w;
            sum2 += w * w;
        }
        this.enbw = this.windowSum > 0 ? (n * sum2) / (this.windowSum * this.windowSum) : 1;
    }

    setSize(newSize) {
        if (newSize !== this.size) {
            this.initTables(newSize);
            this.initWindow(this.windowName);
        }
    }

    /**
     * Compute FFT in-place on real and imag Float32Arrays of length this.size
     */
    transform(real, imag) {
        const n = this.size;
        const bitRev = this.bitRev;
        const cosTable = this.cosTable;
        const sinTable = this.sinTable;

        // Bit reversal permutation
        for (let i = 0; i < n; i++) {
            const rev = bitRev[i];
            if (rev > i) {
                const tr = real[i]; real[i] = real[rev]; real[rev] = tr;
                const ti = imag[i]; imag[i] = imag[rev]; imag[rev] = ti;
            }
        }

        // Cooley-Tukey Radix-2 decimation-in-time
        for (let halfSize = 1; halfSize < n; halfSize *= 2) {
            const step = n / (halfSize * 2);
            for (let i = 0; i < n; i += halfSize * 2) {
                for (let j = 0; j < halfSize; j++) {
                    const tableIdx = j * step;
                    const c = cosTable[tableIdx];
                    const s = sinTable[tableIdx];
                    const matchIdx = i + j + halfSize;
                    const uR = real[i + j];
                    const uI = imag[i + j];
                    const vR = real[matchIdx] * c - imag[matchIdx] * s;
                    const vI = real[matchIdx] * s + imag[matchIdx] * c;

                    real[i + j] = uR + vR;
                    imag[i + j] = uI + vI;
                    real[matchIdx] = uR - vR;
                    imag[matchIdx] = uI - vI;
                }
            }
        }
    }

    /**
     * Window a contiguous block into the FFT temps. `wantMag2` fills mag2Buffer.
     * @returns {Float32Array} fftshifted power in dB
     */
    computeSpectrumDb(inReal, inImag, wantMag2 = true) {
        const n = this.size;
        const w = this.window;
        const r = this.tempReal;
        const im = this.tempImag;
        for (let i = 0; i < n; i++) {
            const wv = w[i];
            r[i] = inReal[i] * wv;
            im[i] = inImag[i] * wv;
        }
        return this._spectrumFromTemps(wantMag2);
    }

    /**
     * Window while reading a circular IQ ring, so the caller does not copy a block first.
     * `start` is the index of the oldest sample.
     */
    computeSpectrumFromRing(ringReal, ringImag, ringSize, start, wantMag2 = true) {
        const n = this.size;
        const w = this.window;
        const r = this.tempReal;
        const im = this.tempImag;
        let idx = start | 0;
        const last = ringSize - 1;
        for (let i = 0; i < n; i++) {
            const wv = w[i];
            r[i] = ringReal[idx] * wv;
            im[i] = ringImag[idx] * wv;
            idx = idx === last ? 0 : idx + 1;
        }
        return this._spectrumFromTemps(wantMag2);
    }

    _spectrumFromTemps(wantMag2) {
        const n = this.size;
        const r = this.tempReal;
        const im = this.tempImag;
        this.transform(r, im);

        const half = n >> 1;
        const invN2 = 1.0 / (this.windowSum * this.windowSum);
        const out = this.powerBuffer;
        const mag2Out = this.mag2Buffer;
        for (let i = 0; i < half; i++) {
            const src = i + half;
            const mag2 = (r[src] * r[src] + im[src] * im[src]) * invN2;
            if (wantMag2) mag2Out[i] = mag2;
            out[i] = 10.0 * Math.log10(mag2 > 1e-15 ? mag2 : 1e-15);
        }
        for (let i = half; i < n; i++) {
            const src = i - half;
            const mag2 = (r[src] * r[src] + im[src] * im[src]) * invN2;
            if (wantMag2) mag2Out[i] = mag2;
            out[i] = 10.0 * Math.log10(mag2 > 1e-15 ? mag2 : 1e-15);
        }
        return out;
    }
}

if (typeof module !== 'undefined') module.exports = DidahFFT;
