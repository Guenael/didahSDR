/**
 * didahSDR - IQ fan-out: one packet feeds the audio demodulator and the spectrum/waterfall.
 *
 * `processRawIQ` is the hot path (see CLAUDE.md): demodulate, push audio, copy into the STFT ring,
 * then paint as many waterfall columns as the hop allows. QRSS replaces the wideband columns with
 * its own ~375 Hz decimated FFT, fed from the demodulator's pre-channel-filter tap.
 *
 * DOM-free, so Node tests can drive it. `ctx` needs: state, demodulator, audioPlayer, cwRecorder,
 * cwDecoder, clientFft, cwFilter, waterfall, smeter, qrss, and the functions isLocalTx(),
 * updateTrxLeds(); `ctx.isHidden()` (a hidden tab skips the FFT) is optional.
 * No allocations per packet.
 */

const SPECTRUM_RING_SIZE = 32768;
/** Column-rate cap, so 192 kHz does not ask for hundreds of WebGL uploads per second. */
const MAX_SPECTRUM_COLS = 200;

function createSpectrumPipeline(ctx) {
    const { state, demodulator, audioPlayer, cwRecorder, cwDecoder, clientFft, cwFilter, waterfall, smeter, qrss } = ctx;
    const isHidden = ctx.isHidden || (() => typeof document !== 'undefined' && document.hidden);
    const RING_SIZE = SPECTRUM_RING_SIZE;
    const ringReal = new Float32Array(RING_SIZE);
    const ringImag = new Float32Array(RING_SIZE);
    let ringHead = 0;
    let samplesAvailable = 0;
    let wasTransmitting = false;
    let qrssPlanSpeed = -1;
    let qrssSavedView = null;

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

    function applyQrssPlan() {
        const plan = qrssPlan();
        if (qrss.fftSize !== plan.fftSize) qrss.setFftSize(plan.fftSize);
        if (qrss.avgTarget !== plan.average) qrss.setAverage(plan.average);
        if (qrss.hop !== plan.hop) qrss.setHop(plan.hop);
        qrssPlanSpeed = state.speedMultiplier;
    }

    function resetRing() {
        ringHead = 0;
        samplesAvailable = 0;
    }

    function processRawIQ(iq, nComplex) {
        if (!state.running) return;

        const useTx = ctx.isLocalTx();

        if (useTx !== wasTransmitting) {
            resetRing();
            qrss.reset();
            audioPlayer.resetBuffer();
            if (useTx) cwDecoder.reset();
            ctx.updateTrxLeds();
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
        if (isHidden()) return;
        consumeSpectrumSlices();
    }

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

    /** Drop everything buffered for display and audio (new source, rate or centre). */
    function resetIqPipeline() {
        resetRing();
        audioPlayer.resetBuffer();
        waterfall.clear();
        smeter.reset();
        qrss.reset();
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
            resetRing();
        }
    }

    /** A new FFT size invalidates the ring position and the QRSS accumulation. */
    function onFftSizeChanged() {
        qrss.reset();
        samplesAvailable = 0;
    }

    /** TX ended outside the IQ path (mode change, power off): the next packet is plain RX. */
    function forgetTx() {
        wasTransmitting = false;
    }

    return {
        processRawIQ, resetIqPipeline, applyQrssView, setQrssEnabled, onFftSizeChanged, forgetTx,
        spectrumHopSize,
        /** For tests: complex samples waiting in the STFT ring. */
        get samplesAvailable() { return samplesAvailable; }
    };
}

if (typeof globalThis !== 'undefined') globalThis.createSpectrumPipeline = createSpectrumPipeline;
if (typeof module !== 'undefined') module.exports = { createSpectrumPipeline, SPECTRUM_RING_SIZE, MAX_SPECTRUM_COLS };
