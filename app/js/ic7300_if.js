/**
 * didahSDR - IC-7300 real 12 kHz IF
 *
 * The USB codec delivers a real IF. An fs/4 mix (or a 12 kHz phasor when the
 * context is a 96/192 kHz upsample) plus a halfband cascade shifts that IF to
 * DC and decimates to ~12 kHz complex. DC is the radio dial; the CW trace sits
 * 650 Hz below it. 44.1 kHz contexts mix at their own fs/4 and land on 11.025 kHz.
 */

const IC7300_NATIVE_RATE = 48000;
const IC7300_IF_HZ = 12000;
const IC7300_CW_TRACE_HZ = 11350;
const IC7300_CW_PITCH_HZ = IC7300_IF_HZ - IC7300_CW_TRACE_HZ;
const IC7300_VIEW_SPAN_HZ = 2500;
const IC7300_SSB_SPAN_HZ = 4000;
const IC7300_OUT_RATE = 12000;

/**
 * CI-V operating-mode byte → didah mode.
 * CW sits 650 Hz below the dial; USB/LSB sit on the carrier (DC).
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
 * Context rate → mix frequency, decimation, and complex output rate.
 * 48/96/192 kHz keep the physical 12 kHz IF and emit 12 kHz.
 * Any other rate is treated as a stretched 48 kHz stream: mix at fs/4, decimate 4:1.
 */
function ic7300DecimPlan(contextRate) {
    const rate = Math.round(Number(contextRate) || IC7300_NATIVE_RATE);
    if (rate === 48000 || rate === 96000 || rate === 192000) {
        const decim = rate / IC7300_OUT_RATE;
        return { contextRate: rate, mixHz: IC7300_IF_HZ, decim, outRate: IC7300_OUT_RATE, fs4: decim === 4 };
    }
    return { contextRate: rate, mixHz: rate / 4, decim: 4, outRate: rate / 4, fs4: true };
}

/** 1 at the 12 kHz channel rate. A 11.025 kHz output scales the 650 Hz pitch with it. */
function ic7300IqScale(iqRate) {
    const r = Number(iqRate);
    if (!r || Math.abs(r - IC7300_OUT_RATE) < 100) return 1;
    return r / IC7300_OUT_RATE;
}

/**
 * Waterfall centre, cursor, and didah mode for one radio report.
 * `radioHz` 0 (or omitted) leaves the axis in audio hertz, cursor on the CW trace.
 * `iqRate` is the decimated complex rate (12000, or 11025 from a 44.1 kHz context).
 */
