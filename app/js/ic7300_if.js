/**
 * didahSDR - IC-7300 real 12 kHz IF
 *
 * The USB codec delivers a real IF, not SoftRock I/Q. A fixed Hilbert FIR builds
 * the analytic signal the rest of the pipeline already demodulates. Landmarks are
 * in hertz of a true 48 kHz capture. 96/192 kHz (Firefox upsample) keep the same
 * hertz; any other context rate is treated as a relabelled 48 kHz stream.
 */

const IC7300_NATIVE_RATE = 48000;
const IC7300_IF_HZ = 12000;
const IC7300_CW_TRACE_HZ = 11350;
const IC7300_CW_PITCH_HZ = IC7300_IF_HZ - IC7300_CW_TRACE_HZ;
const IC7300_VIEW_SPAN_HZ = 2500;
const IC7300_SSB_SPAN_HZ = 4000;
const IC7300_HILBERT_TAPS = 63;

/**
 * CI-V operating-mode byte → didah mode.
 * CW filter sits on the trace; USB/LSB sit on the 12 kHz carrier.
 * Unsupported modes stay on CW so the trace is still audible, and keep their label.
 */
function mapCivMode(modeByte) {
    switch (modeByte) {
        case 0x00: return { mod: 'lsb', label: 'LSB', supported: true, trace: 'carrier' };
        case 0x01: return { mod: 'usb', label: 'USB', supported: true, trace: 'carrier' };
        case 0x03: return { mod: 'cw', label: 'CW', supported: true, trace: 'cw' };
        case 0x07: return { mod: 'cw', label: 'CW-R', supported: true, trace: 'cwr' };
        case 0x02: return { mod: 'cw', label: 'AM', supported: false, trace: 'cw' };
        case 0x04: return { mod: 'cw', label: 'RTTY', supported: false, trace: 'cw' };
        case 0x05: return { mod: 'cw', label: 'FM', supported: false, trace: 'cw' };
        case 0x08: return { mod: 'cw', label: 'RTTY-R', supported: false, trace: 'cw' };
        default:
            if (modeByte == null) return { mod: 'cw', label: 'CW', supported: true, trace: 'cw' };
            return { mod: 'cw', label: 'Mode ' + modeByte.toString(16), supported: false, trace: 'cw' };
    }
}

/**
 * 1 when the context rate is a pitch-preserving upsample of the 48 kHz codec
 * (48/96/192). Otherwise rate/48000, so a 44.1 kHz context still lands on the tone.
 */
function ic7300IfScale(contextRate) {
    const rate = Math.round(Number(contextRate) || IC7300_NATIVE_RATE);
    if (rate === 48000 || rate === 96000 || rate === 192000) return 1;
    return rate / IC7300_NATIVE_RATE;
}

/**
 * Waterfall centre, cursor, and didah mode for one radio report.
 * `radioHz` 0 (or omitted) leaves the axis in audio hertz, cursor on the trace.
 */
function ic7300Geometry(radioHz, modeByte, contextRate) {
    const scale = ic7300IfScale(contextRate);
    const ifHz = IC7300_IF_HZ * scale;
    const pitch = IC7300_CW_PITCH_HZ * scale;
    const mapped = mapCivMode(modeByte);
    let audioOffset = ifHz - pitch;
    if (mapped.trace === 'cwr') audioOffset = ifHz + pitch;
    else if (mapped.trace === 'carrier') audioOffset = ifHz;
    const have = typeof radioHz === 'number' && radioHz > 0;
    const centerFreq = have ? Math.round(radioHz - ifHz) : 0;
    const tunedFreq = have ? Math.round(radioHz - ifHz + audioOffset) : Math.round(audioOffset);
    return {
        centerFreq,
        tunedFreq,
        audioOffset: Math.round(audioOffset),
        modulation: mapped.mod,
        label: mapped.label,
        supported: mapped.supported,
        ifHz: Math.round(ifHz)
    };
}

/** didah mode name → CI-V mode byte. CW is the normal (LSB-side) mode. */
function didahToCivMode(mod) {
    if (mod === 'lsb') return 0x00;
    if (mod === 'usb') return 0x01;
    if (mod === 'cw') return 0x03;
    return null;
}

/**
 * Locked waterfall window. CW stays on the 11.350 kHz trace (~2.5 kHz).
 * USB/LSB open to 4 kHz centred on the passband so the sideband fits.
 */
