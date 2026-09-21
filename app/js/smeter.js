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

const SNR_DB_TO_LN = Math.LN10 / 10;
const SNR_LN_TO_DB = 10 / Math.LN10;

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
        this.lastUpdateTime = 0;
        this.lastRenderTime = 0;
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

    show() { if (this.window) this.window.show(); }
    hide() { if (this.window) this.window.hide(); }
    toggle() { if (this.window) this.window.toggle(); }

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
     * Mean-power (S+N)/N in dB for the tuned passband vs neighbouring bins.
     * Returns a signed value (white noise ~0); null if the windows are unusable.
     * No allocations — safe on the FFT path.
     */
    computeSnrDb(specDb, sampleRate, centerFreq, tunedFreq, modulation, bandwidth) {
        const nfft = specDb.length;
        const binWidth = sampleRate / nfft;
        const offsetHz = tunedFreq - centerFreq;
        const k0 = Math.round((offsetHz / sampleRate) * nfft + nfft / 2);

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
            passSum += Math.exp(specDb[k] * SNR_DB_TO_LN);
            passCount++;
        }

        const noiseSpan = Math.max(16, Math.round(1500 / binWidth));
        let noiseSum = 0.0;
        let noiseCount = 0;
        const leftStart = Math.max(0, kStart - noiseSpan);
        for (let k = leftStart; k < kStart; k++) {
            noiseSum += Math.exp(specDb[k] * SNR_DB_TO_LN);
            noiseCount++;
        }
        const rightEnd = Math.min(nfft - 1, kEnd + noiseSpan);
        for (let k = kEnd + 1; k <= rightEnd; k++) {
            noiseSum += Math.exp(specDb[k] * SNR_DB_TO_LN);
            noiseCount++;
        }

        if (passCount < 1 || noiseCount < 8 || !(noiseSum > 0) || !(passSum > 0)) return null;
        return SNR_LN_TO_DB * Math.log((passSum / passCount) / (noiseSum / noiseCount));
    }

    /**
     * Compute instantaneous SNR and update the meter ballistics / DOM.
     */
    updateFromSpectrum(specDb, sampleRate, centerFreq, tunedFreq, modulation, bandwidth) {
        if (!this.visible || !this.container) return;
        const rawSnrDb = this.computeSnrDb(specDb, sampleRate, centerFreq, tunedFreq, modulation, bandwidth);
        if (rawSnrDb == null || !Number.isFinite(rawSnrDb)) return;
        this.applyBallistics(rawSnrDb);
        this.render();
    }

    applyBallistics(rawSnrDb) {
        const now = performance.now();
        const dt = this.lastUpdateTime ? Math.min(0.1, Math.max(0.005, (now - this.lastUpdateTime) * 0.001)) : 0.02;
        this.lastUpdateTime = now;

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
