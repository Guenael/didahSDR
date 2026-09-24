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
        tunedFreq: 14050800,
        modulation: 'cw',
        cwBandwidth: 150,     // CW_BW_MIN..CW_BW_MAX (modes.js)
        cwOffset: 700,        // 400 to 1000 Hz dedicated tone offset (default 700 Hz)
        lowCut: -75,          // Symmetrical around carrier for CW
        highCut: 75,
        volume: 0.8,
        minLevel: -130,       // Default -130 dB (FFT levels are window-gain normalised)
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
        ic7300RadioHz: 0,
        ic7300Mode: null,
        ic7300Filter: 1,
        ic7300TrackRate: 0,
        ic7300Channels: 0,
        ssbLow: 200,
        ssbHigh: 2700,
        qrssEnabled: false,
        autonotchEnabled: false,
        autonotchDepth: 70,
        nrEnabled: false,
        nrStrength: 50,
        squelchEnabled: false,
        squelchMargin: 10,
        wpm: 20,
        iambicMode: 'B'
    };

    setSsbPassband(state.ssbLow, state.ssbHigh);

    let source = findSource(state.selectedSourceId);
    let kiwi = null;
    let sound = null;
    let ic7300 = null;
    let rtl = null;

    // CW waterfall filter: noise-floor IIR plus the click-sharpening kernel.
    const cwFilter = new CWAdaptiveFilter(state.fftSize);
    cwFilter.enabled = state.filterEnabled;
    cwFilter.setKernel(state.filterKernel);

    // 2. Initialize Fast Client-Side Radix-2 FFT Engine
    const clientFft = new DidahFFT(state.fftSize);
    clientFft.initWindow(state.filterEnabled ? 'flattop' : 'bh4');

    // 3. Initialize Client-Side Demodulator with AGC
    const demodulator = new DidahDemodulator(state.sampleRate);
    const qrss = new QrssSpectrum();
    qrss.setInputRate(demodulator.audioRate);

    // Neural CW decoder (worker + ONNX). Runs only while its window is open and the mode is CW.
    const cwDecoder = new CWDecoder(demodulator, {
        output: document.getElementById('decoder-output'),
        status: document.getElementById('decoder-status')
    });
    let decoderWindowVisible = false;
    function updateDecoderActive() {
        if (decoderWindowVisible && state.modulation === 'cw') cwDecoder.start(demodulator.audioRate);
        else cwDecoder.stop();
        updateRecUi();
    }

    // REC: dataset clip at the decoder tap (REC-BUTTON.md). Any decoder reset / stop ends the clip.
    const cwRecorder = new CWRecorder({ onStop: (clip) => { saveRecording(clip); updateRecUi(); } });
    cwDecoder.recorder = cwRecorder;
    const recBtn = document.getElementById('decoder-rec-btn');
    const recNoiseBtn = document.getElementById('decoder-noise-btn');
    let recNoise = false;
    let recTimer = null;
    let modelStamp = null;
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
    function toggleRec() {
        if (cwRecorder.recording) { cwRecorder.stop('user'); return; }
        if (!cwDecoder.active) return;
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
    demodulator.setAgcSpeed(state.agcSpeed);
    demodulator.setCwBandwidth(state.cwBandwidth);
    demodulator.setBfoPitch(state.cwOffset);
    demodulator.setAutonotchDepth(state.autonotchDepth);
    demodulator.setNrStrength(state.nrStrength);
    demodulator.setSquelchMarginDb(state.squelchMargin);

    const txPaddle = { dit: false, dah: false, straight: false, armed: false };
    let workletTx = false;
    let workletKeyed = false;
    let txTextGen = 0;

    // 4. Initialize Web Audio Player
    const audioPlayer = new WebAudioPlayer();
    audioPlayer.setVolume(state.volume);
    audioPlayer.setKeyerWpm(state.wpm);
    audioPlayer.setKeyerIambic(state.iambicMode);
    audioPlayer.setSidetoneHz(state.cwOffset);
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
            if (source.protocol === 'ic7300') {
                if (!tuneIc7300FromUser(newFreq)) {
                    valueDial.setValue(state.ic7300RadioHz > 0 ? state.ic7300RadioHz : state.tunedFreq, false);
                }
                return;
            }
            setTunedFrequency(newFreq, false);
        }
    });

    // 7. STFT Overlap Ring Buffer for Client-Side FFT
    const RING_SIZE = 32768;
    const ringReal = new Float32Array(RING_SIZE);
    const ringImag = new Float32Array(RING_SIZE);
    let ringHead = 0;
    let samplesAvailable = 0;

    function qrssPlan() {
        const speed = Math.max(1, Math.min(8, state.speedMultiplier | 0));
        const sizes = [8192, 8192, 4096, 4096, 2048, 2048, 1024, 1024];
        const out = qrss.outRate > 0 ? qrss.outRate : 375;
        return {
            fftSize: sizes[speed - 1],
            average: 9 - speed,
            hop: Math.max(1, Math.round(out / speed))
        };
    }

    let qrssPlanSpeed = -1;
    function applyQrssPlan() {
        const plan = qrssPlan();
        if (qrss.fftSize !== plan.fftSize) qrss.setFftSize(plan.fftSize);
        if (qrss.avgTarget !== plan.average) qrss.setAverage(plan.average);
        if (qrss.hop !== plan.hop) qrss.setHop(plan.hop);
        qrssPlanSpeed = state.speedMultiplier;
    }

    function resetQrssAcc() {
        qrss.reset();
    }

    // 7b. Initialize SNR-Meter (0 to 40+ dB above local noise floor)
    const smeter = new DidahSMeter();
    smeter.init();
    smeter.setModeInfo(state.modulation, state.cwBandwidth);
    let vfoMemories = null;

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
        if (rxBtn) rxBtn.classList.toggle('active', isConnected && state.running && !isLocalTx());
        updateTrxLeds();
    }

    function paddleDown() {
        return txPaddle.dit || txPaddle.dah || txPaddle.straight;
    }

    function releasePaddles() {
        txPaddle.dit = false;
        txPaddle.dah = false;
        txPaddle.straight = false;
        audioPlayer.setKeyerPaddle('dit', false);
        audioPlayer.setKeyerPaddle('dah', false);
        audioPlayer.setKeyerStraight(false);
        updateTrxLeds();
    }

    function isLocalTx() {
        return state.modulation === 'cw' && (paddleDown() || workletTx);
    }

    let trxLedKey = '';
    function updateTrxLeds() {
        const onAir = isLocalTx();
        const key = (state.running ? '1' : '0')
            + (isActiveConnected() ? '1' : '0')
            + (onAir ? '1' : '0')
            + (workletKeyed ? '1' : '0')
            + (paddleDown() ? '1' : '0');
        if (key === trxLedKey) return;
        trxLedKey = key;
        const rxBtn = document.getElementById('rx-btn');
        const txBtn = document.getElementById('tx-btn');
        if (rxBtn) rxBtn.classList.toggle('active', state.running && isActiveConnected() && !onAir);
        if (txBtn) txBtn.classList.toggle('active', workletKeyed || paddleDown());
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

    let civCwTimer = null;

    function syncKeyerText() {
        const el = document.getElementById('tx-text');
        const text = el ? el.value : '';
        const catCw = source.protocol === 'ic7300' && ic7300 && ic7300.cat.connected;
        const paddlesDown = txPaddle.dit || txPaddle.dah || txPaddle.straight;
        if (catCw && !paddlesDown) {
            audioPlayer.setKeyerText('', ++txTextGen);
            if (civCwTimer) clearTimeout(civCwTimer);
            civCwTimer = setTimeout(() => {
                civCwTimer = null;
                if (txPaddle.dit || txPaddle.dah || txPaddle.straight) return;
                if (ic7300) ic7300.sendCw(text);
            }, 400);
            return;
        }
        if (civCwTimer) {
            clearTimeout(civCwTimer);
            civCwTimer = null;
        }
        txTextGen++;
        audioPlayer.setKeyerText(text, txTextGen);
    }

    function applyKeyerConsumed(consumed, gen) {
        if (!consumed || (gen | 0) !== txTextGen) return;
        const el = document.getElementById('tx-text');
        if (!el) return;
        if (el.value.startsWith(consumed)) {
            const start = el.selectionStart | 0;
            const end = el.selectionEnd | 0;
            el.value = el.value.slice(consumed.length);
            el.selectionStart = Math.max(0, start - consumed.length);
            el.selectionEnd = Math.max(0, end - consumed.length);
        }
    }

    audioPlayer.onKeyerState = (m) => {
        workletTx = !!m.tx;
        workletKeyed = !!m.keyed;
        if (m.consumed) applyKeyerConsumed(m.consumed, m.gen);
        if (m.wantChar) {
            const ch = consumeTxChar();
            if (ch != null) audioPlayer.sendKeyerChar(ch);
            else {
                const el = document.getElementById('tx-text');
                audioPlayer.setKeyerHasText(!!(el && el.value.length));
            }
        }
        syncIc7300Key();
        updateTrxLeds();
    };

    let wasTransmitting = false;
    function processRawIQ(iq, nComplex) {
        if (!state.running) return;

        const useTx = isLocalTx();

        if (useTx !== wasTransmitting) {
            ringHead = 0;
            samplesAvailable = 0;
            resetQrssAcc();
            audioPlayer.resetBuffer();
            if (useTx) cwDecoder.reset();
            updateTrxLeds();
        }
        wasTransmitting = useTx;

        if (useTx) return;

        const numComplex = nComplex == null ? (iq.length >> 1) : nComplex | 0;
        const audio = demodulator.process(iq, numComplex);
        cwRecorder.pushAudio(audio);
        audioPlayer.pushFloatAudio(audio);

        for (let i = 0; i < numComplex; i++) {
            ringReal[ringHead] = iq[i * 2];
            ringImag[ringHead] = iq[i * 2 + 1];
            ringHead = ringHead === RING_SIZE - 1 ? 0 : ringHead + 1;
        }
        samplesAvailable = capRingAvailable(samplesAvailable + numComplex, RING_SIZE);

        // Column rate stays a true time axis: WF Speed is still the STFT hop, and a
        // cap keeps 192 kHz from asking for hundreds of WebGL uploads per second.
        // A hidden tab skips the FFT; the ring index stays capped so it cannot go negative.
        if (typeof document !== 'undefined' && document.hidden) return;
        consumeSpectrumSlices();
    }

    const MAX_SPECTRUM_COLS = 200;

    function spectrumHopSize() {
        const speed = Math.max(1, state.speedMultiplier);
        const bySpeed = Math.floor(state.fftSize / speed);
        const byCap = Math.ceil(state.sampleRate / MAX_SPECTRUM_COLS);
        return Math.max(1, bySpeed, byCap);
    }

    function paintSpectrum(specDb, mag2, sampleRate, centerFreq, hopSamples) {
        const shown = state.filterEnabled ? cwFilter.process(specDb) : specDb;
        waterfall.addSlice(shown);
        smeter.updateFromSpectrum(
            mag2, sampleRate, centerFreq, state.tunedFreq, state.modulation, state.cwBandwidth,
            clientFft.enbw, hopSamples
        );
    }

    /** Wideband waterfall. QRSS draws from its own decimator and does not use this ring. */
    function consumeSpectrumSlices() {
        if (state.qrssEnabled) {
            const hop = spectrumHopSize();
            if (samplesAvailable > hop * 8) samplesAvailable = hop * 8;
            return;
        }
        const hopSize = spectrumHopSize();
        const n = state.fftSize;
        while (samplesAvailable >= n) {
            const start = (ringHead - samplesAvailable + RING_SIZE) % RING_SIZE;
            const specDb = clientFft.computeSpectrumFromRing(ringReal, ringImag, RING_SIZE, start, true);
            paintSpectrum(specDb, clientFft.mag2Buffer, state.sampleRate, state.centerFreq, hopSize);
            samplesAvailable -= hopSize;
        }
    }

    function onQrssSample(i, q) {
        if (qrssPlanSpeed !== state.speedMultiplier) applyQrssPlan();
        const spec = qrss.push(i, q);
        if (!spec || !state.qrssEnabled) return;
        const shown = state.filterEnabled ? cwFilter.process(spec) : spec;
        waterfall.addSlice(shown);
        smeter.updateFromSpectrum(
            qrss.fft.mag2Buffer, qrss.outRate, state.tunedFreq, state.tunedFreq,
            state.modulation, state.cwBandwidth, qrss.fft.enbw, qrss.hop
        );
    }

    function resetIqPipeline() {
        ringHead = 0;
        samplesAvailable = 0;
        audioPlayer.resetBuffer();
        waterfall.clear();
        smeter.reset();
        resetQrssAcc();
    }

    function activeOwner() {
        if (source.protocol === 'kiwi') return kiwi;
        if (source.protocol === 'soundcard') return sound;
        if (source.protocol === 'ic7300') return ic7300;
        if (source.protocol === 'rtlsdr') return rtl;
        return conn;
    }

    function applyDialRange() {
        if (source.protocol === 'ic7300' && state.ic7300RadioHz > 0) {
            valueDial.setRange(0, 999999999);
        } else if (source.protocol === 'soundcard' || source.protocol === 'ic7300') {
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
        if (state.qrssEnabled) applyQrssView();
        else if (rate < 30000) waterfall.zoomMin();
        else if (waterfall.zoom <= 1.01) waterfall.setZoom(2.67);
    }

    /** QRSS replaces the wideband waterfall with a few hundred hertz around the dial. */
    function applyQrssView() {
        qrss.setInputRate(demodulator.audioRate);
        applyQrssPlan();
        waterfall.zoom = 1;
        waterfall.panOffset = 0;
        waterfall.setCenterFreq(state.tunedFreq, qrss.outRate || 375);
        waterfall.setTunedFreq(state.tunedFreq, state.lowCut, state.highCut, state.modulation);
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
            waterfall.zoom = 1;
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
        const dialHz = source.protocol === 'ic7300' && state.ic7300RadioHz > 0
            ? state.ic7300RadioHz
            : state.tunedFreq;
        valueDial.setValue(dialHz, false);
        updateTopBarInfo();
        updateSourceStatus();
        return true;
    }

    /** Centre the waterfall on the frequency the source actually tuned to. */
    function applyCenter(hz) {
        if (!shiftCenter(hz)) return;
        resetIqPipeline();
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
        },
        onRawIQ: (iq, n) => {
            if (!acceptIq(source.protocol, 'didah', conn.connected, null, null)) return;
            processRawIQ(iq, n);
        }
    });

    function ensureKiwi() {
        if (kiwi) return kiwi;
        kiwi = new KiwiConnection({
            onRawIQ: (iq, n) => {
                if (!kiwi || !acceptIq(source.protocol, 'kiwi', kiwi.connected, null, null)) return;
                processRawIQ(iq, n);
            },
            onCenterApplied: (hz) => {
                if (source.protocol === 'kiwi') applyCenter(hz);
            },
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
        fillDeviceSelect(sel, devices, sel && (sel.value || (sound && sound.deviceId)) || '');
    }

    function ensureSound() {
        if (sound) return sound;
        sound = new SoundcardSource({
            onRawIQ: (iq, n) => {
                if (!sound || !acceptIq(source.protocol, 'soundcard', sound.connected, sound._gen, sound._feedGen)) return;
                processRawIQ(iq, n);
            },
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

    function fillIc7300DeviceSelect(devices) {
        const sel = document.getElementById('ic7300-device');
        const want = sel && (sel.value || (ic7300 && ic7300.deviceId)) || '';
        fillDeviceSelect(sel, devices, want, (d) => /pcm2901/i.test(d.label));
    }

    function syncIc7300Key() {
        if (!ic7300) return;
        const live = source.protocol === 'ic7300'
            && state.modulation === 'cw'
            && txPaddle.armed
            && document.visibilityState !== 'hidden';
        const wiring = document.getElementById('ic7300-wiring');
        ic7300.setWiring(wiring && wiring.value === 'ptt-dtr' ? 'ptt-dtr' : 'ptt-rts');
        ic7300.setLines(live && workletKeyed, live && workletTx);
    }

    let ic7300FreqTimer = null;
    let ic7300FreqSent = 0;
    let ic7300FreqHoldUntil = 0;
    let ic7300ModeHold = null;
    let ic7300ModeHoldUntil = 0;

    function ic7300Passband() {
        if (state.modulation !== 'usb' && state.modulation !== 'lsb') return null;
        const m = MODES[state.modulation];
        return m ? { low: m.low, high: m.high } : null;
    }

    function scheduleIc7300Frequency(hz) {
        ic7300FreqSent = hz;
        ic7300FreqHoldUntil = Date.now() + 600;
        if (ic7300FreqTimer) return;
        ic7300FreqTimer = setTimeout(() => {
            ic7300FreqTimer = null;
            if (ic7300) ic7300.setFrequency(ic7300FreqSent);
        }, 90);
    }

    /** Write the IC-7300 VFO. The cursor stays on the IF; only the radio and the dial move. */
    function tuneIc7300FromUser(radioHz) {
        if (source.protocol !== 'ic7300') return false;
        if (!(state.ic7300RadioHz > 0) || !ic7300 || !ic7300.cat.connected) return false;
        const hz = Math.max(1000, Math.min(74800000, Math.round(radioHz)));
        if (hz === state.ic7300RadioHz) return true;
        state.ic7300RadioHz = hz;
        applyIc7300Tuning();
        scheduleIc7300Frequency(hz);
        return true;
    }

    function selectIc7300Mode(mod) {
        const byte = didahToCivMode(mod);
        if (byte == null) return;
        if (byte === state.ic7300Mode && state.modulation === mod) return;
        state.ic7300Mode = byte;
        ic7300ModeHold = byte;
        ic7300ModeHoldUntil = Date.now() + 600;
        applyIc7300Tuning();
        if (ic7300 && ic7300.cat.connected) ic7300.setMode(byte, state.ic7300Filter || 1);
    }

    function applyIc7300View() {
        waterfall.viewLock = true;
        valueDial.locked = !(state.ic7300RadioHz > 0);
        const view = ic7300View(state.ic7300Mode, state.sampleRate, ic7300Passband());
        const cap = waterfall.maxZoom > 0 ? waterfall.maxZoom : 24;
        waterfall.setZoom(Math.max(1, Math.min(cap, state.sampleRate / view.span)));
        waterfall.panOffset = view.audioCenter;
        waterfall.clampPan();
        waterfall.refreshChrome();
        if (state.ic7300RadioHz > 0) valueDial.setValue(state.ic7300RadioHz, false);
    }

    function releaseIc7300View() {
        waterfall.viewLock = false;
        valueDial.locked = false;
        waterfall.panOffset = 0;
        waterfall.setZoom(2.67);
    }

    /** Follow a CI-V report. Audio offset stays put; only the ruler and dial move. */
    function applyIc7300Tuning() {
        if (source.protocol !== 'ic7300') return;
        const g = ic7300Geometry(state.ic7300RadioHz, state.ic7300Mode, state.sampleRate);
        const offset = g.tunedFreq - g.centerFreq;
        const prevOffset = state.tunedFreq - state.centerFreq;
        const modSame = state.modulation === g.modulation;
        state.centerFreq = g.centerFreq;
        state.tunedFreq = g.tunedFreq;
        applyDialRange();
        if (!modSame) {
            setModulation(g.modulation);
        } else if (offset !== prevOffset) {
            setTunedFrequency(g.tunedFreq, true, false);
        } else {
            waterfall.setCenterFreq(g.centerFreq, state.sampleRate);
            waterfall.setTunedFreq(g.tunedFreq, state.lowCut, state.highCut, state.modulation);
        }
        applyIc7300View();
        updateTopBarInfo();
        updateSourceStatus();
        if (vfoMemories) vfoMemories.syncDial(currentDialHz());
    }

    function ensureIc7300() {
        if (ic7300) return ic7300;
        ic7300 = new Ic7300Source({
            onRawIQ: (iq, n) => {
                if (!ic7300 || !acceptIq(source.protocol, 'ic7300', ic7300.connected, ic7300._gen, ic7300._feedGen)) return;
                processRawIQ(iq, n);
            },
            onReady: (info) => {
                state.ic7300TrackRate = info.trackRate || 0;
                state.ic7300Channels = info.channels || 0;
                if (source.protocol !== 'ic7300') return;
                applyIqRate(info.sampleRate);
                applyIc7300Tuning();
                updateTopBarInfo();
                updateSourceStatus();
            },
            onStatusChange: (statusText) => {
                const btn = document.getElementById('ic7300-serial-btn');
                if (btn && ic7300) btn.textContent = ic7300.cat.connected ? 'Disconnect' : 'Connect';
                if (source.protocol !== 'ic7300') return;
                setStatus(statusText, !!(ic7300 && ic7300.connected));
                updateSourceStatus();
            },
            onDevices: fillIc7300DeviceSelect,
            onFrequency: (hz) => {
                if (Date.now() < ic7300FreqHoldUntil && hz !== ic7300FreqSent) return;
                if (hz === ic7300FreqSent) ic7300FreqHoldUntil = 0;
                if (hz === state.ic7300RadioHz) return;
                state.ic7300RadioHz = hz;
                applyIc7300Tuning();
            },
            onMode: (mode, filter) => {
                if (filter) state.ic7300Filter = filter;
                if (Date.now() < ic7300ModeHoldUntil && mode !== ic7300ModeHold) return;
                if (mode === ic7300ModeHold) ic7300ModeHoldUntil = 0;
                if (mode === state.ic7300Mode) return;
                state.ic7300Mode = mode;
                applyIc7300Tuning();
            }
        });
        const baudEl = document.getElementById('ic7300-baud');
        if (baudEl) ic7300.cat.baud = parseInt(baudEl.value, 10) || CIV_BAUD_DEFAULT;
        return ic7300;
    }

    function applyRtlControls(rig) {
        const modeEl = document.getElementById('rtlsdr-mode');
        const gainEl = document.getElementById('rtlsdr-gain');
        const ppmEl = document.getElementById('rtlsdr-ppm');
        const upEl = document.getElementById('rtlsdr-upconverter');
        const biasEl = document.getElementById('rtlsdr-bias');
        if (modeEl) rig.setMode(modeEl.value);
        if (gainEl) rig.setGainDb(gainEl.value === 'auto' ? null : Number(gainEl.value));
        if (ppmEl) rig.setPpm(ppmEl.value);
        if (upEl) rig.setUpconverterHz(upEl.value);
        if (biasEl) rig.setBiasTee(biasEl.checked);
    }

    function ensureRtl() {
        if (rtl) return rtl;
        rtl = new RtlSdrSource({
            onRawIQ: (iq, n) => {
                if (!rtl || !acceptIq(source.protocol, 'rtlsdr', rtl.connected, rtl._gen, rtl._feedGen)) return;
                processRawIQ(iq, n);
            },
            onCenterApplied: (hz) => {
                if (source.protocol === 'rtlsdr') applyCenter(hz);
            },
            onReady: (info) => {
                if (source.protocol !== 'rtlsdr') return;
                applyIqRate(info.sampleRate || RTL_IQ_RATE);
                if (info.centerFreq) state.centerFreq = info.centerFreq;
                waterfall.setCenterFreq(state.centerFreq, state.sampleRate);
                if (waterfall.zoom <= 1.01) waterfall.setZoom(2.67);
                setTunedFrequency(state.tunedFreq, true, false);
                updateTopBarInfo();
                updateSourceStatus();
            },
            onStatusChange: (statusText, isConnected) => {
                const btn = document.getElementById('rtlsdr-connect-btn');
                if (btn && rtl) btn.textContent = rtl.connected ? 'Disconnect' : 'Connect';
                if (source.protocol !== 'rtlsdr') return;
                setStatus(statusText, !!isConnected);
                updateSourceStatus();
            }
        });
        applyRtlControls(rtl);
        rtl.setDisplayHz(state.centerFreq || 14048000);
        return rtl;
    }

    function isActiveConnected() {
        const owner = activeOwner();
        return !!(owner && owner.connected);
    }

    function connectActive(allowUsbPicker) {
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
        } else if (source.protocol === 'ic7300') {
            const rig = ensureIc7300();
            const sel = document.getElementById('ic7300-device');
            const id = (sel && sel.value) || rig.deviceId;
            if (!id) {
                rig.enable().then((ok) => {
                    if (!ok || source.protocol !== 'ic7300' || !state.running) return;
                    const sel2 = document.getElementById('ic7300-device');
                    if (sel2 && sel2.value) rig.start(sel2.value);
                });
                return;
            }
            rig.start(id);
        } else if (source.protocol === 'rtlsdr') {
            const rig = ensureRtl();
            applyRtlControls(rig);
            rig.setDisplayHz(state.centerFreq);
            if (rig.connected || allowUsbPicker) rig.start();
            else setStatus('Press Connect to open the RTL-SDR', false);
        } else {
            conn.connect();
        }
    }

    function disconnectTransports() {
        if (kiwi) kiwi.disconnect();
        if (sound) sound.stop();
        if (ic7300) ic7300.stop();
        if (rtl) rtl.close();
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
            const next = Math.max(CW_BW_MIN, Math.min(CW_BW_MAX, state.cwBandwidth + direction * 10));
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
        if (source.protocol === 'ic7300') {
            tuneIc7300FromUser(state.ic7300RadioHz + deltaHz);
            return;
        }
        if (source.protocol === 'kiwi' || source.protocol === 'rtlsdr') {
            const next = Math.round(state.centerFreq + deltaHz);
            shiftCenter(next);
            if (source.protocol === 'kiwi' && kiwi && kiwi.connected) kiwi.tune(state.centerFreq);
            else if (source.protocol === 'rtlsdr' && rtl && rtl.connected) rtl.setDisplayHz(state.centerFreq);
            return;
        }
        waterfall.panOffset += deltaHz;
        waterfall.clampPan();
        waterfall.refreshChrome();
    };

    /**
     * The one place demod / waterfall / server state is updated from a new VFO frequency.
     * @param {boolean} fromUser - false only for server-config or internal re-application
     */
    let tuneResetTimer = null;
    let pendingTuneHz = 0;      // net retune since the last decoder / NLMS reset
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
        }, 300);
    }

    function currentDialHz() {
        if (source.protocol === 'ic7300' && state.ic7300RadioHz > 0) return state.ic7300RadioHz;
        return state.tunedFreq;
    }

    function setTunedFrequency(freq, updateDial = true, fromUser = true) {
        if (fromUser && source.protocol === 'ic7300') return;
        const prevTuned = state.tunedFreq;
        const prevMod = demodulator.modulation;
        state.tunedFreq = Math.round(freq);
        if (fromUser) state.userHasTuned = true;
        if (updateDial) {
            const dialHz = source.protocol === 'ic7300' && state.ic7300RadioHz > 0
                ? state.ic7300RadioHz
                : state.tunedFreq;
            valueDial.setValue(dialHz, false);
        }

        if (source.protocol === 'kiwi' || source.protocol === 'rtlsdr') {
            const half = state.sampleRate / 2;
            if (Math.abs(state.tunedFreq - state.centerFreq) > half - 50) {
                shiftCenter(state.tunedFreq);
                if (source.protocol === 'kiwi' && kiwi && kiwi.connected) kiwi.tune(state.centerFreq);
                else if (source.protocol === 'rtlsdr' && rtl && rtl.connected) rtl.setDisplayHz(state.centerFreq);
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
        noteTuneReset(state.tunedFreq - prevTuned, state.modulation !== prevMod);
        if (state.qrssEnabled) {
            qrss.reset();
            waterfall.zoom = 1;
            waterfall.panOffset = 0;
            waterfall.setCenterFreq(state.tunedFreq, qrss.outRate || 375);
            waterfall.clear();
        }
        sendDspControl();
        if (vfoMemories) vfoMemories.syncDial(currentDialHz());
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
            txPaddle.armed = false;
            releasePaddles();
            audioPlayer.abortKeyer();
            workletTx = false;
            workletKeyed = false;
            wasTransmitting = false;
        }
        updateTxUi();
        syncIc7300Key();
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
            : source.protocol === 'ic7300' ? 'IC-7300 IF'
            : source.protocol === 'rtlsdr' ? 'RTL-SDR IQ'
            : 'didah 0x03 IQ';
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
            const serial = ic7300 ? ` ${ic7300.serialText}` : '';
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
        const kiwiSrc = findSource('oh5ae');
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
        const radio = document.querySelector('input[name="iq-source"][value="oh5ae"]');
        if (radio && !radio.checked) {
            radio.checked = true;
            selectSource('oh5ae', true);
            return;
        }
        updateSourceStatus();
        if (!state.running) return;
        const kiwiSrc = findSource('oh5ae');
        setStatus(`Connecting to ${kiwiSrc.host}:${kiwiSrc.port}…`, false);
        connectActive();
    }

    function applySourcePresets(src, force) {
        let seen;
        try { seen = JSON.parse(localStorage.getItem('didah_presets_seen') || '{}') || {}; } catch (e) { seen = {}; }
        if (src.id === 'oh5ae' && seen.f4kiy && !seen.oh5ae) seen.oh5ae = 1;
        if (!force && seen[src.id]) return;
        seen[src.id] = 1;
        try { localStorage.setItem('didah_presets_seen', JSON.stringify(seen)); } catch (e) { /* storage unavailable */ }
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
        const prevProtocol = source.protocol;
        const prevTuned = state.tunedFreq;
        const prevRadio = state.ic7300RadioHz;
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
        if (prevProtocol === 'ic7300') {
            releaseIc7300View();
            if (ic7300 && ic7300.cat.connected) ic7300.disconnectSerial();
        }
        syncIc7300Key();
        disconnectTransports();
        resetIqPipeline();
        lastDspControl = '';
        state.userHasTuned = false;
        const entryHz = src.protocol === 'kiwi'
            ? kiwiEntryFrequency({
                protocol: prevProtocol,
                tunedFreq: prevTuned,
                radioHz: prevRadio,
                fromUser: !!fromUser
            })
            : src.startFreq;
        state.tunedFreq = entryHz;
        if (src.protocol === 'kiwi') {
            state.centerFreq = entryHz;
            applyIqRate(12000);
            if (kiwi) kiwi.ddcHz = entryHz;
        } else if (src.protocol === 'soundcard') {
            state.centerFreq = 0;
            applyIqRate((sound && sound.sampleRate) || 96000);
        } else if (src.protocol === 'ic7300') {
            applyIqRate((ic7300 && ic7300.sampleRate) || 12000);
            applyIc7300Tuning();
        } else if (src.protocol === 'rtlsdr') {
            state.centerFreq = src.startFreq;
            applyIqRate(RTL_IQ_RATE);
            if (rtl) {
                applyRtlControls(rtl);
                rtl.setDisplayHz(state.centerFreq);
            }
        } else {
            state.centerFreq = 14048000;
            applyIqRate(96000);
        }
        if (src.protocol !== 'ic7300') {
            valueDial.setValue(state.tunedFreq, false);
            setModulation(src.startMod);
        }
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
        connectActive(fromUser);
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
                connectActive(true);
            } else if (source.protocol === 'rtlsdr' && rtl) {
                rtl.start();
            }
        } else {
            txPaddle.armed = false;
            audioPlayer.abortKeyer();
            workletTx = false;
            workletKeyed = false;
            wasTransmitting = false;
            audioPlayer.stop();
            smeter.reset();
            disconnectTransports();
            syncIc7300Key();
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
            if (source.protocol === 'ic7300') {
                selectIc7300Mode(btn.dataset.mode);
                return;
            }
            setModulation(btn.dataset.mode);
        });
    });

    // 4. Config floating window (waterfall / CW / SSB), same behaviour as the SNR-Meter window
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
    vfoMemories = setupVfoMemories({
        listId: 'vfo-mem-list',
        addBtnId: 'vfo-mem-add',
        defaultsBtnId: 'vfo-mem-defaults',
        dialId: 'vfo-mem-dial',
        getDialHz: currentDialHz,
        onRecall: (hz) => {
            if (source.protocol === 'ic7300') tuneIc7300FromUser(hz);
            else setTunedFrequency(hz, true, true);
        }
    });
    if (vfoMemories) vfoMemories.syncDial(currentDialHz());

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
    if (recBtn) recBtn.addEventListener('click', toggleRec);
    if (recNoiseBtn) recNoiseBtn.addEventListener('click', () => { recNoise = !recNoise; updateRecUi(); });
    updateRecUi();

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
            if (cwOffsetVal) cwOffsetVal.textContent = `${state.cwOffset} Hz`;
            audioPlayer.setSidetoneHz(state.cwOffset);
            setTunedFrequency(state.tunedFreq, false, false);
        });
    }

    const cwBwSlider = document.getElementById('cw-bw-slider');
    const cwBwVal = document.getElementById('cw-bw-val');
    if (cwBwSlider) {
        cwBwSlider.min = String(CW_BW_MIN);
        cwBwSlider.max = String(CW_BW_MAX);
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
        if (source.protocol === 'ic7300') applyIc7300View();
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

    // 10. CW waterfall filter and QRSS
    function applySpectrumWindow() {
        clientFft.initWindow(state.filterEnabled ? 'flattop' : 'bh4');
    }

    const cwFilterToggle = document.getElementById('cw-filter-toggle');
    cwFilterToggle.addEventListener('click', () => {
        state.filterEnabled = !state.filterEnabled;
        cwFilter.enabled = state.filterEnabled;
        applySpectrumWindow();
        cwFilterToggle.classList.toggle('active', state.filterEnabled);
        cwFilterToggle.textContent = state.filterEnabled ? 'CW Filter: ON' : 'CW Filter: OFF';
    });

    let qrssSavedView = null;
    function setQrssEnabled(on) {
        const next = !!on;
        if (next === state.qrssEnabled) return;
        state.qrssEnabled = next;
        if (next) {
            qrssSavedView = { zoom: waterfall.zoom, pan: waterfall.panOffset };
            demodulator.qrssPush = onQrssSample;
            qrss.reset();
            applyQrssView();
            waterfall.clear();
        } else {
            demodulator.qrssPush = null;
            qrss.reset();
            if (qrssSavedView) {
                waterfall.zoom = qrssSavedView.zoom;
                waterfall.panOffset = qrssSavedView.pan;
            }
            waterfall.setCenterFreq(state.centerFreq, state.sampleRate);
            waterfall.setTunedFreq(state.tunedFreq, state.lowCut, state.highCut, state.modulation);
            waterfall.clear();
            ringHead = 0;
            samplesAvailable = 0;
        }
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

    function setAutonotchEnabled(on) {
        state.autonotchEnabled = !!on;
        demodulator.setAutonotchEnabled(state.autonotchEnabled);
        const btn = document.getElementById('autonotch-toggle');
        if (btn) {
            btn.classList.toggle('active', state.autonotchEnabled);
            btn.textContent = state.autonotchEnabled ? 'Autonotch: ON' : 'Autonotch: OFF';
        }
    }

    function setNrEnabled(on) {
        state.nrEnabled = !!on;
        demodulator.setNrEnabled(state.nrEnabled);
        const btn = document.getElementById('nr-toggle');
        if (btn) {
            btn.classList.toggle('active', state.nrEnabled);
            btn.textContent = state.nrEnabled ? 'Noise Reduction: ON' : 'Noise Reduction: OFF';
        }
    }

    function setSquelchEnabled(on) {
        state.squelchEnabled = !!on;
        demodulator.setSquelchEnabled(state.squelchEnabled);
        const btn = document.getElementById('squelch-toggle');
        if (btn) {
            btn.classList.toggle('active', state.squelchEnabled);
            btn.textContent = state.squelchEnabled ? 'Squelch: ON' : 'Squelch: OFF';
        }
    }

    const autonotchToggle = document.getElementById('autonotch-toggle');
    if (autonotchToggle) {
        autonotchToggle.addEventListener('click', () => setAutonotchEnabled(!state.autonotchEnabled));
    }
    const nrToggle = document.getElementById('nr-toggle');
    if (nrToggle) {
        nrToggle.addEventListener('click', () => setNrEnabled(!state.nrEnabled));
    }
    const squelchToggle = document.getElementById('squelch-toggle');
    if (squelchToggle) {
        squelchToggle.addEventListener('click', () => setSquelchEnabled(!state.squelchEnabled));
    }

    const autonotchDepthSlider = document.getElementById('autonotch-depth-slider');
    const autonotchDepthVal = document.getElementById('autonotch-depth-val');
    if (autonotchDepthSlider) {
        autonotchDepthSlider.addEventListener('input', (e) => {
            state.autonotchDepth = parseInt(e.target.value, 10);
            if (autonotchDepthVal) autonotchDepthVal.textContent = `${state.autonotchDepth}%`;
            demodulator.setAutonotchDepth(state.autonotchDepth);
        });
    }

    const nrStrengthSlider = document.getElementById('nr-strength-slider');
    const nrStrengthVal = document.getElementById('nr-strength-val');
    if (nrStrengthSlider) {
        nrStrengthSlider.addEventListener('input', (e) => {
            state.nrStrength = parseInt(e.target.value, 10);
            if (nrStrengthVal) nrStrengthVal.textContent = `${state.nrStrength}%`;
            demodulator.setNrStrength(state.nrStrength);
        });
    }

    const squelchThrSlider = document.getElementById('squelch-thr-slider');
    const squelchThrVal = document.getElementById('squelch-thr-val');
    if (squelchThrSlider) {
        squelchThrSlider.addEventListener('input', (e) => {
            state.squelchMargin = parseInt(e.target.value, 10);
            if (squelchThrVal) squelchThrVal.textContent = `${state.squelchMargin} dB`;
            demodulator.setSquelchMarginDb(state.squelchMargin);
        });
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
            const armed = cw && txPaddle.armed;
            armBtn.classList.toggle('armed', armed);
            armBtn.textContent = armed ? 'PTT On' : 'PTT Off';
        }
        if (txText) txText.disabled = !cw;
        if (wpmSlider) wpmSlider.disabled = !cw;
        if (txRow) txRow.classList.toggle('is-dimmed', !cw);
    }

    function setTxArmed(on) {
        const cw = state.modulation === 'cw';
        txPaddle.armed = cw && !!on;
        audioPlayer.setKeyerArmed(txPaddle.armed);
        if (txPaddle.armed) syncKeyerText();
        else {
            audioPlayer.setKeyerHasText(false);
            releasePaddles();
        }
        syncIc7300Key();
        updateTxUi();
    }

    const txArmBtn = document.getElementById('tx-arm-btn');
    if (txArmBtn) {
        txArmBtn.addEventListener('click', () => {
            if (state.modulation !== 'cw') return;
            setTxArmed(!txPaddle.armed);
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
        txTextInput.addEventListener('input', () => {
            applyTxSanitize();
            if (txPaddle.armed) syncKeyerText();
        });
    }

    const wpmSlider = document.getElementById('wpm-slider');
    const wpmVal = document.getElementById('wpm-val');
    if (wpmSlider) {
        wpmSlider.addEventListener('input', (e) => {
            state.wpm = parseInt(e.target.value, 10);
            audioPlayer.setKeyerWpm(state.wpm);
            if (ic7300 && ic7300.cat.connected) ic7300.setCwSpeed(state.wpm);
            if (wpmVal) wpmVal.textContent = String(state.wpm);
        });
    }

    document.querySelectorAll('input[name="iambic-mode"]').forEach((el) => {
        el.addEventListener('change', () => {
            if (!el.checked) return;
            state.iambicMode = el.value === 'A' ? 'A' : 'B';
            audioPlayer.setKeyerIambic(state.iambicMode);
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

        if (e.key === 'Enter') {
            const tag = e.target && e.target.tagName;
            const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
            const inCwText = e.target && e.target.id === 'tx-text';
            if (inField && !inCwText) return;
            if (state.modulation !== 'cw') return;
            e.preventDefault();
            setTxArmed(!txPaddle.armed);
            return;
        }

        const paddle = PADDLE_KEYS[e.key];
        if (paddle) {
            e.preventDefault();
            if (e.repeat) return;
            if (state.modulation !== 'cw' || !txPaddle.armed) return;
            audioPlayer.resume();
            if (paddle === 'straight') {
                txPaddle.straight = true;
                audioPlayer.setKeyerStraight(true);
            } else if (paddle === 'dit') {
                txPaddle.dit = true;
                audioPlayer.setKeyerPaddle('dit', true);
            } else {
                txPaddle.dah = true;
                audioPlayer.setKeyerPaddle('dah', true);
            }
            updateTrxLeds();
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
            if (source.protocol === 'ic7300') selectIc7300Mode(nextMode);
            else setModulation(nextMode);
        } else if (source.protocol === 'ic7300' && (
            e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End'
        )) {
            if (!inDial) e.preventDefault();
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
            if (source.protocol === 'ic7300') tuneIc7300FromUser(state.ic7300RadioHz + state.stepSize);
            else setTunedFrequency(state.tunedFreq + state.stepSize);
        } else if (e.key === 'ArrowDown' && !inDial) {
            e.preventDefault();
            if (source.protocol === 'ic7300') tuneIc7300FromUser(state.ic7300RadioHz - state.stepSize);
            else setTunedFrequency(state.tunedFreq - state.stepSize);
        }
    });

    window.addEventListener('keyup', (e) => {
        const paddle = PADDLE_KEYS[e.key];
        if (!paddle) return;
        e.preventDefault();
        if (paddle === 'straight') {
            txPaddle.straight = false;
            audioPlayer.setKeyerStraight(false);
        } else if (paddle === 'dit') {
            txPaddle.dit = false;
            audioPlayer.setKeyerPaddle('dit', false);
        } else {
            txPaddle.dah = false;
            audioPlayer.setKeyerPaddle('dah', false);
        }
        updateTrxLeds();
    });

    // Losing focus (alt-tab, a dialog, another window) means the paddle keyup never arrives.
    // Drop the paddles and disarm, so a real radio is never left keyed.
    function releaseTxOnFocusLoss() {
        if (!paddleDown() && !txPaddle.armed) return;
        releasePaddles();
        if (txPaddle.armed) setTxArmed(false);
        if (ic7300) ic7300.releaseKey();
    }
    window.addEventListener('blur', releaseTxOnFocusLoss);

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
        ['autonotchDepth', 'autonotch-depth-slider', 'input'],
        ['nrStrength', 'nr-strength-slider', 'input'],
        ['squelchMargin', 'squelch-thr-slider', 'input'],
    ];

    function saveSettings() {
        const out = {};
        for (const [key] of SETTINGS) out[key] = state[key];
        out.filterEnabled = state.filterEnabled;
        out.qrssEnabled = state.qrssEnabled;
        out.autonotchEnabled = state.autonotchEnabled;
        out.nrEnabled = state.nrEnabled;
        out.squelchEnabled = state.squelchEnabled;
        out.iambicMode = state.iambicMode;
        out.selectedSourceId = state.selectedSourceId;
        const kiwiUrlEl = document.getElementById('kiwi-url');
        if (kiwiUrlEl) out.kiwiUrl = kiwiUrlEl.value;
        const soundDev = document.getElementById('sound-device');
        if (soundDev && soundDev.value) out.soundDeviceId = soundDev.value;
        const swapEl = document.getElementById('sound-iq-swap');
        if (swapEl) out.iqSwap = !!swapEl.checked;
        const icDev = document.getElementById('ic7300-device');
        if (icDev && icDev.value) out.ic7300DeviceId = icDev.value;
        const icBaud = document.getElementById('ic7300-baud');
        if (icBaud) out.ic7300Baud = icBaud.value;
        const icWiring = document.getElementById('ic7300-wiring');
        if (icWiring) out.ic7300Wiring = icWiring.value;
        const rtlMode = document.getElementById('rtlsdr-mode');
        if (rtlMode) out.rtlMode = rtlMode.value;
        const rtlGain = document.getElementById('rtlsdr-gain');
        if (rtlGain) out.rtlGain = rtlGain.value;
        const rtlPpm = document.getElementById('rtlsdr-ppm');
        if (rtlPpm) out.rtlPpm = rtlPpm.value;
        const rtlUp = document.getElementById('rtlsdr-upconverter');
        if (rtlUp) out.rtlUpconverter = rtlUp.value;
        const rtlBias = document.getElementById('rtlsdr-bias');
        if (rtlBias) out.rtlBias = !!rtlBias.checked;
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
        if (saved.autonotchEnabled !== undefined && saved.autonotchEnabled !== state.autonotchEnabled) {
            setAutonotchEnabled(!!saved.autonotchEnabled);
        }
        if (saved.nrEnabled !== undefined && saved.nrEnabled !== state.nrEnabled) setNrEnabled(!!saved.nrEnabled);
        if (saved.squelchEnabled !== undefined && saved.squelchEnabled !== state.squelchEnabled) {
            setSquelchEnabled(!!saved.squelchEnabled);
        }
        if (saved.iambicMode === 'A' || saved.iambicMode === 'B') {
            const el = document.querySelector(`input[name="iambic-mode"][value="${saved.iambicMode}"]`);
            if (el) {
                el.checked = true;
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }
        if (saved.selectedSourceId) {
            const sourceId = saved.selectedSourceId === 'f4kiy' ? 'oh5ae' : saved.selectedSourceId;
            const el = document.querySelector(`input[name="iq-source"][value="${sourceId}"]`);
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
        if (saved.ic7300Baud) {
            const el = document.getElementById('ic7300-baud');
            if (el) el.value = String(saved.ic7300Baud);
        }
        if (saved.ic7300Wiring === 'ptt-dtr' || saved.ic7300Wiring === 'ptt-rts') {
            const el = document.getElementById('ic7300-wiring');
            if (el) el.value = saved.ic7300Wiring;
        }
        if (saved.ic7300DeviceId) {
            const el = document.getElementById('ic7300-device');
            if (el) {
                const opt = new Option('Saved device', saved.ic7300DeviceId);
                el.appendChild(opt);
                el.value = saved.ic7300DeviceId;
            }
        }
        if (saved.rtlMode) {
            const el = document.getElementById('rtlsdr-mode');
            if (el) el.value = saved.rtlMode;
        }
        if (saved.rtlGain != null) {
            const el = document.getElementById('rtlsdr-gain');
            if (el) el.value = String(saved.rtlGain);
        }
        if (saved.rtlPpm != null) {
            const el = document.getElementById('rtlsdr-ppm');
            if (el) el.value = String(saved.rtlPpm);
        }
        if (saved.rtlUpconverter != null) {
            const el = document.getElementById('rtlsdr-upconverter');
            if (el) el.value = String(saved.rtlUpconverter);
        }
        if (saved.rtlBias) {
            const el = document.getElementById('rtlsdr-bias');
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
                const radio = document.querySelector('input[name="iq-source"][value="oh5ae"]');
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

    const ic7300EnableBtn = document.getElementById('ic7300-enable-btn');
    const ic7300DeviceSel = document.getElementById('ic7300-device');
    const ic7300BaudSel = document.getElementById('ic7300-baud');
    const ic7300WiringSel = document.getElementById('ic7300-wiring');
    const ic7300SerialBtn = document.getElementById('ic7300-serial-btn');
    const ic7300Card = document.querySelector('.source-option-ic7300');
    if (ic7300Card) {
        ic7300Card.addEventListener('click', (e) => {
            if (e.target === ic7300EnableBtn || (ic7300EnableBtn && ic7300EnableBtn.contains(e.target))) return;
            if (e.target === ic7300SerialBtn || (ic7300SerialBtn && ic7300SerialBtn.contains(e.target))) return;
            if (e.target === ic7300DeviceSel || e.target === ic7300BaudSel || e.target === ic7300WiringSel) return;
            const radio = document.querySelector('input[name="iq-source"][value="ic7300"]');
            if (radio && !radio.checked) {
                radio.checked = true;
                radio.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });
    }
    if (ic7300EnableBtn) {
        ic7300EnableBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const radio = document.querySelector('input[name="iq-source"][value="ic7300"]');
            if (radio && !radio.checked) {
                radio.checked = true;
                radio.dispatchEvent(new Event('change', { bubbles: true }));
            }
            ensureIc7300().enable().then((ok) => {
                if (!ok || source.protocol !== 'ic7300' || !state.running) return;
                const sel = document.getElementById('ic7300-device');
                if (sel && sel.value) ensureIc7300().start(sel.value);
            });
        });
    }
    if (ic7300DeviceSel) {
        ic7300DeviceSel.addEventListener('change', () => {
            const opt = ic7300DeviceSel.selectedOptions[0];
            ic7300DeviceSel.classList.toggle('has-unsupported', !!(opt && opt.disabled));
            if (source.protocol !== 'ic7300' || !state.running) return;
            if (!ic7300DeviceSel.value) return;
            ensureIc7300().start(ic7300DeviceSel.value);
        });
    }
    if (ic7300BaudSel) {
        ic7300BaudSel.addEventListener('change', () => {
            ensureIc7300().setBaud(parseInt(ic7300BaudSel.value, 10));
        });
    }
    if (ic7300WiringSel) {
        ic7300WiringSel.addEventListener('change', () => {
            syncIc7300Key();
        });
    }
    if (ic7300SerialBtn) {
        ic7300SerialBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const rig = ensureIc7300();
            if (ic7300BaudSel) rig.cat.baud = parseInt(ic7300BaudSel.value, 10) || CIV_BAUD_DEFAULT;
            if (rig.cat.connected) {
                rig.disconnectSerial();
                return;
            }
            rig.connectSerial();
        });
    }

    const rtlConnectBtn = document.getElementById('rtlsdr-connect-btn');
    const rtlModeSel = document.getElementById('rtlsdr-mode');
    const rtlGainSel = document.getElementById('rtlsdr-gain');
    const rtlPpmInput = document.getElementById('rtlsdr-ppm');
    const rtlUpInput = document.getElementById('rtlsdr-upconverter');
    const rtlBiasInput = document.getElementById('rtlsdr-bias');
    const rtlCard = document.querySelector('.source-option-rtlsdr');
    if (rtlConnectBtn && typeof navigator !== 'undefined' && navigator.usb) {
        rtlConnectBtn.disabled = false;
        rtlConnectBtn.title = 'Open the RTL-SDR over WebUSB';
    }
    if (rtlCard) {
        rtlCard.addEventListener('click', (e) => {
            if (e.target === rtlConnectBtn || (rtlConnectBtn && rtlConnectBtn.contains(e.target))) return;
            if (e.target === rtlModeSel || e.target === rtlGainSel || e.target === rtlPpmInput
                || e.target === rtlUpInput || e.target === rtlBiasInput) return;
            const radio = document.querySelector('input[name="iq-source"][value="rtlsdr"]');
            if (radio && !radio.checked) {
                radio.checked = true;
                radio.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });
    }
    function pushRtlControls() {
        if (!rtl) return;
        applyRtlControls(rtl);
        if (source.protocol === 'rtlsdr') updateSourceStatus();
    }
    if (rtlConnectBtn) {
        rtlConnectBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const radio = document.querySelector('input[name="iq-source"][value="rtlsdr"]');
            const switching = radio && !radio.checked;
            if (switching) {
                radio.checked = true;
                radio.dispatchEvent(new Event('change', { bubbles: true }));
            }
            const rig = ensureRtl();
            applyRtlControls(rig);
            if (rig.connected) {
                rig.close();
                return;
            }
            if (switching && state.running) return;
            if (state.running) rig.start();
            else rig.prepare();
        });
    }
    if (rtlModeSel) rtlModeSel.addEventListener('change', pushRtlControls);
    if (rtlGainSel) rtlGainSel.addEventListener('change', pushRtlControls);
    if (rtlPpmInput) rtlPpmInput.addEventListener('change', pushRtlControls);
    if (rtlUpInput) rtlUpInput.addEventListener('change', pushRtlControls);
    if (rtlBiasInput) rtlBiasInput.addEventListener('change', pushRtlControls);

    document.addEventListener('visibilitychange', () => syncIc7300Key());
    window.addEventListener('pagehide', () => {
        releaseTxOnFocusLoss();
        if (ic7300) ic7300.releaseKey();
    });

    const checked = document.querySelector('input[name="iq-source"]:checked');
    const startId = (checked && checked.value) || 'va2gka';
    if (startId !== source.id) selectSource(startId, false);
    else updateSourceStatus();

    updateTopBarInfo();
    if (state.running) connectActive();
});