function ic7300View(modeByte, contextRate, passband) {
    const scale = ic7300IfScale(contextRate);
    const mapped = mapCivMode(modeByte);
    const ifHz = IC7300_IF_HZ * scale;
    const pitch = IC7300_CW_PITCH_HZ * scale;
    let span = IC7300_VIEW_SPAN_HZ;
    let audioCenter = ifHz - pitch;
    if (mapped.trace === 'cwr') audioCenter = ifHz + pitch;
    if (mapped.mod === 'usb' || mapped.mod === 'lsb') {
        span = IC7300_SSB_SPAN_HZ;
        const low = passband && passband.low != null ? passband.low : (mapped.mod === 'lsb' ? -2700 : 200);
        const high = passband && passband.high != null ? passband.high : (mapped.mod === 'lsb' ? -200 : 2700);
        audioCenter = ifHz + ((low + high) / 2) * scale;
    }
    return { span, audioCenter: Math.round(audioCenter) };
}

function ic7300Zoom(sampleRate, maxZoom) {
    const cap = maxZoom > 0 ? maxZoom : 24;
    const z = (Number(sampleRate) || IC7300_NATIVE_RATE) / IC7300_VIEW_SPAN_HZ;
    return Math.max(1, Math.min(cap, z));
}

/** Odd-length Hamming-windowed Hilbert. Centre tap is 0; taps are antisymmetric. */
function designHilbert(taps) {
    let n = Math.round(Number(taps) || IC7300_HILBERT_TAPS);
    if (n < 5) n = 5;
    if ((n & 1) === 0) n += 1;
    const h = new Float32Array(n);
    const mid = (n - 1) >> 1;
    for (let i = 0; i < n; i++) {
        const k = i - mid;
        if (k !== 0 && (k & 1) !== 0) h[i] = (2 / Math.PI) / k;
    }
    const denom = n - 1;
    for (let i = 0; i < n; i++) {
        const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / denom);
        h[i] *= w;
    }
    return h;
}

/**
 * Real sample → analytic I/Q. Delay on I matches the FIR group delay.
 * No allocations after construction. `step` writes interleaved Int16 at `dst[2*fill]`.
 */
class RealIfConverter {
    constructor(taps) {
        this.h = taps || designHilbert(IC7300_HILBERT_TAPS);
        this.n = this.h.length;
        this.mid = (this.n - 1) >> 1;
        this.hist = new Float32Array(this.n);
        this.pos = 0;
    }

    step(x, dst, fill) {
        const n = this.n;
        const hist = this.hist;
        const h = this.h;
        let pos = this.pos;
        hist[pos] = x;
        let iIdx = pos - this.mid;
        if (iIdx < 0) iIdx += n;
        const iSamp = hist[iIdx];
        let q = 0;
        for (let k = 0; k < n; k++) {
            let idx = pos - k;
            if (idx < 0) idx += n;
            q += h[k] * hist[idx];
        }
        pos += 1;
        if (pos === n) pos = 0;
        this.pos = pos;
        let ii = iSamp * 32767;
        let qq = q * 32767;
        if (ii > 32767) ii = 32767;
        else if (ii < -32768) ii = -32768;
        if (qq > 32767) qq = 32767;
        else if (qq < -32768) qq = -32768;
        const o = fill * 2;
        dst[o] = ii;
        dst[o + 1] = qq;
    }
}

if (typeof globalThis !== 'undefined') {
    globalThis.IC7300_NATIVE_RATE = IC7300_NATIVE_RATE;
    globalThis.IC7300_IF_HZ = IC7300_IF_HZ;
    globalThis.IC7300_CW_TRACE_HZ = IC7300_CW_TRACE_HZ;
    globalThis.IC7300_CW_PITCH_HZ = IC7300_CW_PITCH_HZ;
    globalThis.IC7300_HILBERT_TAPS = IC7300_HILBERT_TAPS;
    globalThis.mapCivMode = mapCivMode;
    globalThis.ic7300IfScale = ic7300IfScale;
    globalThis.ic7300Geometry = ic7300Geometry;
    globalThis.ic7300View = ic7300View;
    globalThis.didahToCivMode = didahToCivMode;
    globalThis.ic7300Zoom = ic7300Zoom;
    globalThis.designHilbert = designHilbert;
    globalThis.RealIfConverter = RealIfConverter;
}
if (typeof module !== 'undefined') {
    module.exports = {
        IC7300_NATIVE_RATE, IC7300_IF_HZ, IC7300_CW_TRACE_HZ, IC7300_CW_PITCH_HZ,
        IC7300_VIEW_SPAN_HZ, IC7300_SSB_SPAN_HZ, IC7300_HILBERT_TAPS,
        mapCivMode, didahToCivMode, ic7300IfScale, ic7300Geometry, ic7300View, ic7300Zoom, designHilbert, RealIfConverter
    };
}
