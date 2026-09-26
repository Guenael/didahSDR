'use strict';
/**
 * Loads the browser DSP modules into Node in the same order as app/index.html, exposing the
 * globals the modules expect (they are plain <script> globals in the browser).
 * Run the suite with: node --test tests/js/*.test.js
 */
const path = require('path');
const fs = require('fs');

const JS = path.resolve(__dirname, '../../app/js');
const req = (name) => require(path.join(JS, name));

const wsRe = req('ws_reconnect.js');
global.clearReconnectTimer = wsRe.clearReconnectTimer;
global.armReconnect = wsRe.armReconnect;

const { MODES, WATERFALL_DB_FLOOR, setSsbPassband } = req('modes.js');
global.MODES = MODES;
global.WATERFALL_DB_FLOOR = WATERFALL_DB_FLOOR;
global.setSsbPassband = setSsbPassband;
global.CW_BW_MIN = req('modes.js').CW_BW_MIN;
global.CW_BW_MAX = req('modes.js').CW_BW_MAX;
global.Colormaps = req('colormaps.js');
global.CWAdaptiveFilter = req('cw_filter.js');
global.DidahFFT = req('fft.js');
global.DidahSMeter = req('smeter.js');
global.AGC = req('agc.js');
const fx = req('audio_fx.js');
global.DidahAutoNotch = fx.DidahAutoNotch;
global.DidahNoiseReduction = fx.DidahNoiseReduction;
global.DidahSquelch = fx.DidahSquelch;
const demod = req('demodulator.js');
global.DidahDemodulator = demod.DidahDemodulator;
global.designLowpass = demod.designLowpass;
const cwfe = req('cw_frontend.js');
global.CWFrontend = cwfe.CWFrontend;
global.ctcGreedy = cwfe.ctcGreedy;
const cwKeyer = req('cw_keyer.js');
global.CwKeyer = cwKeyer.CwKeyer;
global.MORSE_TABLE = cwKeyer.MORSE_TABLE;
global.morseOf = cwKeyer.morseOf;
global.sanitizeTxText = cwKeyer.sanitizeTxText;

const SAMPLE_WAV = path.resolve(__dirname, '../../samples/SAMPLE_20120219_174346Z_14048kHz_RF.wav');

/** Reads a 16-bit stereo IQ WAV: returns { rate, data: Int16Array interleaved I/Q } or null if absent. */
function loadSampleWav(maxSeconds = 12) {
    if (!fs.existsSync(SAMPLE_WAV)) return null;
    const fd = fs.openSync(SAMPLE_WAV, 'r');
    const header = Buffer.alloc(64);
    fs.readSync(fd, header, 0, 64, 0);
    const rate = header.readUInt32LE(24);
    // Locate the 'data' chunk (skip fmt and any LIST chunks)
    let pos = 12, dataPos = -1;
    const chunk = Buffer.alloc(8);
    while (pos < 1024) {
        fs.readSync(fd, chunk, 0, 8, pos);
        const id = chunk.toString('ascii', 0, 4), size = chunk.readUInt32LE(4);
        if (id === 'data') { dataPos = pos + 8; break; }
        pos += 8 + size;
    }
    if (dataPos < 0) { fs.closeSync(fd); return null; }
    const bytes = maxSeconds * rate * 4;
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, dataPos);
    fs.closeSync(fd);
    return { rate, data: new Int16Array(buf.buffer, buf.byteOffset, n >> 1) };
}

/** Complex tone generator: interleaved Int16 I/Q at `amp` (0..1) full scale. */
function iqTone(freqHz, rate, numSamples, amp = 0.5, phase0 = 0) {
    const out = new Int16Array(numSamples * 2);
    const w = (2 * Math.PI * freqHz) / rate;
    for (let n = 0; n < numSamples; n++) {
        out[2 * n] = Math.round(amp * 32767 * Math.cos(w * n + phase0));
        out[2 * n + 1] = Math.round(amp * 32767 * Math.sin(w * n + phase0));
    }
    return out;
}

/** Int16 interleaved IQ → Float32 ±1, the pipeline input contract. */
function floatIq(int16) {
    const out = new Float32Array(int16.length);
    const s = 1 / 32768;
    for (let i = 0; i < int16.length; i++) out[i] = int16[i] * s;
    return out;
}

/** Peak-bin frequency and level (dB) of a real audio block via the project FFT. */
function audioPeak(samples, rate, fftSize = 8192) {
    const fft = new DidahFFT(fftSize);
    const re = new Float32Array(fftSize), im = new Float32Array(fftSize);
    re.set(samples.subarray(samples.length - fftSize));
    const spec = fft.computeSpectrumDb(re, im);
    let pk = -Infinity, pi = 0;
    for (let i = fftSize / 2; i < fftSize; i++) if (spec[i] > pk) { pk = spec[i]; pi = i; }   // positive freqs only
    return { freq: ((pi - fftSize / 2) * rate) / fftSize, db: pk, spec };
}

const peakAbs = (a) => { let p = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > p) p = v; } return p; };

module.exports = { req, loadSampleWav, iqTone, floatIq, audioPeak, peakAbs, SAMPLE_WAV };
