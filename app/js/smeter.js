/**
 * didahSDR - SNR-Meter Component
 *
 * (S+N)/N in the tuned passband: mean linear power inside the channel versus mean
 * linear power in neighbouring bins. Locally white noise reads ~0 dB; a signal
 * in the passband reads how far that channel sits above the local floor.
 * Scale is 0 ... 10 ... 20 ... 30 ... 40+ dB.
 *
 * Features:
 * - Floating, draggable window (chrome shared with W-Config via floating_window.js)
 * - Fast attack (~20ms) and natural decay (~150ms) ballistics for CW Morse bursts
 * - 1.5-second Peak Hold with smooth decay
 * - Precision vector SVG scale perfectly aligned with the LED gradient bargraph
 * - Instantaneous numerical readout, peak readout, and mode/bandwidth badge
 */

/** Exponential power (complex Gaussian) has median = ln(2) × mean, 1.59 dB below the mean. */
const SNR_MEDIAN_BIAS_DB = 10 * Math.log10(1 / Math.LN2);

class DidahSMeter {
    constructor() {
        this.container = null;
        this.valEl = null;
        this.peakValEl = null;
        this.modeBadgeEl = null;
        this.barEl = null;
        this.peakNeedleEl = null;
        this.toggleBtn = null;

        this.visible = true;      // kept in sync by the floating window helper
        this.window = null;
        this.currentSnr = 0.0;
        this.peakSnr = 0.0;
        this.peakHoldUntil = 0;
        this.lastRenderTime = 0;
        this.noiseScratch = new Float32Array(256);
    }

    init() {
        this.container = document.getElementById('smeter-window');
        this.valEl = document.getElementById('smeter-val');
        this.peakValEl = document.getElementById('smeter-peak-val');
        this.modeBadgeEl = document.getElementById('smeter-mode-badge');
        this.barEl = document.getElementById('smeter-bar');
        this.peakNeedleEl = document.getElementById('smeter-peak-needle');
        this.toggleBtn = document.getElementById('smeter-btn');

        if (!this.container) return;

        // Build SVG scale if not already built
        const scaleContainer = document.getElementById('smeter-scale-container');
        if (scaleContainer && !scaleContainer.hasChildNodes()) {
            scaleContainer.innerHTML = this.buildScaleSvg(260, 24);
        }

        // Window chrome (drag, close, toggle, persistence) is shared with W-Config
        this.window = setupFloatingWindow({
            windowId: 'smeter-window', headerId: 'smeter-header', closeBtnId: 'smeter-close-btn',
            toggleBtnId: 'smeter-btn', storageKey: 'didah_smeter', defaultVisible: true,
            defaultPos: { top: '58px', left: '20px' },
            onVisibilityChange: (visible) => {
                this.visible = visible;
                if (visible) this.reset();   // no stale reading when reopened
            }
        });
    }

    buildScaleSvg(width = 260, height = 24) {
        const pad = 12;
        const innerW = width - 2 * pad;
        let ticks = '';
        let labels = '';

        for (let db = 0; db <= 40; db += 2) {
            const x = (pad + (db / 40.0) * innerW).toFixed(1);
            if (db % 10 === 0) {
                ticks += `<line x1="${x}" y1="0" x2="${x}" y2="7" stroke="#8b949e" stroke-width="1.5"/>`;
                const text = db === 40 ? '40+' : db.toString();
                const color = db >= 30 ? '#ef4444' : (db >= 20 ? '#eab308' : '#98c379');
                labels += `<text x="${x}" y="19" font-size="9" font-weight="600" font-family="'Roboto Mono', monospace" fill="${color}" text-anchor="middle">${text}</text>`;
            } else if (db % 5 === 0) {
                ticks += `<line x1="${x}" y1="0" x2="${x}" y2="5" stroke="#6e7681" stroke-width="1"/>`;
            } else {
                ticks += `<line x1="${x}" y1="0" x2="${x}" y2="3" stroke="#484f58" stroke-width="1"/>`;
            }
        }
        return `<svg class="smeter-scale-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${ticks}${labels}</svg>`;
    }

    setModeInfo(mode, bandwidth) {
        if (!this.modeBadgeEl) return;
        const modeStr = (mode || 'cw').toUpperCase();
        let bwStr = '';
        const m = MODES[modeStr.toLowerCase()];
        if (modeStr === 'CW') {
            bwStr = `${Math.round(bandwidth || 150)}Hz`;
        } else if (m && m.low !== null) {
            bwStr = `${((m.high - m.low) / 1000).toFixed(1)}kHz`;
        }
        this.modeBadgeEl.textContent = `${modeStr} ${bwStr}`;
    }

