/**
 * didahSDR - CW Adaptive IIR Filter & Spatial Sharpening
 *
 * Algorithm highlights:
 * 1. Automatic noise-floor estimation (mean of the lowest 12.5% bins, via a 256-bin dB histogram
 *    over [WATERFALL_DB_FLOOR, 0] so no per-slice sort is needed) and baseline alignment.
 * 2. Non-linear IIR smoothing: suppresses background hiss while tracking rapid CW keying.
 * 3. 1D spatial convolution sharpening across frequency bins to isolate Morse carriers.
 */

class CWAdaptiveFilter {
    constructor(nfft = 2048) {
        this.nfft = nfft;
        this.enabled = true;

        this.prevAvgNf = 0.0;
        this.prevPower = new Float32Array(nfft);
        this.outputBuffer = new Float32Array(nfft);
        this.gainScratch = new Float32Array(nfft);
        this.hist = new Uint16Array(256);

        // Kernel definitions for Click Filter (sharpening & key-click suppression)
        this.kernels = {
            'off': new Float32Array([1.0]),
            'light': new Float32Array([-1.0, -1.0, 5.0, -1.0, -1.0]),
            'medium': new Float32Array([-1.0, -1.0, -1.0, 7.0, -1.0, -1.0, -1.0]),
            'strong': new Float32Array([-1.0, -1.0, -1.0, -1.0, 9.0, -1.0, -1.0, -1.0, -1.0])
        };
        this.currentKernelName = 'medium';
        this.kernel = this.kernels['medium'];
        // Calibrated kernel scales to preserve CW carrier peak dB levels across kernel sizes
        this.kernelScales = { 'light': 0.72, 'medium': 0.51, 'strong': 0.37 };

        // Adjustable filter constants
        this.alphaNf = 0.5;      // Noise floor smoothing factor
        this.iirFactor = 0.04;   // Non-linear gain rate
    }

    setKernel(name) {
        if (this.kernels[name]) {
            this.currentKernelName = name;
            this.kernel = this.kernels[name];
        }
    }

    reset() {
        this.prevAvgNf = 0.0;
        this.prevPower.fill(0);
        this.outputBuffer.fill(0);
    }

    resize(nfft) {
        if (this.nfft === nfft) return;
        this.nfft = nfft;
        this.prevPower = new Float32Array(nfft);
        this.outputBuffer = new Float32Array(nfft);
        this.gainScratch = new Float32Array(nfft);
        this.reset();
    }

    /**
     * Process an incoming FFT slice (in dB)
     * @param {Float32Array} inputPower - Array of dB values of length nfft
     * @returns {Float32Array} Processed array
     */
    process(inputPower) {
        const N = inputPower.length;
        if (N !== this.nfft) {
            this.resize(N);
        }

        if (!this.enabled) {
            return inputPower;
        }

        // 1. Measure Noise Floor (NF) level: mean of the lowest 1/8 (12.5%) bins.
        // Histogram over [WATERFALL_DB_FLOOR, 0] in 256 buckets (~0.55 dB), O(N) instead of a sort.
        const hist = this.hist;
        hist.fill(0);
        const dbFloor = WATERFALL_DB_FLOOR;
        const binScale = 255.0 / -dbFloor;
        for (let j = 0; j < N; j++) {
            let b = ((inputPower[j] - dbFloor) * binScale) | 0;
            if (b < 0) b = 0; else if (b > 255) b = 255;
            hist[b]++;
        }
        const nfBinCount = Math.max(16, Math.floor(N / 8));
        let remaining = nfBinCount;
        let nfSum = 0.0;
        for (let b = 0; b < 256 && remaining > 0; b++) {
            const take = hist[b] < remaining ? hist[b] : remaining;
            nfSum += take * (dbFloor + (b + 0.5) / binScale);   // bucket centre in dB
            remaining -= take;
        }
        const currentAvgNf = nfSum / nfBinCount;

        // Running average of noise floor
        if (this.prevAvgNf === 0.0) {
            this.prevAvgNf = currentAvgNf;
        } else {
            this.prevAvgNf = this.prevAvgNf * (1.0 - this.alphaNf) + currentAvgNf * this.alphaNf;
        }

        // 2. Align NF with 0 dB & apply non-linear IIR smoothing
        const kernel = this.kernel;
        const kLen = kernel.length;
        const kHalf = Math.floor(kLen / 2);
        const gainArray = this.gainScratch; // per-bin gain

        for (let j = 0; j < N; j++) {
            // Subtract noise floor
            let p = inputPower[j] - this.prevAvgNf;
            if (p < 1e-12) p = 1e-12;

            // Non-linear IIR smoothing
            // gain = 1.0 - exp(-0.04 * power)
            const g = 1.0 - Math.exp(-this.iirFactor * p);
            gainArray[j] = g;

            // prev_power = prev_power * (1 - g) + power * g
            this.prevPower[j] = this.prevPower[j] * (1.0 - g) + p * g;
        }

        // 3. Click Filter: 1D convolution sharpening or pass-through
        if (this.currentKernelName === 'off' || kLen <= 1) {
            // Bypass sharpening convolution: direct adaptive IIR smoothed signal
            for (let j = 0; j < N; j++) {
                this.outputBuffer[j] = this.prevAvgNf + this.prevPower[j];
            }
            return this.outputBuffer;
        }

        const scale = this.kernelScales[this.currentKernelName] || (2.5 / (kernel[kHalf] || 5.0));

        for (let j = 0; j < N; j++) {
            let convSum = 0.0;
            for (let k = 0; k < kLen; k++) {
                const sampleIdx = j + k - kHalf;
                let val;
                if (sampleIdx < 0) {
                    val = this.prevPower[0];
                } else if (sampleIdx >= N) {
                    val = this.prevPower[N - 1];
                } else {
                    val = this.prevPower[sampleIdx];
                }
                convSum += val * kernel[k];
            }

            // Output: restore baseline noise floor so levels match raw FFT
            // convSum * gain gives the sharpened CW carrier height above noise floor.
            // Adding this.prevAvgNf restores the absolute dB level so the waterfall
            // display and sliders behave consistently whether CW filter is ON or OFF.
            const filteredSignal = convSum * gainArray[j] * scale;
            this.outputBuffer[j] = this.prevAvgNf + filteredSignal;
        }

        return this.outputBuffer;
    }
}

if (typeof module !== 'undefined') module.exports = CWAdaptiveFilter;
