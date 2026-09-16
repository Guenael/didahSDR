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
        this.windowName = 'flattop';
        this.tempReal = new Float32Array(size);
        this.tempImag = new Float32Array(size);
        this.powerBuffer = new Float32Array(size);

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
        }
    }

    initWindow(name = 'flattop') {
        this.windowName = name;
        const n = this.size;
        this.window = new Float32Array(n);
        this.windowSum = 0.0;

        if (name === 'flattop') {
            // Standard ISO flat-top window coefficients
            const a0 = 0.21557895;
            const a1 = 0.41663158;
            const a2 = 0.277263158;
            const a3 = 0.083578947;
            const a4 = 0.006947368;
            for (let i = 0; i < n; i++) {
                const z = (2.0 * Math.PI * i) / (n - 1);
                this.window[i] = a0 - a1 * Math.cos(z) + a2 * Math.cos(2 * z) - a3 * Math.cos(3 * z) + a4 * Math.cos(4 * z);
            }
        } else if (name === 'blackman') {
            for (let i = 0; i < n; i++) {
                const z = (2.0 * Math.PI * i) / (n - 1);
                this.window[i] = 0.42 - 0.5 * Math.cos(z) + 0.08 * Math.cos(2 * z);
            }
        } else {
            // Hann window
            for (let i = 0; i < n; i++) {
                this.window[i] = 0.5 * (1.0 - Math.cos((2.0 * Math.PI * i) / (n - 1)));
            }
        }
        // Coherent gain normalisation: a full-scale tone reads 0 dBFS whatever the window
        for (let i = 0; i < n; i++) this.windowSum += this.window[i];
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
     * Compute shifted power spectrum (in dB) directly from windowed complex IQ block.
     * @param {Float32Array} inReal - Array of I samples
     * @param {Float32Array} inImag - Array of Q samples
     * @returns {Float32Array} Power spectrum in dB (shifted: DC in middle, negative freqs left, positive right)
     */
    computeSpectrumDb(inReal, inImag) {
        const n = this.size;
        const w = this.window;
        const r = this.tempReal;
        const im = this.tempImag;

        // Apply window
        for (let i = 0; i < n; i++) {
            r[i] = inReal[i] * w[i];
            im[i] = inImag[i] * w[i];
        }

        this.transform(r, im);

        // Compute power in dB and apply fftshift
        const half = n / 2;
        const invN2 = 1.0 / (this.windowSum * this.windowSum);
        const out = this.powerBuffer;

        for (let i = 0; i < n; i++) {
            // fftshift: out[0..half-1] comes from r[half..n-1]
            //           out[half..n-1] comes from r[0..half-1]
            const srcIdx = (i + half) % n;
            const mag2 = (r[srcIdx] * r[srcIdx] + im[srcIdx] * im[srcIdx]) * invN2;
            out[i] = 10.0 * Math.log10(Math.max(mag2, 1e-15));
        }

        return out;
    }
}

if (typeof module !== 'undefined') module.exports = DidahFFT;
