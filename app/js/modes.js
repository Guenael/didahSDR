/**
 * didahSDR - Shared mode table and display constants
 *
 * Single source of truth for the demodulation passbands, consumed by app.js (UI/highlight),
 * demodulator.js (channel filter), smeter.js (SNR window) and waterfall.js (texture range).
 * CW has no fixed passband: it is ±cwBandwidth/2 around the carrier, set at runtime.
 * USB/LSB share one audio low/high pair; LSB is the negated USB interval.
 */
const MODES = {
    cw:  { label: 'CW',  low: null,  high: null },
    usb: { label: 'USB', low: 200,   high: 2700 },
    lsb: { label: 'LSB', low: -2700, high: -200 },
};

const SSB_LOW_MIN = 50;
const SSB_LOW_MAX = 1000;
const SSB_HIGH_MIN = 800;
const SSB_HIGH_MAX = 4000;

/** Lowest dB level representable in the waterfall texture and by the Min Level slider. */
const WATERFALL_DB_FLOOR = -140;

/**
 * Set the USB audio passband and mirror it onto LSB.
 * @returns {{ low: number, high: number }}
 */
function setSsbPassband(lowHz, highHz) {
    let low = Math.round(Number(lowHz));
    let high = Math.round(Number(highHz));
    if (!Number.isFinite(low)) low = 200;
    if (!Number.isFinite(high)) high = 2700;
    low = Math.max(SSB_LOW_MIN, Math.min(SSB_LOW_MAX, low));
    high = Math.max(SSB_HIGH_MIN, Math.min(SSB_HIGH_MAX, high));
    if (high < low + 100) high = Math.min(SSB_HIGH_MAX, low + 100);
    if (low > high - 100) low = Math.max(SSB_LOW_MIN, high - 100);
    MODES.usb.low = low;
    MODES.usb.high = high;
    MODES.lsb.low = -high;
    MODES.lsb.high = -low;
    return { low, high };
}

if (typeof module !== 'undefined') {
    module.exports = {
        MODES, WATERFALL_DB_FLOOR, setSsbPassband,
        SSB_LOW_MIN, SSB_LOW_MAX, SSB_HIGH_MIN, SSB_HIGH_MAX
    };
}
