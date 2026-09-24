/**
 * didahSDR - composition root.
 *
 * Builds the DSP / display / audio objects and one shared `ctx`, then installs the controllers
 * (each a plain-script factory that adds its functions to `ctx`; cross-module calls go through
 * `ctx` at call time, so creation order does not matter):
 *   spectrum_pipeline.js  IQ fan-out: demodulator + STFT ring + waterfall + QRSS (the hot path)
 *   tuning.js             VFO, centre, mode, IQ rate; waterfall tune/pan callbacks; status text
 *   source_manager.js     the five IQ sources, switching, Source-window controls
 *   ic7300_controller.js  following / writing the IC-7300 VFO over CI-V
 *   tx_controller.js      paddles, PTT, typeahead, IC-7300 key lines
 *   ui_bindings.js        panels, decoder window, REC, help, keyboard
 *   prefs_store.js     localStorage persistence of the operator settings
 */

document.addEventListener('DOMContentLoaded', () => {
    const state = {
        running: true,
        centerFreq: 14048000,
        sampleRate: 96000,
        tunedFreq: 14050800,
        modulation: 'cw',
        cwBandwidth: 150,     // CW_BW_MIN..CW_BW_MAX (modes.js)
        cwOffset: 700,        // CW pitch, 400 to 1000 Hz
        lowCut: -75,          // passband edges relative to the tuned frequency (CW: ±bandwidth/2)
        highCut: 75,
        volume: 0.8,
        minLevel: -130,       // dB (FFT levels are window-gain normalised: full scale = 0 dBFS)
        dynamicRange: 60,     // dB
        primaryTheme: 'viridis',
        stepSize: 100,
        speedMultiplier: 3,
        fftSize: 2048,
        filterEnabled: true,
        filterKernel: 'medium',
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

    // Waterfall: CW noise-floor filter + click-sharpening kernel, and the client FFT
    const cwFilter = new CWAdaptiveFilter(state.fftSize);
    cwFilter.enabled = state.filterEnabled;
    cwFilter.setKernel(state.filterKernel);
    const clientFft = new DidahFFT(state.fftSize);
    clientFft.initWindow(state.filterEnabled ? 'flattop' : 'bh4');

    // Audio chain: demodulator (with AGC and audio FX), QRSS decimator, CW decoder, REC
    const demodulator = new DidahDemodulator(state.sampleRate);
    const qrss = new QrssSpectrum();
    qrss.setInputRate(demodulator.audioRate);
    const cwDecoder = new CWDecoder(demodulator, {
        output: document.getElementById('decoder-output'),
        status: document.getElementById('decoder-status')
    });
    const cwRecorder = new CWRecorder();   // onStop is set by ui_bindings.js
    cwDecoder.recorder = cwRecorder;
    demodulator.setAgcSpeed(state.agcSpeed);
    demodulator.setCwBandwidth(state.cwBandwidth);
    demodulator.setBfoPitch(state.cwOffset);
    demodulator.setAutonotchDepth(state.autonotchDepth);
    demodulator.setNrStrength(state.nrStrength);
    demodulator.setSquelchMarginDb(state.squelchMargin);

    const audioPlayer = new WebAudioPlayer();
    audioPlayer.setVolume(state.volume);
    audioPlayer.setKeyerWpm(state.wpm);
    audioPlayer.setKeyerIambic(state.iambicMode);
    audioPlayer.setSidetoneHz(state.cwOffset);
    audioPlayer.extraStats = () => {
        const agc = demodulator.agc;
        return { noiseFloor: agc.noiseFloor.toExponential(1), gain: agc.gNext.toFixed(1), fft: state.fftSize, speed: state.speedMultiplier };
    };

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

    const ctx = {
        state, cwFilter, clientFft, demodulator, qrss, cwDecoder, cwRecorder, audioPlayer, waterfall,
        source: findSource(state.selectedSourceId),
        transports: {},
        vfoMemories: null
    };

    // The drum dial tunes the VFO, or the radio's VFO for the IC-7300.
    ctx.valueDial = new SDRValueDial(document.getElementById('freq-dial-container'), {
        value: state.tunedFreq,
        unit: 'Hz',
        onChange: (newFreq) => {
            if (ctx.source.protocol === 'ic7300') {
                if (!ctx.tuneIc7300FromUser(newFreq)) {
                    ctx.valueDial.setValue(state.ic7300RadioHz > 0 ? state.ic7300RadioHz : state.tunedFreq, false);
                }
                return;
            }
            ctx.setTunedFrequency(newFreq, false);
        }
    });

    ctx.smeter = new DidahSMeter();
    ctx.smeter.init();
    ctx.smeter.setModeInfo(state.modulation, state.cwBandwidth);

    ctx.pipeline = createSpectrumPipeline(ctx);
    const tx = createTxController(ctx);
    createIc7300Controller(ctx);
    ctx.sources = createSourceManager(ctx);
    createTuning(ctx);

    bindUi(ctx);
    tx.bind();
    setupSettingsPersistence(ctx, ['bottom-panel', 'wconfig-window', 'source-window']);
    ctx.applyKiwiEndpointFromInput();
    ctx.sources.bindSourceControls();

    const checked = document.querySelector('input[name="iq-source"]:checked');
    const startId = (checked && checked.value) || 'va2gka';
    if (startId !== ctx.source.id) ctx.selectSource(startId, false);
    else ctx.updateSourceStatus();

    ctx.updateTopBarInfo();
    if (state.running) ctx.connectActive();
});
