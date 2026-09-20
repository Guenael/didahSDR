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
        userHasTuned: false,  // once true, the server's start_freq is no longer applied
        selectedSourceId: 'va2gka',
        ssbLow: 200,
        ssbHigh: 2700,
        qrssEnabled: false,
        wpm: 20,
        iambicMode: 'B'
    };

    setSsbPassband(state.ssbLow, state.ssbHigh);

    let source = findSource(state.selectedSourceId);
    let kiwi = null;
    let sound = null;

    // 1. Initialize CW Adaptive Filter (from my_adaptive_iir_filter.py)
    const cwFilter = new CWAdaptiveFilter(state.fftSize);
    cwFilter.enabled = state.filterEnabled;
    cwFilter.setKernel(state.filterKernel);

    // 2. Initialize Fast Client-Side Radix-2 FFT Engine
    const clientFft = new DidahFFT(state.fftSize);

    // 3. Initialize Client-Side Demodulator with AGC
    const demodulator = new DidahDemodulator(state.sampleRate, 48000);

    // Neural CW decoder (worker + ONNX). Runs only while its window is open and the mode is CW.
    const cwDecoder = new CWDecoder(demodulator, {
        output: document.getElementById('decoder-output'),
        status: document.getElementById('decoder-status')
    });
    let decoderWindowVisible = false;
    function updateDecoderActive() {
        if (decoderWindowVisible && state.modulation === 'cw') cwDecoder.start(demodulator.audioRate);
        else cwDecoder.stop();
    }
    demodulator.setAgcSpeed(state.agcSpeed);
    demodulator.setCwBandwidth(state.cwBandwidth);
    demodulator.setBfoPitch(state.cwOffset);

    const keyer = new CwKeyer();
    keyer.setWpm(state.wpm);
    keyer.setIambicMode(state.iambicMode);

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
    let qrssAcc = new Float32Array(state.fftSize);
    let qrssCount = 0;

    function resetQrssAcc() {
        qrssAcc.fill(0);
        qrssCount = 0;
    }

    /** QRSS: slower columns via Welch-style power averaging. Speed 1x integrates longest. */
    function qrssAvgCount() {
        const speed = Math.max(1, Math.min(8, state.speedMultiplier));
        return Math.max(4, 16 * (9 - speed));
    }

    // 7b. Initialize SNR S-Meter (0 to 40+ dB above local noise floor)
    const smeter = new DidahSMeter();
    smeter.init();
    smeter.setModeInfo(state.modulation, state.cwBandwidth);

    // 8. IQ transports: local didah /ws (replay) or a direct KiwiSDR SND socket
    const fpsBadge = document.getElementById('fps-badge');
    waterfall.onFpsCallback = (fps) => {
        if (fpsBadge) fpsBadge.textContent = `${fps} FPS`;
    };

    function setStatus(statusText, isConnected) {
        const dot = document.getElementById('status-dot');
        const text = document.getElementById('status-text');
        if (dot) dot.className = `status-dot ${isConnected ? 'connected' : ''}`;
        if (text) text.textContent = statusText;
        const rxBtn = document.getElementById('rx-btn');
        if (rxBtn) rxBtn.classList.toggle('active', isConnected && state.running && !keyer.isTx());
        updateTrxLeds();
    }

    function updateTrxLeds() {
        const rxBtn = document.getElementById('rx-btn');
        const txBtn = document.getElementById('tx-btn');
        const onAir = keyer.isTx();
        if (rxBtn) rxBtn.classList.toggle('active', state.running && isActiveConnected() && !onAir);
        if (txBtn) txBtn.classList.toggle('active', keyer.isKeyed());
    }

    function consumeTxChar() {
        const el = document.getElementById('tx-text');
        if (!el) return null;
        const cleaned = sanitizeTxText(el.value);
        if (cleaned !== el.value) el.value = cleaned;
        if (!el.value.length) return null;
        const ch = el.value[0];
        const start = el.selectionStart | 0;
        const end = el.selectionEnd | 0;
        el.value = el.value.slice(1);
        el.selectionStart = Math.max(0, start - 1);
        el.selectionEnd = Math.max(0, end - 1);
        return ch;
    }
    keyer.pullChar = consumeTxChar;

    let wasTransmitting = false;
    function processRawIQ(int16IQ) {
        if (!state.running) return;

        const numComplex = int16IQ.length / 2;
        const txTextEl = document.getElementById('tx-text');
        const hasText = !!(txTextEl && txTextEl.value.length);
        const useTx = state.modulation === 'cw' && keyer.willTransmit(hasText);

        if (useTx !== wasTransmitting) {
            ringHead = 0;
            samplesAvailable = 0;
            resetQrssAcc();
            if (useTx) cwDecoder.reset();
            waterfall.setShowPassband(!useTx);
        }
        wasTransmitting = useTx;

        if (useTx) {
            const nAudio = Math.max(1, Math.floor(numComplex / Math.max(1, demodulator.decim)));
            keyer.render(
                nAudio, demodulator.audioRate,
                numComplex, demodulator.iqRate,
                state.cwOffset, state.tunedFreq - state.centerFreq
            );
            audioPlayer.pushFloatAudio(keyer.audioOut);
            for (let i = 0; i < numComplex; i++) {
                ringReal[ringHead] = keyer.iqI[i];
                ringImag[ringHead] = keyer.iqQ[i];
                ringHead = ringHead === RING_SIZE - 1 ? 0 : ringHead + 1;
            }
            samplesAvailable += numComplex;
        } else {
            audioPlayer.pushFloatAudio(demodulator.process(int16IQ));

            const inv32768 = 1.0 / 32768.0;
            for (let i = 0; i < numComplex; i++) {
                ringReal[ringHead] = int16IQ[i * 2] * inv32768;
                ringImag[ringHead] = int16IQ[i * 2 + 1] * inv32768;
                ringHead = ringHead === RING_SIZE - 1 ? 0 : ringHead + 1;
            }
            samplesAvailable += numComplex;
        }

        const hopDiv = state.qrssEnabled ? 2 : Math.max(1, state.speedMultiplier);
        const hopSize = Math.max(128, Math.floor(state.fftSize / hopDiv));
        const avgN = state.qrssEnabled ? qrssAvgCount() : 1;

        while (samplesAvailable >= state.fftSize) {
            let readIdx = (ringHead - samplesAvailable + RING_SIZE) % RING_SIZE;
            for (let i = 0; i < state.fftSize; i++) {
                blockReal[i] = ringReal[readIdx];
                blockImag[i] = ringImag[readIdx];
                readIdx = readIdx === RING_SIZE - 1 ? 0 : readIdx + 1;
            }

            const specDb = clientFft.computeSpectrumDb(blockReal, blockImag);

            if (state.qrssEnabled) {
                const mag2 = clientFft.mag2Buffer;
                const n = specDb.length;
                for (let i = 0; i < n; i++) qrssAcc[i] += mag2[i];
                qrssCount++;
                if (qrssCount < avgN) {
                    samplesAvailable -= hopSize;
                    continue;
                }
                const inv = 1.0 / qrssCount;
                for (let i = 0; i < n; i++) {
                    specDb[i] = 10.0 * Math.log10(Math.max(qrssAcc[i] * inv, 1e-15));
                    qrssAcc[i] = 0;
                }
                qrssCount = 0;
            }

            const processed = state.filterEnabled ? cwFilter.process(specDb) : specDb;
            waterfall.addSlice(processed);

            smeter.updateFromSpectrum(specDb, state.sampleRate, state.centerFreq, state.tunedFreq, state.modulation, state.cwBandwidth);

            samplesAvailable -= hopSize;
        }
        updateTrxLeds();
    }

    function resetIqPipeline() {
        ringHead = 0;
        samplesAvailable = 0;
        audioPlayer.resetBuffer();
        waterfall.clear();
        smeter.reset();
        resetQrssAcc();
    }

    function applyDialRange() {
        if (source.protocol === 'soundcard') {
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
        resetIqPipeline();
        waterfall.setCenterFreq(state.centerFreq, rate);
        applyDialRange();
        if (rate < 30000) waterfall.zoomMin();
        else if (waterfall.zoom <= 1.01) waterfall.setZoom(2.67);
    }

    const conn = new DidahConnection({
        onStatusChange: (statusText, isConnected) => {
            if (source.protocol !== 'didah') return;
            setStatus(statusText, isConnected);
        },
        onConfig: (cfg) => {
            if (source.protocol !== 'didah') return;
            if (cfg.center_freq) {
                state.centerFreq = cfg.center_freq;
            }
            if (cfg.samp_rate) {
                applyIqRate(cfg.samp_rate);
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
            updateSourceStatus();

            conn.setStreamMode('raw_iq');
        },
        onRawIQ: processRawIQ
    });

    function ensureKiwi() {
        if (kiwi) return kiwi;
        kiwi = new KiwiConnection({
            onRawIQ: processRawIQ,
            onReady: (info) => {
                if (source.protocol !== 'kiwi') return;
                applyIqRate(info.sampleRate);
                state.centerFreq = info.centerFreq;
                waterfall.setCenterFreq(state.centerFreq, state.sampleRate);
                waterfall.zoomMin();
                setTunedFrequency(state.tunedFreq, true, false);
                updateTopBarInfo();
                updateSourceStatus();
            },
            onStatusChange: (statusText, isConnected) => {
                if (source.protocol !== 'kiwi') return;
                setStatus(statusText, isConnected);
            }
        });
        return kiwi;
    }

    function fillSoundDeviceSelect(devices) {
        const sel = document.getElementById('sound-device');
        if (!sel) return;
        const want = sel.value || (sound && sound.deviceId) || '';
        sel.innerHTML = '';
        if (!devices.length) {
            sel.appendChild(new Option('No audio inputs found', ''));
            sel.classList.remove('has-unsupported');
            return;
        }
        for (let i = 0; i < devices.length; i++) {
            const d = devices[i];
            const hz = d.rate || d.native;
            const rateTxt = hz ? `${(hz / 1000).toFixed(hz % 1000 ? 1 : 0)} kHz` : '?';
            const opt = new Option(`${d.label} · ${rateTxt}${d.ok ? '' : ' — unsupported'}`, d.id);
            opt.disabled = !d.ok;
            if (!d.ok) opt.className = 'is-unsupported';
            sel.appendChild(opt);
        }
        const match = devices.find((d) => d.id === want && d.ok);
        const firstOk = devices.find((d) => d.ok);
        sel.value = match ? match.id : (firstOk ? firstOk.id : '');
        const chosen = devices.find((d) => d.id === sel.value);
        sel.classList.toggle('has-unsupported', !!(chosen && !chosen.ok));
    }

    function ensureSound() {
        if (sound) return sound;
        sound = new SoundcardSource({
            onRawIQ: processRawIQ,
            onReady: (info) => {
                if (source.protocol !== 'soundcard') return;
                applyIqRate(info.sampleRate);
                state.centerFreq = 0;
                waterfall.setCenterFreq(0, state.sampleRate);
                setTunedFrequency(state.tunedFreq, true, false);
                updateTopBarInfo();
                updateSourceStatus();
            },
            onStatusChange: (statusText, isConnected) => {
                if (source.protocol !== 'soundcard') return;
                setStatus(statusText, isConnected);
            },
            onDevices: fillSoundDeviceSelect
        });
        const swapEl = document.getElementById('sound-iq-swap');
        if (swapEl) sound.setSwap(swapEl.checked);
        return sound;
    }

    function isActiveConnected() {
        if (source.protocol === 'kiwi') return !!(kiwi && kiwi.connected);
        if (source.protocol === 'soundcard') return !!(sound && sound.connected);
        return conn.connected;
    }

    function connectActive() {
        if (source.protocol === 'kiwi') {
            const k = ensureKiwi();
            k.host = source.host;
            k.port = source.port;
            k.secure = !!source.secure;
            k.password = source.password || '';
            k.lowCut = source.iqLowCut;
            k.highCut = source.iqHighCut;
            k.startFreqHz = source.startFreq;
            k.ddcHz = state.centerFreq;
            k.connect();
        } else if (source.protocol === 'soundcard') {
            const s = ensureSound();
            const sel = document.getElementById('sound-device');
            const id = (sel && sel.value) || s.deviceId;
            if (!id) {
                s.enable().then((ok) => {
                    if (!ok || source.protocol !== 'soundcard' || !state.running) return;
                    const sel2 = document.getElementById('sound-device');
                    if (sel2 && sel2.value) s.start(sel2.value);
                });
                return;
            }
            s.start(id);
        } else {
            conn.connect();
        }
    }

    function disconnectTransports() {
        if (kiwi) kiwi.disconnect();
        if (sound) sound.stop();
        conn.disconnect();
    }

    // Connect Waterfall click/drag/wheel tuning to ValueDial and DSP
    waterfall.onTuneCallback = (newFreq) => {
        setTunedFrequency(newFreq, true);
    };
    waterfall.onBandwidthCallback = (direction) => {
        if (state.modulation === 'cw') {
            const el = document.getElementById('cw-bw-slider');
            if (!el) return;
            const next = Math.max(50, Math.min(350, state.cwBandwidth + direction * 10));
            if (next === state.cwBandwidth) return;
            el.value = String(next);
            el.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            const el = document.getElementById('ssb-high-slider');
            if (!el) return;
            const next = state.ssbHigh + direction * 10;
            el.value = String(next);
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }
    };
    waterfall.onPanCallback = (deltaHz) => {
        if (source.protocol !== 'kiwi') {
            waterfall.panOffset += deltaHz;
            waterfall.clampPan();
            waterfall.refreshChrome();
            return;
        }
        state.centerFreq = Math.round(state.centerFreq + deltaHz);
        const half = state.sampleRate / 2;
        const maxOff = Math.max(0, half - 50);
        if (state.tunedFreq > state.centerFreq + maxOff) state.tunedFreq = Math.round(state.centerFreq + maxOff);
        if (state.tunedFreq < state.centerFreq - maxOff) state.tunedFreq = Math.round(state.centerFreq - maxOff);
        waterfall.panOffset = 0;
        waterfall.setCenterFreq(state.centerFreq, state.sampleRate);
        if (kiwi) kiwi.tune(state.centerFreq);
        setTunedFrequency(state.tunedFreq, true, true);
        updateTopBarInfo();
        updateSourceStatus();
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

        if (source.protocol === 'kiwi') {
            const half = state.sampleRate / 2;
            if (Math.abs(state.tunedFreq - state.centerFreq) > half - 50) {
                state.centerFreq = state.tunedFreq;
                waterfall.panOffset = 0;
                waterfall.setCenterFreq(state.centerFreq, state.sampleRate);
                if (kiwi) kiwi.tune(state.centerFreq);
                updateTopBarInfo();
                updateSourceStatus();
            }
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
        cwDecoder.reset();
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
            if (source.protocol === 'didah') conn.setDemodParams(params);
        });
    }

    function setModulation(mod) {
        state.modulation = mod.toLowerCase();
        const cw = state.modulation === 'cw';
        const cwSec = document.getElementById('cw-config-section');
        const ssbSec = document.getElementById('ssb-config-section');
        if (cwSec) cwSec.classList.toggle('is-dimmed', !cw);
        if (ssbSec) ssbSec.classList.toggle('is-dimmed', cw);

        document.querySelectorAll('.mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === state.modulation);
        });

        setTunedFrequency(state.tunedFreq, false, false);
        smeter.setModeInfo(state.modulation, state.cwBandwidth);
        updateDecoderActive();
        if (!cw) {
            keyer.armed = false;
            keyer.stopText = true;
            keyer.abort();
            wasTransmitting = false;
            waterfall.setShowPassband(true);
        }
        updateTxUi();
        updateTrxLeds();
    }

    function formatCenter(hz) {
        if (Math.abs(hz) < 1000000) return `${hz} Hz`;
        return `${(hz / 1000000).toFixed(4)} MHz`;
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
        const proto = source.protocol === 'kiwi' ? 'KiwiSDR SND IQ'
            : source.protocol === 'soundcard' ? 'Sound card IQ'
            : 'didah 0x03 IQ';
        const khz = state.sampleRate / 1000;
        const srTxt = `${Number.isInteger(khz) ? khz : khz.toFixed(2)} kHz`;
        const cf = formatCenter(state.centerFreq);
        let extra = '';
        if (source.protocol === 'kiwi') {
            extra = ` ${source.host}:${source.port}. Waterfall is a 12 kHz zoom; mouse and wheel move the Kiwi DDC.`;
        } else if (source.protocol === 'soundcard') {
            extra = ' Centre is 0 Hz (offset). Swap I/Q if the spectrum is reversed.';
        }
        el.textContent = `${proto} · ${srTxt} · CF ${cf}.${extra}`;
    }

    function applyKiwiEndpointFromInput() {
        const urlEl = document.getElementById('kiwi-url');
        const parsed = normalizeKiwiUrl(urlEl ? urlEl.value : '');
        if (!parsed.ok) {
            if (urlEl) {
                urlEl.classList.add('invalid');
                urlEl.title = parsed.error;
            }
            return false;
        }
        if (urlEl) {
            urlEl.classList.remove('invalid');
            urlEl.title = parsed.href;
            urlEl.value = parsed.href;
        }
        const kiwiSrc = findSource('f4kiy');
        kiwiSrc.host = parsed.host;
        kiwiSrc.port = parsed.port;
        kiwiSrc.secure = parsed.secure;
        return true;
    }

    /** Apply the URL box and open (or reopen) the Kiwi SND socket. */
    function connectKiwiFromInput() {
        if (!applyKiwiEndpointFromInput()) {
            setStatus('Invalid KiwiSDR URL', false);
            return;
        }
        const radio = document.querySelector('input[name="iq-source"][value="f4kiy"]');
        if (radio && !radio.checked) {
            radio.checked = true;
            selectSource('f4kiy', true);
            return;
        }
        updateSourceStatus();
        if (!state.running) return;
        const kiwiSrc = findSource('f4kiy');
        setStatus(`Connecting to ${kiwiSrc.host}:${kiwiSrc.port}…`, false);
        connectActive();
    }

    function applySourcePresets(src) {
        const minEl = document.getElementById('min-lvl-slider');
        const dynEl = document.getElementById('dyn-range-slider');
        const fftEl = document.getElementById('fft-select');
        if (minEl) {
            minEl.value = String(src.minLevel);
            minEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (dynEl) {
            dynEl.value = String(src.dynamicRange);
            dynEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (fftEl && fftEl.value !== String(src.fftSize)) {
            fftEl.value = String(src.fftSize);
            fftEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    function selectSource(id, fromUser) {
        const src = findSource(id);
        const switching = src.id !== source.id;
        source = src;
        state.selectedSourceId = src.id;
        document.querySelectorAll('input[name="iq-source"]').forEach((el) => {
            el.checked = el.value === src.id;
        });
        if (src.protocol === 'kiwi') applyKiwiEndpointFromInput();
        if (fromUser) applySourcePresets(src);
        if (!switching) {
            updateSourceStatus();
            return;
        }
        disconnectTransports();
        resetIqPipeline();
        lastDspControl = '';
        state.userHasTuned = false;
        state.tunedFreq = src.startFreq;
        if (src.protocol === 'kiwi') {
            state.centerFreq = src.startFreq;
            applyIqRate(12000);
            if (kiwi) kiwi.ddcHz = src.startFreq;
        } else if (src.protocol === 'soundcard') {
            state.centerFreq = 0;
            applyIqRate((sound && sound.sampleRate) || 96000);
        } else {
            state.centerFreq = 14048000;
            applyIqRate(96000);
        }
        valueDial.setValue(state.tunedFreq, false);
        setModulation(src.startMod);
        state.userHasTuned = false;
        updateTopBarInfo();
        updateSourceStatus();
        if (!state.running) return;
        if (src.protocol === 'kiwi') {
            const urlEl = document.getElementById('kiwi-url');
            if (urlEl && urlEl.classList.contains('invalid')) {
                setStatus('Invalid KiwiSDR URL', false);
                return;
            }
        }
        connectActive();
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
        if (rxBtn) rxBtn.classList.toggle('active', state.running && isActiveConnected());
        if (state.running) {
            audioPlayer.resume();
            if (!isActiveConnected()) {
                connectActive();
            }
        } else {
            keyer.abort();
            keyer.stopText = true;
            wasTransmitting = false;
            waterfall.setShowPassband(true);
            audioPlayer.stop();
            smeter.reset();
            if (source.protocol === 'soundcard' && sound) sound.stop();
            updateTrxLeds();
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

    // 4. Config floating window (waterfall / CW / SSB), same behaviour as the S-Meter window
    setupFloatingWindow({
        windowId: 'wconfig-window', headerId: 'wconfig-header', closeBtnId: 'wconfig-close-btn',
        toggleBtnId: 'wconfig-btn', storageKey: 'didah_wconfig', defaultVisible: false,
        defaultPos: { top: '58px', left: 'auto', right: '20px' }
    });

    setupFloatingWindow({
        windowId: 'source-window', headerId: 'source-header', closeBtnId: 'source-close-btn',
        toggleBtnId: 'source-btn', storageKey: 'didah_source', defaultVisible: false,
        defaultPos: { top: '58px', left: '20px', right: 'auto' }
    });

    // CW decoder window: the decoder only runs while it is visible
    setupFloatingWindow({
        windowId: 'decoder-window', headerId: 'decoder-header', closeBtnId: 'decoder-close-btn',
        toggleBtnId: 'decoder-btn', storageKey: 'didah_decoder', defaultVisible: false,
        defaultPos: { top: '400px', left: '20px', right: 'auto' },
        onVisibilityChange: (visible) => { decoderWindowVisible = visible; updateDecoderActive(); }
    });
    const decoderClearBtn = document.getElementById('decoder-clear-btn');
    if (decoderClearBtn) decoderClearBtn.addEventListener('click', () => cwDecoder.clear());

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
        qrssAcc = new Float32Array(state.fftSize);
        resetQrssAcc();
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

    function applySsbSliders() {
        const lowEl = document.getElementById('ssb-low-slider');
        const highEl = document.getElementById('ssb-high-slider');
        const pb = setSsbPassband(lowEl ? lowEl.value : state.ssbLow, highEl ? highEl.value : state.ssbHigh);
        state.ssbLow = pb.low;
        state.ssbHigh = pb.high;
        if (lowEl) lowEl.value = String(pb.low);
        if (highEl) highEl.value = String(pb.high);
        const lowVal = document.getElementById('ssb-low-val');
        const highVal = document.getElementById('ssb-high-val');
        if (lowVal) lowVal.textContent = `${pb.low} Hz`;
        if (highVal) highVal.textContent = `${pb.high} Hz`;
        if (state.modulation !== 'cw') setTunedFrequency(state.tunedFreq, false, false);
        smeter.setModeInfo(state.modulation, state.cwBandwidth);
    }

    const ssbLowSlider = document.getElementById('ssb-low-slider');
    const ssbHighSlider = document.getElementById('ssb-high-slider');
    if (ssbLowSlider) ssbLowSlider.addEventListener('input', applySsbSliders);
    if (ssbHighSlider) ssbHighSlider.addEventListener('input', applySsbSliders);

    // 9. AGC Speed Selector (Fast, Medium, Slow)
    const agcSelect = document.getElementById('agc-select');
    if (agcSelect) {
        agcSelect.addEventListener('change', (e) => {
            state.agcSpeed = e.target.value;
            demodulator.setAgcSpeed(state.agcSpeed);
        });
    }

    // 10. CW Adaptive Filter, QRSS, and Click Filter
    const cwFilterToggle = document.getElementById('cw-filter-toggle');
    cwFilterToggle.addEventListener('click', () => {
        state.filterEnabled = !state.filterEnabled;
        cwFilter.enabled = state.filterEnabled;
        cwFilterToggle.classList.toggle('active', state.filterEnabled);
        cwFilterToggle.textContent = state.filterEnabled ? 'CW Filter: ON' : 'CW Filter: OFF';
    });

    function setQrssEnabled(on) {
        state.qrssEnabled = !!on;
        clientFft.initWindow(state.qrssEnabled ? 'blackman' : 'flattop');
        resetQrssAcc();
        const btn = document.getElementById('qrss-toggle');
        if (btn) {
            btn.classList.toggle('active', state.qrssEnabled);
            btn.textContent = state.qrssEnabled ? 'QRSS: ON' : 'QRSS: OFF';
        }
    }

    const qrssToggle = document.getElementById('qrss-toggle');
    if (qrssToggle) {
        qrssToggle.addEventListener('click', () => setQrssEnabled(!state.qrssEnabled));
    }

    const kernelSelect = document.getElementById('kernel-select');
    if (kernelSelect) {
        kernelSelect.addEventListener('change', (e) => {
            state.filterKernel = e.target.value;
            cwFilter.setKernel(state.filterKernel);
        });
    }

    function updateTxUi() {
        const cw = state.modulation === 'cw';
        const armBtn = document.getElementById('tx-arm-btn');
        const txText = document.getElementById('tx-text');
        const wpmSlider = document.getElementById('wpm-slider');
        const txRow = document.getElementById('tx-row');
        if (armBtn) {
            armBtn.disabled = !cw;
            armBtn.classList.toggle('armed', cw && keyer.armed);
        }
        if (txText) txText.disabled = !cw;
        if (wpmSlider) wpmSlider.disabled = !cw;
        if (txRow) txRow.classList.toggle('is-dimmed', !cw);
    }

    function setTxArmed(on) {
        const cw = state.modulation === 'cw';
        keyer.armed = cw && !!on;
        keyer.stopText = !keyer.armed;
        updateTxUi();
    }

    const txArmBtn = document.getElementById('tx-arm-btn');
    if (txArmBtn) {
        txArmBtn.addEventListener('click', () => {
            if (state.modulation !== 'cw') return;
            setTxArmed(!keyer.armed);
        });
    }

    const txTextInput = document.getElementById('tx-text');
    if (txTextInput) {
        const applyTxSanitize = () => {
            const caret = txTextInput.selectionStart | 0;
            const before = txTextInput.value.slice(0, caret);
            const cleaned = sanitizeTxText(txTextInput.value);
            if (cleaned === txTextInput.value) return;
            txTextInput.value = cleaned;
            const pos = sanitizeTxText(before).length;
            txTextInput.selectionStart = txTextInput.selectionEnd = pos;
        };
        applyTxSanitize();
        txTextInput.addEventListener('input', applyTxSanitize);
    }

    const wpmSlider = document.getElementById('wpm-slider');
    const wpmVal = document.getElementById('wpm-val');
    if (wpmSlider) {
        wpmSlider.addEventListener('input', (e) => {
            state.wpm = parseInt(e.target.value, 10);
            keyer.setWpm(state.wpm);
            if (wpmVal) wpmVal.textContent = String(state.wpm);
        });
    }

    document.querySelectorAll('input[name="iambic-mode"]').forEach((el) => {
        el.addEventListener('change', () => {
            if (!el.checked) return;
            state.iambicMode = el.value === 'A' ? 'A' : 'B';
            keyer.setIambicMode(state.iambicMode);
        });
    });

    updateTxUi();

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
    const PADDLE_KEYS = { F8: 'dit', F9: 'dah', F4: 'straight' };

    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeHelp();
            return;
        }

        const paddle = PADDLE_KEYS[e.key];
        if (paddle) {
            e.preventDefault();
            if (e.repeat) return;
            if (state.modulation !== 'cw') return;
            if (paddle === 'straight') keyer.setStraight(true);
            else keyer.setPaddle(paddle, true);
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

    window.addEventListener('keyup', (e) => {
        const paddle = PADDLE_KEYS[e.key];
        if (!paddle) return;
        e.preventDefault();
        if (paddle === 'straight') keyer.setStraight(false);
        else keyer.setPaddle(paddle, false);
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
        ['ssbLow', 'ssb-low-slider', 'input'],
        ['ssbHigh', 'ssb-high-slider', 'input'],
        ['stepSize', 'step-select', 'change'],
        ['fftSize', 'fft-select', 'change'],
        ['primaryTheme', 'theme-select', 'change'],
        ['agcSpeed', 'agc-select', 'change'],
        ['filterKernel', 'kernel-select', 'change'],
        ['wpm', 'wpm-slider', 'input'],
    ];

    function saveSettings() {
        const out = {};
        for (const [key] of SETTINGS) out[key] = state[key];
        out.filterEnabled = state.filterEnabled;
        out.qrssEnabled = state.qrssEnabled;
        out.iambicMode = state.iambicMode;
        out.selectedSourceId = state.selectedSourceId;
        const kiwiUrlEl = document.getElementById('kiwi-url');
        if (kiwiUrlEl) out.kiwiUrl = kiwiUrlEl.value;
        const soundDev = document.getElementById('sound-device');
        if (soundDev && soundDev.value) out.soundDeviceId = soundDev.value;
        const swapEl = document.getElementById('sound-iq-swap');
        if (swapEl) out.iqSwap = !!swapEl.checked;
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
        if (saved.qrssEnabled !== undefined && saved.qrssEnabled !== state.qrssEnabled) setQrssEnabled(!!saved.qrssEnabled);
        if (saved.iambicMode === 'A' || saved.iambicMode === 'B') {
            const el = document.querySelector(`input[name="iambic-mode"][value="${saved.iambicMode}"]`);
            if (el) {
                el.checked = true;
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }
        if (saved.selectedSourceId) {
            const el = document.querySelector(`input[name="iq-source"][value="${saved.selectedSourceId}"]`);
            if (el) el.checked = true;
        }
        if (saved.kiwiUrl) {
            const el = document.getElementById('kiwi-url');
            if (el) el.value = saved.kiwiUrl;
        }
        if (saved.soundDeviceId) {
            const el = document.getElementById('sound-device');
            if (el) {
                const opt = new Option('Saved device', saved.soundDeviceId);
                el.appendChild(opt);
                el.value = saved.soundDeviceId;
            }
        }
        if (saved.iqSwap) {
            const el = document.getElementById('sound-iq-swap');
            if (el) el.checked = true;
        }
    }

    // Any control change in the bottom panel or the Config window schedules a save
    let saveTimer = null;
    const scheduleSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveSettings, 250); };
    for (const id of ['bottom-panel', 'wconfig-window', 'source-window']) {
        const root = document.getElementById(id);
        if (!root) continue;
        root.addEventListener('input', scheduleSave);
        root.addEventListener('change', scheduleSave);
        root.addEventListener('click', scheduleSave);
    }
    loadSettings();
    applyKiwiEndpointFromInput();

    document.querySelectorAll('input[name="iq-source"]').forEach((el) => {
        el.addEventListener('change', () => {
            if (el.checked) selectSource(el.value, true);
        });
    });

    const kiwiUrlEl = document.getElementById('kiwi-url');
    const kiwiConnectBtn = document.getElementById('kiwi-connect-btn');
    if (kiwiUrlEl) {
        kiwiUrlEl.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            connectKiwiFromInput();
            kiwiUrlEl.blur();
        });
        const kiwiCard = kiwiUrlEl.closest('.source-option-kiwi');
        if (kiwiCard) {
            kiwiCard.addEventListener('click', (e) => {
                if (e.target === kiwiUrlEl || e.target === kiwiConnectBtn || (kiwiConnectBtn && kiwiConnectBtn.contains(e.target))) return;
                const radio = document.querySelector('input[name="iq-source"][value="f4kiy"]');
                if (radio && !radio.checked) {
                    radio.checked = true;
                    radio.dispatchEvent(new Event('change', { bubbles: true }));
                }
            });
        }
    }
    if (kiwiConnectBtn) {
        kiwiConnectBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            connectKiwiFromInput();
        });
    }

    const soundEnableBtn = document.getElementById('sound-enable-btn');
    const soundDeviceSel = document.getElementById('sound-device');
    const soundIqSwap = document.getElementById('sound-iq-swap');
    const soundCard = document.querySelector('.source-option-soundcard');
    if (soundCard) {
        soundCard.addEventListener('click', (e) => {
            if (e.target === soundEnableBtn || (soundEnableBtn && soundEnableBtn.contains(e.target))) return;
            if (e.target === soundDeviceSel || e.target === soundIqSwap) return;
            const radio = document.querySelector('input[name="iq-source"][value="soundcard"]');
            if (radio && !radio.checked) {
                radio.checked = true;
                radio.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });
    }
    if (soundEnableBtn) {
        soundEnableBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const radio = document.querySelector('input[name="iq-source"][value="soundcard"]');
            if (radio && !radio.checked) {
                radio.checked = true;
                radio.dispatchEvent(new Event('change', { bubbles: true }));
            }
            ensureSound().enable().then((ok) => {
                if (!ok || source.protocol !== 'soundcard' || !state.running) return;
                const sel = document.getElementById('sound-device');
                if (sel && sel.value) ensureSound().start(sel.value);
            });
        });
    }
    if (soundDeviceSel) {
        soundDeviceSel.addEventListener('change', () => {
            const opt = soundDeviceSel.selectedOptions[0];
            soundDeviceSel.classList.toggle('has-unsupported', !!(opt && opt.disabled));
            if (source.protocol !== 'soundcard' || !state.running) return;
            if (!soundDeviceSel.value) return;
            ensureSound().start(soundDeviceSel.value);
        });
    }
    if (soundIqSwap) {
        soundIqSwap.addEventListener('change', () => {
            ensureSound().setSwap(soundIqSwap.checked);
        });
    }

    const checked = document.querySelector('input[name="iq-source"]:checked');
    const startId = (checked && checked.value) || 'va2gka';
    if (startId !== source.id) selectSource(startId, false);
    else updateSourceStatus();

    updateTopBarInfo();
    if (state.running) connectActive();
});
