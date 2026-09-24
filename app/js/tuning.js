/**
 * didahSDR - tuning: the VFO, the IQ centre, the mode and the IQ rate.
 *
 * `setTunedFrequency()` is the one place demodulator / waterfall / dial / server state is updated
 * from a new VFO frequency (the waterfall, the drum dial, the keyboard and VFO memories all call it).
 * Also: the waterfall's tune / pan / bandwidth callbacks and the top-bar and source status text.
 */

/** Net retune (Hz) that drops the decoder and NLMS state once the dial has rested for 300 ms. */
const TUNE_RESET_REST_MS = 300;

function formatCenter(hz) {
    if (Math.abs(hz) < 1000000) return `${hz} Hz`;
    return `${(hz / 1000000).toFixed(4)} MHz`;
}

function createTuning(ctx) {
    const { state, demodulator, waterfall, valueDial, smeter, qrss, audioPlayer, cwDecoder } = ctx;
    let tuneResetTimer = null;
    let pendingTuneHz = 0;      // net retune since the last decoder / NLMS reset
    let dspControlPending = false;
    let lastDspControl = '';

    const src = () => ctx.source;
    const isIc7300 = () => src().protocol === 'ic7300';

    function currentDialHz() {
        if (isIc7300() && state.ic7300RadioHz > 0) return state.ic7300RadioHz;
        return state.tunedFreq;
    }

    function applyDialRange() {
        const p = src().protocol;
        if (p === 'ic7300' && state.ic7300RadioHz > 0) {
            valueDial.setRange(0, 999999999);
        } else if (p === 'soundcard' || p === 'ic7300') {
            const nyq = Math.max(1000, Math.floor(state.sampleRate / 2));
            valueDial.setRange(-nyq, nyq);
        } else {
            valueDial.setRange(0, 999999999);
        }
    }

    function applyIqRate(rate) {
        state.sampleRate = rate;
        demodulator.setIqRate(rate);
        audioPlayer.setInputRate(demodulator.audioRate);
        cwDecoder.setRate(demodulator.audioRate);
        cwDecoder.reset();
        ctx.pipeline.resetIqPipeline();
        waterfall.setCenterFreq(state.centerFreq, rate);
        applyDialRange();
        if (state.qrssEnabled) ctx.pipeline.applyQrssView();
        else if (rate < 30000) waterfall.zoomMin();
        else if (waterfall.zoom <= 1.01) waterfall.setZoom(2.67);
    }

    /**
     * Move the displayed centre immediately so a ruler drag accumulates.
     * Does not flush the IQ ring; applyCenter does that when the source
     * confirms a centre we have not already shown.
     */
    function shiftCenter(hz) {
        const next = Math.round(hz);
        if (next === state.centerFreq) return false;
        state.centerFreq = next;
        const half = state.sampleRate / 2;
        const maxOff = Math.max(0, half - 50);
        if (state.tunedFreq > state.centerFreq + maxOff) state.tunedFreq = Math.round(state.centerFreq + maxOff);
        if (state.tunedFreq < state.centerFreq - maxOff) state.tunedFreq = Math.round(state.centerFreq - maxOff);
        waterfall.panOffset = 0;
        if (state.qrssEnabled) {
            waterfall.zoom = qrss.viewZoom();
            waterfall.setCenterFreq(state.tunedFreq, qrss.outRate || 375);
        } else {
            waterfall.setCenterFreq(state.centerFreq, state.sampleRate);
        }
        demodulator.configure({
            offsetFreq: state.tunedFreq - state.centerFreq,
            modulation: state.modulation,
            cwBandwidth: state.cwBandwidth,
            bfoPitch: state.cwOffset
        });
        waterfall.setTunedFreq(state.tunedFreq, state.lowCut, state.highCut, state.modulation);
        valueDial.setValue(currentDialHz(), false);
        updateTopBarInfo();
        updateSourceStatus();
        return true;
    }

    /** Centre the waterfall on the frequency the source actually tuned to. */
    function applyCenter(hz) {
        if (!shiftCenter(hz)) return;
        ctx.pipeline.resetIqPipeline();
    }

    /** Kiwi / RTL-SDR: move the displayed centre and ask the source to follow. */
    function moveSourceCenter(hz) {
        shiftCenter(hz);
        ctx.retuneSourceCenter(state.centerFreq);
    }

    function flushTuneReset() {
        if (tuneResetTimer) {
            clearTimeout(tuneResetTimer);
            tuneResetTimer = null;
        }
        pendingTuneHz = 0;
        demodulator._resetAudioFx();
        cwDecoder.reset();
    }

    /**
     * Large steps and mode changes reset now. Small steps add up; once the dial rests for
     * 300 ms, reset only if the net move exceeds LARGE_RETUNE_HZ (the model tolerates ±200 Hz).
     */
    function noteTuneReset(deltaHz, immediate) {
        pendingTuneHz += deltaHz;
        if (immediate || Math.abs(deltaHz) > LARGE_RETUNE_HZ) {
            flushTuneReset();
            return;
        }
        if (tuneResetTimer) clearTimeout(tuneResetTimer);
        tuneResetTimer = setTimeout(() => {
            tuneResetTimer = null;
            if (Math.abs(pendingTuneHz) > LARGE_RETUNE_HZ) flushTuneReset();
        }, TUNE_RESET_REST_MS);
    }

    /**
     * @param {boolean} updateDial - also move the drum dial
     * @param {boolean} fromUser - false only for server-config or internal re-application
     */
    function setTunedFrequency(freq, updateDial = true, fromUser = true) {
        if (fromUser && isIc7300()) return;
        const prevTuned = state.tunedFreq;
        const prevMod = demodulator.modulation;
        state.tunedFreq = Math.round(freq);
        if (fromUser) state.userHasTuned = true;
        if (updateDial) valueDial.setValue(currentDialHz(), false);

        if (sourcePolicy(src().protocol).followsDial) {
            const half = state.sampleRate / 2;
            if (Math.abs(state.tunedFreq - state.centerFreq) > half - 50) moveSourceCenter(state.tunedFreq);
        }

        if (state.modulation === 'cw') {
            // Highlight centred on the Morse carrier; BFO only affects audio pitch
            state.lowCut = -state.cwBandwidth / 2;
            state.highCut = state.cwBandwidth / 2;
        } else {
            // SSB: dial = suppressed carrier; passband from the shared MODES table
            const m = MODES[state.modulation];
            state.lowCut = m.low;
            state.highCut = m.high;
        }
        demodulator.configure({
            offsetFreq: state.tunedFreq - state.centerFreq,
            modulation: state.modulation,
            cwBandwidth: state.cwBandwidth,
            bfoPitch: state.cwOffset
        });

        waterfall.setTunedFreq(state.tunedFreq, state.lowCut, state.highCut, state.modulation);
        noteTuneReset(state.tunedFreq - prevTuned, state.modulation !== prevMod);
        if (state.qrssEnabled) {
            qrss.reset();
            waterfall.zoom = qrss.viewZoom();
            waterfall.panOffset = 0;
            waterfall.setCenterFreq(state.tunedFreq, qrss.outRate || 375);
            waterfall.clear();
        }
        sendDspControl();
        if (ctx.vfoMemories) ctx.vfoMemories.syncDial(currentDialHz());
    }

    // dspcontrol is informational for the replay server; coalesce mouse-rate tuning into one send per
    // animation frame and skip it entirely when nothing changed.
    function sendDspControl() {
        if (dspControlPending) return;
        dspControlPending = true;
        requestAnimationFrame(() => {
            dspControlPending = false;
            const params = {
                mod: state.modulation,
                offset_freq: state.tunedFreq - state.centerFreq,
                low_cut: state.lowCut,
                high_cut: state.highCut
            };
            const key = `${params.mod}|${params.offset_freq}|${params.low_cut}|${params.high_cut}`;
            if (key === lastDspControl) return;
            lastDspControl = key;
            if (src().protocol === 'didah') ctx.transports.conn.setDemodParams(params);
        });
    }

    /** A new source must receive the next dspcontrol even if the parameters did not change. */
    function resetDspControl() {
        lastDspControl = '';
    }

    function setModulation(mod) {
        state.modulation = mod.toLowerCase();
        const cw = state.modulation === 'cw';
        const cwSec = document.getElementById('cw-config-section');
        const ssbSec = document.getElementById('ssb-config-section');
        if (cwSec) cwSec.classList.toggle('is-dimmed', !cw);
        if (ssbSec) ssbSec.classList.toggle('is-dimmed', cw);
        for (const id of ['autonotch-toggle', 'nr-toggle']) {   // SSB-only (demodulator.js)
            const btn = document.getElementById(id);
            if (btn) btn.classList.toggle('is-dimmed', cw);
        }

        document.querySelectorAll('.mode-btn').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.mode === state.modulation);
        });

        setTunedFrequency(state.tunedFreq, false, false);
        smeter.setModeInfo(state.modulation, state.cwBandwidth);
        ctx.updateDecoderActive();
        ctx.onTxModulationChanged();
    }

    function updateTopBarInfo() {
        const cfBadge = document.getElementById('center-freq-badge');
        const srBadge = document.getElementById('sample-rate-badge');
        if (cfBadge) cfBadge.textContent = `CF: ${formatCenter(state.centerFreq)}`;
        if (srBadge) {
            const khz = state.sampleRate / 1000;
            srBadge.textContent = `SR: ${Number.isInteger(khz) ? khz : khz.toFixed(2)} kHz`;
        }
    }

    function updateSourceStatus() {
        const el = document.getElementById('source-status');
        if (!el) return;
        const source = src();
        const proto = sourcePolicy(source.protocol).label;
        const khz = state.sampleRate / 1000;
        const srTxt = `${Number.isInteger(khz) ? khz : khz.toFixed(2)} kHz`;
        const cf = formatCenter(state.centerFreq);
        let extra = '';
        if (source.protocol === 'kiwi') {
            extra = ` ${source.host}:${source.port}. Waterfall is a 12 kHz zoom; mouse and wheel move the Kiwi DDC.`;
        } else if (source.protocol === 'soundcard') {
            extra = ' Centre is 0 Hz (offset). Swap I/Q if the spectrum is reversed.';
        } else if (source.protocol === 'ic7300') {
            const g = ic7300Geometry(state.ic7300RadioHz, state.ic7300Mode, state.sampleRate);
            const track = state.ic7300TrackRate ? ` track ${(state.ic7300TrackRate / 1000)} kHz` : '';
            const ch = state.ic7300Channels ? ` ${state.ic7300Channels} ch` : '';
            const vfo = state.ic7300RadioHz
                ? ` VFO ${formatCenter(state.ic7300RadioHz)} ${g.label}.`
                : ' Waiting for CI-V. Cursor at −650 Hz.';
            const rig = ctx.transports.ic7300;
            const serial = rig ? ` ${rig.serialText}` : '';
            extra = `${track}${ch}.${vfo}${serial} Cursor stays on the signal.`;
        } else if (source.protocol === 'rtlsdr') {
            const modeEl = document.getElementById('rtlsdr-mode');
            const mode = modeEl ? modeEl.value : 'direct-q';
            const hfOnTuner = mode === 'tuner' && state.centerFreq < 24000000;
            extra = hfOnTuner
                ? ' Tuner mode does not hear HF. Use direct sampling Q on a Blog V3, or set an upconverter offset.'
                : ' Dongle LO is 384 kHz above the dial. Wheel tunes inside the 192 kHz window.';
        }
        el.textContent = `${proto} · ${srTxt} · CF ${cf}.${extra}`;
    }

    // Waterfall mouse: click/drag/wheel tuning, Shift pan, Ctrl+Shift bandwidth.
    waterfall.onTuneCallback = (newFreq) => {
        setTunedFrequency(newFreq, true);
    };
    waterfall.onBandwidthCallback = (direction) => {
        if (state.modulation === 'cw') {
            const el = document.getElementById('cw-bw-slider');
            if (!el) return;
            const next = Math.max(CW_BW_MIN, Math.min(CW_BW_MAX, state.cwBandwidth + direction * 10));
            if (next === state.cwBandwidth) return;
            el.value = String(next);
            el.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            const el = document.getElementById('ssb-high-slider');
            if (!el) return;
            el.value = String(state.ssbHigh + direction * 10);
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }
    };
    waterfall.onPanCallback = (deltaHz) => {
        if (isIc7300()) {
            ctx.tuneIc7300FromUser(state.ic7300RadioHz + deltaHz);
            return;
        }
        if (sourcePolicy(src().protocol).followsDial) {
            moveSourceCenter(Math.round(state.centerFreq + deltaHz));
            return;
        }
        waterfall.panOffset += deltaHz;
        waterfall.clampPan();
        waterfall.refreshChrome();
    };

    Object.assign(ctx, {
        currentDialHz, applyDialRange, applyIqRate, shiftCenter, applyCenter, setTunedFrequency,
        resetDspControl, setModulation, updateTopBarInfo, updateSourceStatus
    });
}

if (typeof globalThis !== 'undefined') {
    globalThis.createTuning = createTuning;
    globalThis.formatCenter = formatCenter;
}
if (typeof module !== 'undefined') module.exports = { createTuning, formatCenter };
