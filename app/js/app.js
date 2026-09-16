/**
 * didahSDR - Main Application Controller
 * Coordinates UI, Waterfall Canvas, ValueDial, DSP Filters, Audio, and WebSocket.
 */

document.addEventListener('DOMContentLoaded', () => {
    // State
    const state = {
        running: true,
        centerFreq: 14048000,
        sampleRate: 96000,
        tunedFreq: 14048700,
        modulation: 'cw',
        cwBandwidth: 150,     // 50 to 350 Hz
        cwOffset: 700,        // 400 to 1000 Hz dedicated tone offset (default 700 Hz)
        bfoPitch: 700,        // BFO pitch matches cwOffset
        lowCut: -75,          // Symmetrical around carrier for CW
        highCut: 75,
        volume: 0.8,
        minLevel: -127,       // Default -127 dB (FFT levels are window-gain normalised)
        dynamicRange: 60,     // Default 60 dB
        primaryTheme: 'viridis',
        stepSize: 100,
        speedMultiplier: 3,   // Default 3x speed
        fftSize: 2048,        // Default 2048 (Balanced)
        filterEnabled: true,
        filterKernel: 'medium', // Default Medium (7-tap) Click Filter
        agcSpeed: 'medium',
        userHasTuned: false   // once true, the server's start_freq is no longer applied
    };

    // 1. Initialize CW Adaptive Filter (from my_adaptive_iir_filter.py)
    const cwFilter = new CWAdaptiveFilter(state.fftSize);
    cwFilter.enabled = state.filterEnabled;
    cwFilter.setKernel(state.filterKernel);

    // 2. Initialize Fast Client-Side Radix-2 FFT Engine
    const clientFft = new DidahFFT(state.fftSize);

    // 3. Initialize Client-Side Demodulator with AGC
    const demodulator = new DidahDemodulator(state.sampleRate, 48000);
    demodulator.setAgcSpeed(state.agcSpeed);
    demodulator.setCwBandwidth(state.cwBandwidth);
    demodulator.setBfoPitch(state.cwOffset);

    // 4. Initialize Web Audio Player
    const audioPlayer = new WebAudioPlayer();
    audioPlayer.setVolume(state.volume);
    audioPlayer.extraStats = () => {
        const agc = demodulator.agc;
        return { noiseFloor: agc.noiseFloor.toExponential(1), gain: agc.gNext.toFixed(1), fft: state.fftSize, speed: state.speedMultiplier };
    };

    // 5. Initialize Horizontal Waterfall
    state.lowCut = -state.cwBandwidth / 2;
    state.highCut = state.cwBandwidth / 2;

    const waterfall = new HorizontalWaterfall('waterfall-area', {
        centerFreq: state.centerFreq,
        sampleRate: state.sampleRate,
        tunedFreq: state.tunedFreq,
        lowCut: state.lowCut,
        highCut: state.highCut,
        modulation: state.modulation,
        minLevel: state.minLevel,
        dynamicRange: state.dynamicRange,
        stepSize: state.stepSize,
        primaryTheme: state.primaryTheme
    });

    // 6. Initialize SDRangelove Mechanical Drum ValueDial
    const dialContainer = document.getElementById('freq-dial-container');
    const valueDial = new SDRValueDial(dialContainer, {
        value: state.tunedFreq,
        unit: 'Hz',
        onChange: (newFreq) => {
            setTunedFrequency(newFreq, false);
        }
    });

    // 7. STFT Overlap Ring Buffer for Client-Side FFT
    const RING_SIZE = 32768;
    const ringReal = new Float32Array(RING_SIZE);
    const ringImag = new Float32Array(RING_SIZE);
    let ringHead = 0;
    let samplesAvailable = 0;

    let blockReal = new Float32Array(state.fftSize);
    let blockImag = new Float32Array(state.fftSize);

    // 7b. Initialize SNR S-Meter (0 to 40+ dB above local noise floor)
    const smeter = new DidahSMeter();
    smeter.init();
    smeter.setModeInfo(state.modulation, state.cwBandwidth);

    // 8. Initialize didahSDR WebSocket Connection
    const fpsBadge = document.getElementById('fps-badge');
    waterfall.onFpsCallback = (fps) => {
        if (fpsBadge) fpsBadge.textContent = `${fps} FPS`;
    };

    const conn = new DidahConnection({
        onStatusChange: (statusText, isConnected) => {
            const dot = document.getElementById('status-dot');
            const text = document.getElementById('status-text');
            if (dot) dot.className = `status-dot ${isConnected ? 'connected' : ''}`;
            if (text) text.textContent = statusText;
            const rxBtn = document.getElementById('rx-btn');
            if (rxBtn) rxBtn.classList.toggle('active', isConnected && state.running);
        },
        onConfig: (cfg) => {
            if (cfg.center_freq) {
                state.centerFreq = cfg.center_freq;
            }
            if (cfg.samp_rate) {
                state.sampleRate = cfg.samp_rate;
            }
            if (cfg.start_freq && !state.userHasTuned) {
                state.tunedFreq = cfg.start_freq;
                valueDial.setValue(state.tunedFreq, false);
            }
            if (cfg.start_mod) {
                setModulation(cfg.start_mod);
            }
            waterfall.setCenterFreq(state.centerFreq, state.sampleRate);
            setTunedFrequency(state.tunedFreq, true, false);
            updateTopBarInfo();

            conn.setStreamMode('raw_iq');
        },
        // Client-side Zero-Latency Stream: processes both audio and waterfall in lockstep
        onRawIQ: (int16IQ) => {
            if (!state.running) return;

            // A. Demodulate audio in browser (zero network roundtrip, instantaneous response)
            audioPlayer.pushFloatAudio(demodulator.process(int16IQ));

            // B. Client-side STFT FFT with partial segment overlap
            const numComplex = int16IQ.length / 2;
            const inv32768 = 1.0 / 32768.0;

            for (let i = 0; i < numComplex; i++) {
                ringReal[ringHead] = int16IQ[i * 2] * inv32768;
                ringImag[ringHead] = int16IQ[i * 2 + 1] * inv32768;
                ringHead = ringHead === RING_SIZE - 1 ? 0 : ringHead + 1;
            }
            samplesAvailable += numComplex;

            // Calculate hop size from speedMultiplier (1x, 2x, 3x, 4x)
            const hopSize = Math.max(128, Math.floor(state.fftSize / Math.max(1, state.speedMultiplier)));

            while (samplesAvailable >= state.fftSize) {
                let readIdx = (ringHead - samplesAvailable + RING_SIZE) % RING_SIZE;
                for (let i = 0; i < state.fftSize; i++) {
                    blockReal[i] = ringReal[readIdx];
                    blockImag[i] = ringImag[readIdx];
                    readIdx = readIdx === RING_SIZE - 1 ? 0 : readIdx + 1;
                }

                const specDb = clientFft.computeSpectrumDb(blockReal, blockImag);
                const processed = state.filterEnabled ? cwFilter.process(specDb) : specDb;
                waterfall.addSlice(processed);

                // Update SNR S-Meter (dB above local noise floor)
                smeter.updateFromSpectrum(specDb, state.sampleRate, state.centerFreq, state.tunedFreq, state.modulation, state.cwBandwidth);

                samplesAvailable -= hopSize;
            }
        }
    });

    // Connect Waterfall click/drag/wheel tuning to ValueDial and DSP
    waterfall.onTuneCallback = (newFreq) => {
        setTunedFrequency(newFreq, true);
    };

    /**
     * The one place demod / waterfall / server state is updated from a new VFO frequency.
     * @param {boolean} fromUser - false only for server-config or internal re-application
     */
    function setTunedFrequency(freq, updateDial = true, fromUser = true) {
        state.tunedFreq = Math.round(freq);
        if (fromUser) state.userHasTuned = true;
        if (updateDial) {
            valueDial.setValue(state.tunedFreq, false);
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
        sendDspControl();
    }

    // dspcontrol is informational for the test server; coalesce mouse-rate tuning into one send per
    // animation frame and skip it entirely when nothing changed.
    let dspControlPending = false;
    let lastDspControl = '';
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
            conn.setDemodParams(params);
        });
    }

    function setModulation(mod) {
        state.modulation = mod.toLowerCase();
        const cwBwContainer = document.getElementById('cw-bw-container');
        const cwOffsetContainer = document.getElementById('cw-offset-container');
        if (cwBwContainer) {
            cwBwContainer.style.opacity = (state.modulation === 'cw') ? '1.0' : '0.4';
        }
        if (cwOffsetContainer) {
            cwOffsetContainer.style.opacity = (state.modulation === 'cw') ? '1.0' : '0.4';
        }

        document.querySelectorAll('.mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === state.modulation);
        });

        setTunedFrequency(state.tunedFreq, false, false);
        smeter.setModeInfo(state.modulation, state.cwBandwidth);
    }

    function updateTopBarInfo() {
        const cfBadge = document.getElementById('center-freq-badge');
        const srBadge = document.getElementById('sample-rate-badge');
        if (cfBadge) cfBadge.textContent = `CF: ${(state.centerFreq / 1000000).toFixed(4)} MHz`;
        if (srBadge) srBadge.textContent = `SR: ${state.sampleRate / 1000} kHz`;
    }

    // =========================================================================
    // UI Event Handlers
    // =========================================================================

    // 1. Power Button (⏻)
    const powerBtn = document.getElementById('power-btn');
    const rxBtn = document.getElementById('rx-btn');
    powerBtn.addEventListener('click', () => {
        state.running = !state.running;
        powerBtn.classList.toggle('active', state.running);
        if (rxBtn) rxBtn.classList.toggle('active', state.running && conn.connected);
        if (state.running) {
            audioPlayer.resume();
            if (!conn.connected) {
                conn.connect();
            }
        } else {
            audioPlayer.stop();
            smeter.reset();
        }
    });

    if (rxBtn) {
        rxBtn.addEventListener('click', () => {
            if (!state.running) {
                powerBtn.click();
            }
        });
    }

    // 2. Audio Start / Unmute Button (Browser Autoplay compliance)
    const audioBtn = document.getElementById('audio-btn');
    const audioIcon = document.getElementById('audio-icon');
    const audioText = document.getElementById('audio-text');

    audioPlayer.onStateChange = (audioState) => {
        if (audioState === 'unsupported') {
            audioBtn.className = 'audio-toggle-btn muted';
            audioBtn.disabled = true;
            if (audioIcon) audioIcon.textContent = '⚠️';
            if (audioText) audioText.textContent = 'No AudioWorklet';
        } else if (audioState === 'suspended' || audioState === 'uninitialized') {
            audioBtn.className = 'audio-toggle-btn need-start';
            if (audioIcon) audioIcon.textContent = '🔊';
            if (audioText) audioText.textContent = 'Start Audio';
        } else if (audioState === 'muted') {
            audioBtn.className = 'audio-toggle-btn muted';
            if (audioIcon) audioIcon.textContent = '🔇';
            if (audioText) audioText.textContent = 'Muted';
        } else if (audioState === 'running') {
            audioBtn.className = 'audio-toggle-btn active';
            if (audioIcon) audioIcon.textContent = '🔊';
            if (audioText) audioText.textContent = 'Audio ON';
        }
    };

    audioBtn.addEventListener('click', () => {
        audioPlayer.toggleMute();
    });

    // 3. Mode Buttons (USB, LSB, CW)
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            setModulation(btn.dataset.mode);
        });
    });

    // 4. W-Config floating window (waterfall settings), same behaviour as the S-Meter window
    setupFloatingWindow({
        windowId: 'wconfig-window', headerId: 'wconfig-header', closeBtnId: 'wconfig-close-btn',
        toggleBtnId: 'wconfig-btn', storageKey: 'didah_wconfig', defaultVisible: false,
        defaultPos: { top: '58px', left: 'auto', right: '20px' }
    });

    // 5. Tuning Step Selector (also driven by the + / - keys)
    const stepSelect = document.getElementById('step-select');
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

    // 6. FFT Size Selector
    const fftSelect = document.getElementById('fft-select');
    fftSelect.addEventListener('change', (e) => {
        state.fftSize = parseInt(e.target.value, 10);
        clientFft.setSize(state.fftSize);
        cwFilter.resize(state.fftSize);
        blockReal = new Float32Array(state.fftSize);
        blockImag = new Float32Array(state.fftSize);
        samplesAvailable = 0;
    });

    // 7. Colormap Theme Selector
    const themeSelect = document.getElementById('theme-select');
    if (themeSelect) {
        themeSelect.innerHTML = '';
        const availableThemes = Colormaps.list();
        availableThemes.forEach(({ id, label }) => {
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

    // 8. Sliders (Volume, Min Level, Dynamic Range, WF Speed, CW Bandwidth)
    const volSlider = document.getElementById('vol-slider');
    const volVal = document.getElementById('vol-val');
    volSlider.addEventListener('input', (e) => {
        state.volume = parseFloat(e.target.value);
        volVal.textContent = `${Math.round(state.volume * 100)}%`;
        audioPlayer.setVolume(state.volume);
    });

    const minLvlSlider = document.getElementById('min-lvl-slider');
    const minLvlVal = document.getElementById('min-lvl-val');
    if (minLvlSlider) {
        minLvlSlider.value = state.minLevel;
        if (minLvlVal) minLvlVal.textContent = `${state.minLevel} dB`;
        minLvlSlider.addEventListener('input', (e) => {
            state.minLevel = parseInt(e.target.value, 10);
            if (minLvlVal) minLvlVal.textContent = `${state.minLevel} dB`;
            waterfall.setLevels(state.minLevel, state.dynamicRange);
        });
    }

    const dynRangeSlider = document.getElementById('dyn-range-slider');
    const dynRangeVal = document.getElementById('dyn-range-val');
    if (dynRangeSlider) {
        dynRangeSlider.value = state.dynamicRange;
        if (dynRangeVal) dynRangeVal.textContent = `${state.dynamicRange} dB`;
        dynRangeSlider.addEventListener('input', (e) => {
            state.dynamicRange = parseInt(e.target.value, 10);
            if (dynRangeVal) dynRangeVal.textContent = `${state.dynamicRange} dB`;
            waterfall.setLevels(state.minLevel, state.dynamicRange);
        });
    }

    const speedSlider = document.getElementById('speed-slider');
    const speedVal = document.getElementById('speed-val');
    if (speedSlider) {
        speedSlider.addEventListener('input', (e) => {
            state.speedMultiplier = parseInt(e.target.value, 10);
            if (speedVal) speedVal.textContent = `${state.speedMultiplier}x`;
        });
    }

    // Dedicated CW BFO Slider (400 to 1000 Hz, default 700 Hz)
    const cwOffsetSlider = document.getElementById('cw-offset-slider');
    const cwOffsetVal = document.getElementById('cw-offset-val');
    if (cwOffsetSlider) {
        cwOffsetSlider.addEventListener('input', (e) => {
            state.cwOffset = parseInt(e.target.value, 10);
            state.bfoPitch = state.cwOffset;
            if (cwOffsetVal) cwOffsetVal.textContent = `${state.cwOffset} Hz`;
            setTunedFrequency(state.tunedFreq, false, false);
        });
    }

    const cwBwSlider = document.getElementById('cw-bw-slider');
    const cwBwVal = document.getElementById('cw-bw-val');
    if (cwBwSlider) {
        cwBwSlider.addEventListener('input', (e) => {
            state.cwBandwidth = parseInt(e.target.value, 10);
            if (cwBwVal) cwBwVal.textContent = `${state.cwBandwidth} Hz`;
            setTunedFrequency(state.tunedFreq, false, false);
            smeter.setModeInfo(state.modulation, state.cwBandwidth);
        });
    }

    // 9. AGC Speed Selector (Fast, Medium, Slow)
    const agcSelect = document.getElementById('agc-select');
    if (agcSelect) {
        agcSelect.addEventListener('change', (e) => {
            state.agcSpeed = e.target.value;
            demodulator.setAgcSpeed(state.agcSpeed);
        });
    }

    // 10. CW Adaptive Filter & Click Filter Controls
    const cwFilterToggle = document.getElementById('cw-filter-toggle');
    cwFilterToggle.addEventListener('click', () => {
        state.filterEnabled = !state.filterEnabled;
        cwFilter.enabled = state.filterEnabled;
        cwFilterToggle.classList.toggle('active', state.filterEnabled);
        cwFilterToggle.textContent = state.filterEnabled ? 'CW Filter: ON' : 'CW Filter: OFF';
    });

    const kernelSelect = document.getElementById('kernel-select');
    if (kernelSelect) {
        kernelSelect.addEventListener('change', (e) => {
            state.filterKernel = e.target.value;
            cwFilter.setKernel(state.filterKernel);
        });
    }

    // 11. Help Modal Dialog
    const helpBtn = document.getElementById('help-btn');
    const helpModal = document.getElementById('help-modal');
    const helpCloseBtn = document.getElementById('help-close-btn');

    const openHelp = () => helpModal.classList.remove('hidden');
    const closeHelp = () => helpModal.classList.add('hidden');

    helpBtn.addEventListener('click', openHelp);
    helpCloseBtn.addEventListener('click', closeHelp);
    helpModal.addEventListener('click', (e) => {
        if (e.target === helpModal) closeHelp();
    });

    // 12. Global Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeHelp();
            return;
        }

        // Don't intercept if user is typing in a form input; the dial owns digits and arrow keys
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
        const inDial = dialContainer.contains(e.target);
        if (inDial && (e.key >= '0' && e.key <= '9')) return;

        if (e.key === ' ') {
            e.preventDefault();
            powerBtn.click();
        } else if (e.key === 'm' || e.key === 'M') {
            e.preventDefault();
            const modes = ['cw', 'usb', 'lsb'];
            const curIdx = modes.indexOf(state.modulation);
            const nextMode = modes[(curIdx + 1) % modes.length];
            setModulation(nextMode);
        } else if (e.key === '+' || e.key === '=') {
            e.preventDefault();
            cycleStep(+1);
        } else if (e.key === '-' || e.key === '_') {
            e.preventDefault();
            cycleStep(-1);
        } else if (e.key === 'ArrowRight' && !inDial) {
            e.preventDefault();
            waterfall.zoomIn();
        } else if (e.key === 'ArrowLeft' && !inDial) {
            e.preventDefault();
            waterfall.zoomOut();
        } else if (e.key === 'Home' && !inDial) {
            e.preventDefault();
            waterfall.zoomMin();
        } else if (e.key === 'End' && !inDial) {
            e.preventDefault();
            waterfall.zoomMax();
        } else if (e.key === 'ArrowUp' && !inDial) {
            e.preventDefault();
            setTunedFrequency(state.tunedFreq + state.stepSize);
        } else if (e.key === 'ArrowDown' && !inDial) {
            e.preventDefault();
            setTunedFrequency(state.tunedFreq - state.stepSize);
        }
    });

    // Unlock Web Audio on any initial interaction
    const unlockAudio = () => {
        audioPlayer.resume();
        window.removeEventListener('click', unlockAudio);
    };
    window.addEventListener('click', unlockAudio);

    // 13. Settings persistence. Saved: everything the operator sets in the panels. Not saved: the
    // tuned frequency and mode (they come from the server config) and the power state.
    // Restoring goes through the controls themselves (set value, dispatch the event) so the
    // existing handlers apply each setting and there is no second copy of the apply logic.
    const SETTINGS_KEY = 'didah_settings';
    const SETTINGS = [
        // [state key, element id, event]
        ['volume', 'vol-slider', 'input'],
        ['minLevel', 'min-lvl-slider', 'input'],
        ['dynamicRange', 'dyn-range-slider', 'input'],
        ['speedMultiplier', 'speed-slider', 'input'],
        ['cwOffset', 'cw-offset-slider', 'input'],
        ['cwBandwidth', 'cw-bw-slider', 'input'],
        ['stepSize', 'step-select', 'change'],
        ['fftSize', 'fft-select', 'change'],
        ['primaryTheme', 'theme-select', 'change'],
        ['agcSpeed', 'agc-select', 'change'],
        ['filterKernel', 'kernel-select', 'change'],
    ];

    function saveSettings() {
        const out = {};
        for (const [key] of SETTINGS) out[key] = state[key];
        out.filterEnabled = state.filterEnabled;
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(out)); } catch (e) { /* storage unavailable */ }
    }

    function loadSettings() {
        let saved;
        try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch (e) { saved = null; }
        if (!saved) return;
        for (const [key, id, evt] of SETTINGS) {
            if (saved[key] === undefined) continue;
            const el = document.getElementById(id);
            if (!el) continue;
            el.value = String(saved[key]);
            if (el.tagName === 'SELECT' && el.value !== String(saved[key])) continue;   // option no longer exists
            el.dispatchEvent(new Event(evt, { bubbles: true }));
        }
        if (saved.filterEnabled !== undefined && saved.filterEnabled !== state.filterEnabled) cwFilterToggle.click();
    }

    // Any control change in the bottom panel or the W-Config window schedules a save
    let saveTimer = null;
    const scheduleSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveSettings, 250); };
    for (const id of ['bottom-panel', 'wconfig-window']) {
        const root = document.getElementById(id);
        if (!root) continue;
        root.addEventListener('input', scheduleSave);
        root.addEventListener('change', scheduleSave);
        root.addEventListener('click', scheduleSave);
    }
    loadSettings();

    // Initial connection
    updateTopBarInfo();
    conn.connect();
});