    /**
     * (S+N)/N in dB from linear mag². Noise is the median of bins outside a guard
     * of ceil(ENBW)+2, lifted by the exponential-median bias so Gaussian noise reads 0 dB.
     */
    computeSnrDb(mag2, sampleRate, centerFreq, tunedFreq, modulation, bandwidth, enbw) {
        const nfft = mag2.length;
        const binWidth = sampleRate / nfft;
        const offsetHz = tunedFreq - centerFreq;
        const k0 = Math.round((offsetHz / sampleRate) * nfft + nfft / 2);
        const guard = Math.ceil(enbw == null ? 2 : enbw) + 2;

        let kStart, kEnd;
        const mod = (modulation || 'cw').toLowerCase();

        if (mod === 'cw') {
            const halfBins = Math.max(1, Math.round(((bandwidth || 150) * 0.5) / binWidth));
            kStart = Math.max(0, k0 - halfBins);
            kEnd = Math.min(nfft - 1, k0 + halfBins);
        } else if (MODES[mod] && MODES[mod].low !== null) {
            const m = MODES[mod];
            kStart = Math.max(0, k0 + Math.round(m.low / binWidth));
            kEnd = Math.min(nfft - 1, k0 + Math.round(m.high / binWidth));
        } else {
            const halfBins = Math.max(1, Math.round(1000 / binWidth));
            kStart = Math.max(0, k0 - halfBins);
            kEnd = Math.min(nfft - 1, k0 + halfBins);
        }

        if (kEnd <= kStart) return null;

        let passSum = 0.0;
        let passCount = 0;
        for (let k = kStart; k <= kEnd; k++) {
            passSum += mag2[k];
            passCount++;
        }

        const noiseSpan = Math.max(16, Math.round(1500 / binWidth));
        const leftEnd = kStart - guard;
        const leftStart = Math.max(0, leftEnd - noiseSpan);
        const rightStart = kEnd + guard;
        const rightEnd = Math.min(nfft - 1, rightStart + noiseSpan);
        let noiseCount = 0;
        if (this.noiseScratch.length < nfft) this.noiseScratch = new Float32Array(nfft);
        const scratch = this.noiseScratch;
        for (let k = leftStart; k < leftEnd; k++) scratch[noiseCount++] = mag2[k];
        for (let k = rightStart + 1; k <= rightEnd; k++) scratch[noiseCount++] = mag2[k];

        if (passCount < 1 || noiseCount < 8 || !(passSum > 0)) return null;
        scratch.subarray(0, noiseCount).sort();
        const mid = (noiseCount - 1) >> 1;
        const median = noiseCount % 2 === 1
            ? scratch[mid]
            : 0.5 * (scratch[mid] + scratch[mid + 1]);
        if (!(median > 0)) return null;
        return 10 * Math.log10((passSum / passCount) / median) - SNR_MEDIAN_BIAS_DB;
    }

    /**
     * Compute instantaneous SNR and update the meter ballistics / DOM.
     * `mag2` is the linear fftshifted power buffer.
     */
    updateFromSpectrum(mag2, sampleRate, centerFreq, tunedFreq, modulation, bandwidth, enbw, hopSamples) {
        if (!this.visible || !this.container) return;
        const rawSnrDb = this.computeSnrDb(mag2, sampleRate, centerFreq, tunedFreq, modulation, bandwidth, enbw);
        if (rawSnrDb == null || !Number.isFinite(rawSnrDb)) return;
        const hop = hopSamples > 0 ? hopSamples : 0;
        const dt = hop > 0 && sampleRate > 0 ? hop / sampleRate : 0.02;
        this.applyBallistics(rawSnrDb, dt);
        this.render();
    }

    applyBallistics(rawSnrDb, dtSec) {
        const dt = Math.min(0.1, Math.max(0.001, dtSec || 0.02));
        const now = performance.now();

        // Asymmetric attack/decay:
        // - Fast attack (~20ms) captures short Morse dits and sharp transient syllables
        // - Smooth decay (~150ms) creates natural, eye-pleasing meter movement
        const attackCoeff = 1.0 - Math.exp(-dt / 0.02);
        const decayCoeff = 1.0 - Math.exp(-dt / 0.15);

        if (rawSnrDb > this.currentSnr) {
            this.currentSnr += (rawSnrDb - this.currentSnr) * attackCoeff;
        } else {
            this.currentSnr += (rawSnrDb - this.currentSnr) * decayCoeff;
        }

        // Peak Hold logic: holds for 1.5s, then decays smoothly at 25 dB/s
        if (this.currentSnr >= this.peakSnr) {
            this.peakSnr = this.currentSnr;
            this.peakHoldUntil = now + 1500;
        } else if (now > this.peakHoldUntil) {
            this.peakSnr = Math.max(this.currentSnr, this.peakSnr - 25.0 * dt);
        }
    }

    render() {
        const now = performance.now();
        // Throttle DOM updates to ~40-60 Hz (every 16-25ms) to conserve CPU
        if (now - this.lastRenderTime < 20) return;
        this.lastRenderTime = now;

        if (!this.valEl || !this.barEl) return;

        const dispVal = Math.max(0.0, this.currentSnr);
        const dispPeak = Math.max(0.0, this.peakSnr);

        // Update Numerical Readouts
        const prefix = dispVal > 0.0 ? '+' : '';
        this.valEl.textContent = `${prefix}${dispVal.toFixed(1)}`;
        this.peakValEl.textContent = `+${dispPeak.toFixed(1)} dB`;

        // Update Bargraph (0 to 40 dB mapped to 0% to 100%)
        const barPct = Math.min(100.0, Math.max(0.0, (dispVal / 40.0) * 100.0));
        this.barEl.style.width = `${barPct.toFixed(1)}%`;

        // Update Peak Needle
        const peakPct = Math.min(100.0, Math.max(0.0, (dispPeak / 40.0) * 100.0));
        if (this.peakNeedleEl) {
            this.peakNeedleEl.style.left = `${peakPct.toFixed(1)}%`;
            this.peakNeedleEl.style.opacity = dispPeak > 0.5 ? '1' : '0';
        }
    }

    reset() {
        this.currentSnr = 0.0;
        this.peakSnr = 0.0;
        this.peakHoldUntil = 0;
        if (this.valEl) this.valEl.textContent = '+0.0';
        if (this.peakValEl) this.peakValEl.textContent = '+0.0 dB';
        if (this.barEl) this.barEl.style.width = '0%';
        if (this.peakNeedleEl) {
            this.peakNeedleEl.style.left = '0%';
            this.peakNeedleEl.style.opacity = '0';
        }
    }
}

if (typeof module !== 'undefined') module.exports = DidahSMeter;
