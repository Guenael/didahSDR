/**
 * didahSDR - page controls: power / audio / mode buttons, floating windows, the CW decoder window
 * and REC, the waterfall / CW / SSB / audio-FX panels, help, and the non-TX keyboard shortcuts
 * (Enter and the paddle keys are in tx_controller.js; Source-window controls in source_manager.js).
 */

function bindUi(ctx) {
    const { state, demodulator, waterfall, audioPlayer, smeter, clientFft, cwFilter, cwDecoder, cwRecorder } = ctx;
    const byId = (id) => document.getElementById(id);
    const src = () => ctx.source;

    const fpsBadge = byId('fps-badge');
    waterfall.onFpsCallback = (fps) => {
        if (fpsBadge) fpsBadge.textContent = `${fps} FPS`;
    };

    // ---- CW decoder window and REC --------------------------------------------------------------
    const recBtn = byId('decoder-rec-btn');
    const recNoiseBtn = byId('decoder-noise-btn');
    let decoderWindowVisible = false;
    let recNoise = false;
    let recTimer = null;
    let modelStamp = null;

    function updateRecUi() {
        if (!recBtn) return;
        const on = cwRecorder.recording;
        const s = Math.floor(cwRecorder.seconds);
        recBtn.textContent = on ? `● ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'REC';
        recBtn.classList.toggle('recording', on);
        recBtn.disabled = !on && !cwDecoder.active;
        if (recNoiseBtn) {
            recNoiseBtn.classList.toggle('active', recNoise);
            recNoiseBtn.disabled = on;
        }
        if (on && !recTimer) recTimer = setInterval(updateRecUi, 250);
        if (!on && recTimer) { clearInterval(recTimer); recTimer = null; }
    }
    cwRecorder.onStop = (clip) => { saveRecording(clip); updateRecUi(); };

    function toggleRec() {
        if (cwRecorder.recording) { cwRecorder.stop('user'); return; }
        if (!cwDecoder.active) return;
        const source = src();
        cwRecorder.start({
            kind: recNoise ? 'noise' : 'signal',
            rate: cwDecoder.rate,
            audioRate: demodulator.audioRate,
            carrierHz: state.tunedFreq,
            source: source.label,
            source_id: source.id,
            center_freq: state.centerFreq,
            cw_offset: state.cwOffset,
            bandwidth: state.cwBandwidth,
            model: modelStamp,
        });
        updateRecUi();
    }

    /** The decoder runs only while its window is open and the mode is CW. */
    function updateDecoderActive() {
        if (decoderWindowVisible && state.modulation === 'cw') cwDecoder.start(demodulator.audioRate);
        else cwDecoder.stop();
        updateRecUi();
    }
    ctx.updateDecoderActive = updateDecoderActive;

    // The model and onnxruntime-web are not in git (README, "CW decoder assets").
    Promise.all([
        fetch('models/didahcw.onnx', { method: 'HEAD' }),
        fetch('lib/ort.wasm.min.js', { method: 'HEAD' })
    ]).then(([model, ort]) => {
        if (model.ok) modelStamp = model.headers.get('last-modified');
        if (!model.ok) cwDecoder.setMissing('models/didahcw.onnx not installed (see README)');
        else if (!ort.ok) cwDecoder.setMissing('onnxruntime-web missing: run scripts/fetch_ort.sh');
        updateRecUi();
    }).catch(() => {});

    // ---- Power, audio, mode ---------------------------------------------------------------------
    const powerBtn = byId('power-btn');
    const rxBtn = byId('rx-btn');
    powerBtn.addEventListener('click', () => {
        state.running = !state.running;
        powerBtn.classList.toggle('active', state.running);
        if (rxBtn) rxBtn.classList.toggle('active', state.running && ctx.isActiveConnected());
        if (state.running) {
            audioPlayer.resume();
            if (!ctx.isActiveConnected()) ctx.connectActive(true);
            else ctx.sources.restartRtlIfIdle();
        } else {
            ctx.onTxPowerOff();
            audioPlayer.stop();
            smeter.reset();
            ctx.disconnectTransports();
            ctx.syncIc7300Key();
            ctx.updateTrxLeds();
        }
    });
    if (rxBtn) {
        rxBtn.addEventListener('click', () => {
            if (!state.running) powerBtn.click();
        });
    }

    // Audio start / unmute (browser autoplay rules need a click)
    const audioBtn = byId('audio-btn');
    const audioIcon = byId('audio-icon');
    const audioText = byId('audio-text');
    const AUDIO_LOOK = {
        unsupported: ['audio-toggle-btn muted', '⚠️', 'No AudioWorklet'],
        suspended: ['audio-toggle-btn need-start', '🔊', 'Start Audio'],
        uninitialized: ['audio-toggle-btn need-start', '🔊', 'Start Audio'],
        muted: ['audio-toggle-btn muted', '🔇', 'Muted'],
        running: ['audio-toggle-btn active', '🔊', 'Audio ON'],
    };
    audioPlayer.onStateChange = (audioState) => {
        const look = AUDIO_LOOK[audioState];
        if (!look) return;
        audioBtn.className = look[0];
        if (audioState === 'unsupported') audioBtn.disabled = true;
        if (audioIcon) audioIcon.textContent = look[1];
        if (audioText) audioText.textContent = look[2];
    };
    audioBtn.addEventListener('click', () => audioPlayer.toggleMute());

    /** CW / USB / LSB. With the IC-7300 the radio's mode is changed and didahSDR follows it. */
    function chooseMode(mod) {
        if (src().protocol === 'ic7300') ctx.selectIc7300Mode(mod);
        else ctx.setModulation(mod);
    }
    document.querySelectorAll('.mode-btn').forEach((btn) => {
        btn.addEventListener('click', () => chooseMode(btn.dataset.mode));
    });

    // ---- Floating windows -----------------------------------------------------------------------
    setupFloatingWindow({
        windowId: 'wconfig-window', headerId: 'wconfig-header', closeBtnId: 'wconfig-close-btn',
        toggleBtnId: 'wconfig-btn', storageKey: 'didah_wconfig', defaultVisible: false,
        defaultPos: { top: '58px', left: 'auto', right: '20px' }
    });
    setupFloatingWindow({
        windowId: 'vfo-mem-window', headerId: 'vfo-mem-header', closeBtnId: 'vfo-mem-close-btn',
        toggleBtnId: 'vfo-mem-btn', storageKey: 'didah_vfo_mem_win', defaultVisible: false,
        defaultPos: { top: 'auto', bottom: '118px', left: '16px', right: 'auto' }
    });
    ctx.vfoMemories = setupVfoMemories({
        listId: 'vfo-mem-list',
        addBtnId: 'vfo-mem-add',
        defaultsBtnId: 'vfo-mem-defaults',
        dialId: 'vfo-mem-dial',
        getDialHz: ctx.currentDialHz,
        onRecall: (hz) => {
            if (src().protocol === 'ic7300') ctx.tuneIc7300FromUser(hz);
            else ctx.setTunedFrequency(hz, true, true);
        }
    });
    if (ctx.vfoMemories) ctx.vfoMemories.syncDial(ctx.currentDialHz());
    setupFloatingWindow({
        windowId: 'source-window', headerId: 'source-header', closeBtnId: 'source-close-btn',
        toggleBtnId: 'source-btn', storageKey: 'didah_source', defaultVisible: false,
        defaultPos: { top: '58px', left: '20px', right: 'auto' }
    });
    setupFloatingWindow({
        windowId: 'decoder-window', headerId: 'decoder-header', closeBtnId: 'decoder-close-btn',
        toggleBtnId: 'decoder-btn', storageKey: 'didah_decoder', defaultVisible: false,
        defaultPos: { top: '400px', left: '20px', right: 'auto' },
        onVisibilityChange: (visible) => { decoderWindowVisible = visible; updateDecoderActive(); }
    });
    const decoderClearBtn = byId('decoder-clear-btn');
    if (decoderClearBtn) decoderClearBtn.addEventListener('click', () => cwDecoder.clear());
    if (recBtn) recBtn.addEventListener('click', toggleRec);
    if (recNoiseBtn) recNoiseBtn.addEventListener('click', () => { recNoise = !recNoise; updateRecUi(); });
    updateRecUi();

    // ---- Waterfall panel ------------------------------------------------------------------------
    const stepSelect = byId('step-select');
    const applyStep = () => {
        state.stepSize = parseInt(stepSelect.value, 10);
        waterfall.setStepSize(state.stepSize);
    };
    stepSelect.addEventListener('change', applyStep);
    const cycleStep = (dir) => {
        const idx = Math.max(0, Math.min(stepSelect.options.length - 1, stepSelect.selectedIndex + dir));
        if (idx !== stepSelect.selectedIndex) {
            stepSelect.selectedIndex = idx;
            applyStep();
        }
    };

    byId('fft-select').addEventListener('change', (e) => {
        state.fftSize = parseInt(e.target.value, 10);
        clientFft.setSize(state.fftSize);
        cwFilter.resize(state.fftSize);
        ctx.pipeline.onFftSizeChanged();
    });

    const themeSelect = byId('theme-select');
    if (themeSelect) {
        themeSelect.innerHTML = '';
        Colormaps.list().forEach(({ id, label }) => {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = label || id;
            if (id === state.primaryTheme) opt.selected = true;
            themeSelect.appendChild(opt);
        });
        themeSelect.addEventListener('change', (e) => {
            state.primaryTheme = e.target.value;
            waterfall.setPrimaryTheme(state.primaryTheme);
        });
    }

    /**
     * A range input bound to one state key: `parse` the value, show it with `format` in `#<valId>`,
     * then `apply` it. The value label is also filled once at start when `init` is set.
     */
    function slider(id, valId, key, { parse = (v) => parseInt(v, 10), format, apply, init = false } = {}) {
        const el = byId(id);
        const val = byId(valId);
        if (!el) return null;
        if (init) {
            el.value = state[key];
            if (val) val.textContent = format(state[key]);
        }
        el.addEventListener('input', (e) => {
            state[key] = parse(e.target.value);
            if (val) val.textContent = format(state[key]);
            if (apply) apply(state[key]);
        });
        return el;
    }

    slider('vol-slider', 'vol-val', 'volume', {
        parse: parseFloat, format: (v) => `${Math.round(v * 100)}%`, apply: (v) => audioPlayer.setVolume(v)
    });
    slider('min-lvl-slider', 'min-lvl-val', 'minLevel', {
        format: (v) => `${v} dB`, apply: () => waterfall.setLevels(state.minLevel, state.dynamicRange), init: true
    });
    slider('dyn-range-slider', 'dyn-range-val', 'dynamicRange', {
        format: (v) => `${v} dB`, apply: () => waterfall.setLevels(state.minLevel, state.dynamicRange), init: true
    });
    slider('speed-slider', 'speed-val', 'speedMultiplier', { format: (v) => `${v}x` });

    // ---- CW / SSB panel -------------------------------------------------------------------------
    slider('cw-offset-slider', 'cw-offset-val', 'cwOffset', {
        format: (v) => `${v} Hz`,
        apply: (v) => {
            audioPlayer.setSidetoneHz(v);
            ctx.setTunedFrequency(state.tunedFreq, false, false);
        }
    });
    const cwBwSlider = slider('cw-bw-slider', 'cw-bw-val', 'cwBandwidth', {
        format: (v) => `${v} Hz`,
        apply: () => {
            ctx.setTunedFrequency(state.tunedFreq, false, false);
            smeter.setModeInfo(state.modulation, state.cwBandwidth);
        }
    });
    if (cwBwSlider) {
        cwBwSlider.min = String(CW_BW_MIN);
        cwBwSlider.max = String(CW_BW_MAX);
    }

    function applySsbSliders() {
        const lowEl = byId('ssb-low-slider');
        const highEl = byId('ssb-high-slider');
        const pb = setSsbPassband(lowEl ? lowEl.value : state.ssbLow, highEl ? highEl.value : state.ssbHigh);
        state.ssbLow = pb.low;
        state.ssbHigh = pb.high;
        if (lowEl) lowEl.value = String(pb.low);
        if (highEl) highEl.value = String(pb.high);
        const lowVal = byId('ssb-low-val');
        const highVal = byId('ssb-high-val');
        if (lowVal) lowVal.textContent = `${pb.low} Hz`;
        if (highVal) highVal.textContent = `${pb.high} Hz`;
        if (state.modulation !== 'cw') ctx.setTunedFrequency(state.tunedFreq, false, false);
        if (src().protocol === 'ic7300') ctx.applyIc7300View();
        smeter.setModeInfo(state.modulation, state.cwBandwidth);
    }
    for (const id of ['ssb-low-slider', 'ssb-high-slider']) {
        const el = byId(id);
        if (el) el.addEventListener('input', applySsbSliders);
    }

    const agcSelect = byId('agc-select');
    if (agcSelect) {
        agcSelect.addEventListener('change', (e) => {
            state.agcSpeed = e.target.value;
            demodulator.setAgcSpeed(state.agcSpeed);
        });
    }

    const kernelSelect = byId('kernel-select');
    if (kernelSelect) {
        kernelSelect.addEventListener('change', (e) => {
            state.filterKernel = e.target.value;
            cwFilter.setKernel(state.filterKernel);
        });
    }

    // ---- ON/OFF buttons: CW filter, QRSS, autonotch, NR, squelch --------------------------------
    /** A toggle button: `set(on)` applies it, the button shows `<label>: ON|OFF`. */
    function toggleButton(id, key, label, set) {
        const btn = byId(id);
        const apply = (on) => {
            state[key] = !!on;
            set(state[key]);
            if (btn) {
                btn.classList.toggle('active', state[key]);
                btn.textContent = `${label}: ${state[key] ? 'ON' : 'OFF'}`;
            }
        };
        if (btn) btn.addEventListener('click', () => apply(!state[key]));
        return apply;
    }

    ctx.setCwFilterEnabled = toggleButton('cw-filter-toggle', 'filterEnabled', 'CW Filter', (on) => {
        cwFilter.enabled = on;
        // Flat-top keeps a keyed carrier's level honest; the click filter sharpens it back.
        clientFft.initWindow(on ? 'flattop' : 'bh4');
    });
    // The pipeline owns the QRSS state flag; the button only mirrors it.
    const qrssBtn = byId('qrss-toggle');
    ctx.setQrssEnabled = (on) => {
        ctx.pipeline.setQrssEnabled(on);
        if (qrssBtn) {
            qrssBtn.classList.toggle('active', state.qrssEnabled);
            qrssBtn.textContent = state.qrssEnabled ? 'QRSS: ON' : 'QRSS: OFF';
        }
    };
    if (qrssBtn) qrssBtn.addEventListener('click', () => ctx.setQrssEnabled(!state.qrssEnabled));
    ctx.setAutonotchEnabled = toggleButton('autonotch-toggle', 'autonotchEnabled', 'Autonotch',
        (on) => demodulator.setAutonotchEnabled(on));
    ctx.setNrEnabled = toggleButton('nr-toggle', 'nrEnabled', 'Noise Reduction', (on) => demodulator.setNrEnabled(on));
    ctx.setSquelchEnabled = toggleButton('squelch-toggle', 'squelchEnabled', 'Squelch',
        (on) => demodulator.setSquelchEnabled(on));

    slider('autonotch-depth-slider', 'autonotch-depth-val', 'autonotchDepth', {
        format: (v) => `${v}%`, apply: (v) => demodulator.setAutonotchDepth(v)
    });
    slider('nr-strength-slider', 'nr-strength-val', 'nrStrength', {
        format: (v) => `${v}%`, apply: (v) => demodulator.setNrStrength(v)
    });
    slider('squelch-thr-slider', 'squelch-thr-val', 'squelchMargin', {
        format: (v) => `${v} dB`, apply: (v) => demodulator.setSquelchMarginDb(v)
    });

    // ---- Help and keyboard ----------------------------------------------------------------------
    const helpModal = byId('help-modal');
    const openHelp = () => helpModal.classList.remove('hidden');
    const closeHelp = () => helpModal.classList.add('hidden');
    byId('help-btn').addEventListener('click', openHelp);
    byId('help-close-btn').addEventListener('click', closeHelp);
    helpModal.addEventListener('click', (e) => {
        if (e.target === helpModal) closeHelp();
    });

    const dialContainer = byId('freq-dial-container');
    const stepVfo = (dir) => {
        if (src().protocol === 'ic7300') ctx.tuneIc7300FromUser(state.ic7300RadioHz + dir * state.stepSize);
        else ctx.setTunedFrequency(state.tunedFreq + dir * state.stepSize);
    };
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeHelp();
            return;
        }
        if (e.key === 'Enter' || PADDLE_KEYS[e.key]) return;   // tx_controller.js

        // Don't intercept if the user is typing in a form input; the dial owns digits and arrow keys
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
        const inDial = dialContainer.contains(e.target);
        if (inDial && (e.key >= '0' && e.key <= '9')) return;

        if (e.key === ' ') {
            e.preventDefault();
            powerBtn.click();
        } else if (e.key === 'm' || e.key === 'M') {
            e.preventDefault();
            const modes = ['cw', 'usb', 'lsb'];
            chooseMode(modes[(modes.indexOf(state.modulation) + 1) % modes.length]);
        } else if (src().protocol === 'ic7300' && (
            e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End'
        )) {
            if (!inDial) e.preventDefault();   // the IC-7300 view is locked
        } else if (e.key === '+' || e.key === '=') {
            e.preventDefault();
            cycleStep(+1);
        } else if (e.key === '-' || e.key === '_') {
            e.preventDefault();
            cycleStep(-1);
        } else if (inDial) {
            // the drum dial handles its own arrows
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            waterfall.zoomIn();
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            waterfall.zoomOut();
        } else if (e.key === 'Home') {
            e.preventDefault();
            waterfall.zoomMin();
        } else if (e.key === 'End') {
            e.preventDefault();
            waterfall.zoomMax();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            stepVfo(+1);
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            stepVfo(-1);
        }
    });

    // Unlock Web Audio on the first interaction
    const unlockAudio = () => {
        audioPlayer.resume();
        window.removeEventListener('click', unlockAudio);
    };
    window.addEventListener('click', unlockAudio);
}

if (typeof globalThis !== 'undefined') globalThis.bindUi = bindUi;
if (typeof module !== 'undefined') module.exports = { bindUi };