function ic7300Geometry(radioHz, modeByte, iqRate) {
    const scale = ic7300IqScale(iqRate);
    const pitch = IC7300_CW_PITCH_HZ * scale;
    const mapped = mapCivMode(modeByte);
    let audioOffset = -pitch;
    if (mapped.trace === 'cwr') audioOffset = pitch;
    else if (mapped.trace === 'carrier') audioOffset = 0;
    const have = typeof radioHz === 'number' && radioHz > 0;
    const centerFreq = have ? Math.round(radioHz) : 0;
    const tunedFreq = have ? Math.round(radioHz + audioOffset) : Math.round(audioOffset);
    return {
        centerFreq,
        tunedFreq,
        audioOffset: Math.round(audioOffset),
        modulation: mapped.mod,
        label: mapped.label,
        supported: mapped.supported,
        ifHz: 0
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
 * Locked waterfall window. CW stays on the −650 Hz trace (~2.5 kHz).
 * USB/LSB open to 4 kHz centred on the passband so the sideband fits.
 */
function ic7300View(modeByte, iqRate, passband) {
    const scale = ic7300IqScale(iqRate);
    const mapped = mapCivMode(modeByte);
    const pitch = IC7300_CW_PITCH_HZ * scale;
    let span = IC7300_VIEW_SPAN_HZ;
    let audioCenter = -pitch;
    if (mapped.trace === 'cwr') audioCenter = pitch;
    if (mapped.mod === 'usb' || mapped.mod === 'lsb') {
        span = IC7300_SSB_SPAN_HZ;
        const low = passband && passband.low != null ? passband.low : (mapped.mod === 'lsb' ? -2700 : 200);
        const high = passband && passband.high != null ? passband.high : (mapped.mod === 'lsb' ? -200 : 2700);
        audioCenter = ((low + high) / 2) * scale;
    }
    return { span, audioCenter: Math.round(audioCenter) };
}

/**
 * Real sample → complex baseband centred on the 12 kHz IF.
 * Halfband cascade from demodulator.js. No allocations after construction.
 * `push` writes one interleaved float pair (±1) at `dst[2*fill]` and returns
 * true when a decimated sample was produced.
 */
class RealIfConverter {
    constructor(contextRate) {
        const design = globalThis.designHalfband;
        const FIR = globalThis.ComplexFIR;
        if (!design || !FIR) {
            throw new Error('IC-7300 IF needs demodulator.js loaded first');
        }
        const plan = ic7300DecimPlan(contextRate);
        this.contextRate = plan.contextRate;
        this.outRate = plan.outRate;
        this.decim = plan.decim;
        this.fs4 = plan.fs4;
        this.stages = 0;
        let fs = plan.contextRate;
        while ((1 << this.stages) < plan.decim && this.stages < 6) this.stages++;
        this.hbs = [];
        this.hbFill = [0, 0, 0, 0, 0, 0];
        for (let s = 0; s < this.stages; s++) {
            this.hbs.push(new FIR(design(fs), true));
            fs *= 0.5;
        }
        this.phaseN = 0;
        this.mixC = 1.0;
        this.mixS = 0.0;
        const w = (-2.0 * Math.PI * plan.mixHz) / plan.contextRate;
        this.stepC = Math.cos(w);
        this.stepS = Math.sin(w);
        this.renorm = 0;
    }

    reset() {
        for (let s = 0; s < this.hbs.length; s++) this.hbs[s].reset();
        this.hbFill.fill(0);
        this.phaseN = 0;
        this.mixC = 1.0;
        this.mixS = 0.0;
        this.renorm = 0;
    }

    push(x, dst, fill) {
        let i;
        let q;
        if (this.fs4) {
            const p = this.phaseN;
            this.phaseN = (p + 1) & 3;
            if (p === 0) { i = x; q = 0; }
            else if (p === 1) { i = 0; q = -x; }
            else if (p === 2) { i = -x; q = 0; }
            else { i = 0; q = x; }
        } else {
            const c = this.mixC;
            const s = this.mixS;
            i = x * c;
            q = x * s;
            const nc = c * this.stepC - s * this.stepS;
            this.mixS = c * this.stepS + s * this.stepC;
            this.mixC = nc;
            if (++this.renorm >= 256) {
                const g = 1 / Math.hypot(this.mixC, this.mixS);
                this.mixC *= g;
                this.mixS *= g;
                this.renorm = 0;
            }
        }
        // A real cosine splits equally across ±f. The lowpass keeps one side.
        i *= 2;
        q *= 2;

        const hbs = this.hbs;
        const fills = this.hbFill;
        const stages = this.stages;
        for (let s = 0; s < stages; s++) {
            const hb = hbs[s];
            hb.push(i, q);
            if (++fills[s] < 2) return false;
            fills[s] = 0;
            hb.compute();
            i = hb.outI;
            q = hb.outQ;
        }

        const o = fill * 2;
        dst[o] = i;
        dst[o + 1] = q;
        return true;
    }
}

if (typeof globalThis !== 'undefined') {
    globalThis.IC7300_NATIVE_RATE = IC7300_NATIVE_RATE;
    globalThis.IC7300_IF_HZ = IC7300_IF_HZ;
    globalThis.IC7300_CW_TRACE_HZ = IC7300_CW_TRACE_HZ;
    globalThis.IC7300_CW_PITCH_HZ = IC7300_CW_PITCH_HZ;
    globalThis.IC7300_OUT_RATE = IC7300_OUT_RATE;
    globalThis.mapCivMode = mapCivMode;
    globalThis.ic7300DecimPlan = ic7300DecimPlan;
    globalThis.ic7300IqScale = ic7300IqScale;
    globalThis.ic7300Geometry = ic7300Geometry;
    globalThis.ic7300View = ic7300View;
    globalThis.didahToCivMode = didahToCivMode;
    globalThis.RealIfConverter = RealIfConverter;
}
if (typeof module !== 'undefined') {
    module.exports = {
        IC7300_NATIVE_RATE, IC7300_IF_HZ, IC7300_CW_TRACE_HZ, IC7300_CW_PITCH_HZ, IC7300_OUT_RATE,
        IC7300_VIEW_SPAN_HZ, IC7300_SSB_SPAN_HZ,
        mapCivMode, didahToCivMode, ic7300DecimPlan, ic7300IqScale, ic7300Geometry, ic7300View,
        RealIfConverter
    };
}
