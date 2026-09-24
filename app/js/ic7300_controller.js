/**
 * didahSDR - IC-7300 tuning: the radio owns the VFO (CI-V), didahSDR follows it.
 *
 * The waterfall is locked on the IF around the CW trace (or the SSB passband); the dial shows the
 * radio frequency. A user retune is written to the radio, and CI-V reports that arrive within
 * 600 ms and disagree with what was just sent are ignored, so a poll in flight cannot yank the
 * dial back. The key lines are in tx_controller.js.
 */

const IC7300_HOLD_MS = 600;
const IC7300_WRITE_DELAY_MS = 90;

function createIc7300Controller(ctx) {
    const { state, waterfall, valueDial } = ctx;
    let freqTimer = null;
    let freqSent = 0;
    let freqHoldUntil = 0;
    let modeHold = null;
    let modeHoldUntil = 0;

    const rig = () => ctx.transports.ic7300;

    function passband() {
        if (state.modulation !== 'usb' && state.modulation !== 'lsb') return null;
        const m = MODES[state.modulation];
        return m ? { low: m.low, high: m.high } : null;
    }

    function scheduleFrequency(hz) {
        freqSent = hz;
        freqHoldUntil = Date.now() + IC7300_HOLD_MS;
        if (freqTimer) return;
        freqTimer = setTimeout(() => {
            freqTimer = null;
            const r = rig();
            if (r) r.setFrequency(freqSent);
        }, IC7300_WRITE_DELAY_MS);
    }

    /** Write the IC-7300 VFO. The cursor stays on the IF; only the radio and the dial move. */
    function tuneIc7300FromUser(radioHz) {
        if (ctx.source.protocol !== 'ic7300') return false;
        const r = rig();
        if (!(state.ic7300RadioHz > 0) || !r || !r.cat.connected) return false;
        const hz = Math.max(1000, Math.min(74800000, Math.round(radioHz)));
        if (hz === state.ic7300RadioHz) return true;
        state.ic7300RadioHz = hz;
        applyIc7300Tuning();
        scheduleFrequency(hz);
        return true;
    }

    function selectIc7300Mode(mod) {
        const byte = didahToCivMode(mod);
        if (byte == null) return;
        if (byte === state.ic7300Mode && state.modulation === mod) return;
        state.ic7300Mode = byte;
        modeHold = byte;
        modeHoldUntil = Date.now() + IC7300_HOLD_MS;
        applyIc7300Tuning();
        const r = rig();
        if (r && r.cat.connected) r.setMode(byte, state.ic7300Filter || 1);
    }

    function applyIc7300View() {
        waterfall.viewLock = true;
        valueDial.locked = !(state.ic7300RadioHz > 0);
        const view = ic7300View(state.ic7300Mode, state.sampleRate, passband());
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
        if (ctx.source.protocol !== 'ic7300') return;
        const g = ic7300Geometry(state.ic7300RadioHz, state.ic7300Mode, state.sampleRate);
        const offset = g.tunedFreq - g.centerFreq;
        const prevOffset = state.tunedFreq - state.centerFreq;
        const modSame = state.modulation === g.modulation;
        state.centerFreq = g.centerFreq;
        state.tunedFreq = g.tunedFreq;
        ctx.applyDialRange();
        if (!modSame) {
            ctx.setModulation(g.modulation);
        } else if (offset !== prevOffset) {
            ctx.setTunedFrequency(g.tunedFreq, true, false);
        } else {
            waterfall.setCenterFreq(g.centerFreq, state.sampleRate);
            waterfall.setTunedFreq(g.tunedFreq, state.lowCut, state.highCut, state.modulation);
        }
        applyIc7300View();
        ctx.updateTopBarInfo();
        ctx.updateSourceStatus();
        if (ctx.vfoMemories) ctx.vfoMemories.syncDial(ctx.currentDialHz());
    }

    /** CI-V frequency report (poll answer or transceive). */
    function onRadioFrequency(hz) {
        if (Date.now() < freqHoldUntil && hz !== freqSent) return;
        if (hz === freqSent) freqHoldUntil = 0;
        if (hz === state.ic7300RadioHz) return;
        state.ic7300RadioHz = hz;
        applyIc7300Tuning();
    }

    /** CI-V mode report. */
    function onRadioMode(mode, filter) {
        if (filter) state.ic7300Filter = filter;
        if (Date.now() < modeHoldUntil && mode !== modeHold) return;
        if (mode === modeHold) modeHoldUntil = 0;
        if (mode === state.ic7300Mode) return;
        state.ic7300Mode = mode;
        applyIc7300Tuning();
    }

    Object.assign(ctx, {
        tuneIc7300FromUser, selectIc7300Mode, applyIc7300View, releaseIc7300View, applyIc7300Tuning,
        onIc7300Frequency: onRadioFrequency, onIc7300Mode: onRadioMode
    });
}

if (typeof globalThis !== 'undefined') globalThis.createIc7300Controller = createIc7300Controller;
if (typeof module !== 'undefined') module.exports = { createIc7300Controller };
