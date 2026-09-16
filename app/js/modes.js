/**
 * didahSDR - Shared mode table and display constants
 *
 * Single source of truth for the demodulation passbands, consumed by app.js (UI/highlight),
 * demodulator.js (channel filter), smeter.js (SNR window) and waterfall.js (texture range).
 * CW has no fixed passband: it is ±cwBandwidth/2 around the carrier, set at runtime.
 */
const MODES = {
    cw:  { label: 'CW',  low: null,  high: null },
    usb: { label: 'USB', low: 300,   high: 3000 },
    lsb: { label: 'LSB', low: -3000, high: -300 },
};

/** Lowest dB level representable in the waterfall texture and by the Min Level slider. */
const WATERFALL_DB_FLOOR = -140;

if (typeof module !== 'undefined') module.exports = { MODES, WATERFALL_DB_FLOOR };
