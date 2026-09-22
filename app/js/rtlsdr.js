/**
 * didahSDR - RTL-SDR source (WebUSB, RTL2832U + R820T/R820T2)
 *
 * The stick runs at 1.536 Msps. An fs/4 mix (no multiplies, same sense as
 * rtlsdr-wsprd) shifts the capture so the dial centre was 384 kHz below the
 * hardware LO, which parks the RTL DC spike on a CIC null. An N=2, R=8 CIC
 * then a 33-tap compensator deliver 192 kHz int16 IQ to processRawIQ.
 *
 * Register programming for the demodulator and the R820T follows the Apache-2.0
 * webrtlsdr driver (Copyright 2013 Google Inc., Copyright 2024 Jacobo Tarrio
 * Barreiro). This file is not a copy of librtlsdr.
 */

const RTL_CAPTURE_RATE = 1536000;
const RTL_IQ_RATE = 192000;
const RTL_FS4_HZ = 384000;
const RTL_DECIM = 8;
const RTL_XTAL_HZ = 28800000;
const RTL_IF_HZ = 3570000;
const RTL_CIC_GAIN = 64;
const RTL_IQ_SCALE = 96;
const RTL_BULK_BYTES = 65536;

/** Inverse-sinc for a CIC N=2, R=8, M=1, DC gain 1. Flat to about 0.02 dB at ±80 kHz. */
const RTL_CIC_COMP = new Float64Array([
    0.00015115, -0.00019083, 0.00028334, -0.00044953, 0.00071811, -0.00112990,
    0.00174513, -0.00265651, 0.00401393, -0.00607416, 0.00930872, -0.01466179,
    0.02424877, -0.04359414, 0.09075162, -0.25079360, 1.37665938, -0.25079360,
    0.09075162, -0.04359414, 0.02424877, -0.01466179, 0.00930872, -0.00607416,
    0.00401393, -0.00265651, 0.00174513, -0.00112990, 0.00071811, -0.00044953,
    0.00028334, -0.00019083, 0.00015115
]);

const RTL_USB_FILTERS = [
    { vendorId: 0x0bda, productId: 0x2832 },
    { vendorId: 0x0bda, productId: 0x2838 },
    { vendorId: 0x0ccd, productId: 0x00a9 },
    { vendorId: 0x0ccd, productId: 0x00b3 },
    { vendorId: 0x185b, productId: 0x0620 },
    { vendorId: 0x1b80, productId: 0xd393 },
    { vendorId: 0x1b80, productId: 0xd394 },
    { vendorId: 0x1b80, productId: 0xd395 },
    { vendorId: 0x1b80, productId: 0xd398 },
    { vendorId: 0x1b80, productId: 0xd39d },
    { vendorId: 0x1d19, productId: 0x1101 },
    { vendorId: 0x1d19, productId: 0x1102 },
    { vendorId: 0x1d19, productId: 0x1103 },
    { vendorId: 0x1d19, productId: 0x1104 },
    { vendorId: 0x1f4d, productId: 0xa803 },
    { vendorId: 0x1f4d, productId: 0xb803 },
    { vendorId: 0x1f4d, productId: 0xc803 },
    { vendorId: 0x1f4d, productId: 0xd286 },
    { vendorId: 0x1f4d, productId: 0xd803 }
];

/**
 * Nominal tuner frequency. The fs/4 mix shifts a tone at −384 kHz up to DC,
 * matching rtlsdr-wsprd (`realfreq + FS4`). PPM is applied in the crystal
 * model, not by scaling this number a second time.
 */
function rtlNominalHz(displayHz, upconverterHz) {
    return Math.round(Number(displayHz) + RTL_FS4_HZ + (Number(upconverterHz) || 0));
}

/** Effective LO after the crystal PPM correction. */
function rtlHardwareHz(displayHz, ppm, upconverterHz) {
    const nominal = rtlNominalHz(displayHz, upconverterHz);
    return Math.round(nominal * (1 + (Number(ppm) || 0) / 1e6));
}

/**
 * Direct sampling is used only under the crystal frequency. An upconverter
 * pushes the nominal LO into the tuner range, so the PLL stays in the path.
 */
function rtlUsesPll(mode, nominalHz) {
    const direct = (mode === 'direct-q' || mode === 'direct-i') && nominalHz > 0 && nominalHz < RTL_XTAL_HZ;
    return !direct;
}

/**
 * 8:1 CIC (N=2, M=1) plus the compensator. State is kept across bulk buffers
 * so the fs/4 phase does not slip. Output is interleaved int16.
 */
class RtlDecimator {
    constructor() {
        this.reset();
    }

    reset() {
        this.Ix1 = 0;
        this.Ix2 = 0;
        this.Qx1 = 0;
        this.Qx2 = 0;
        this.It1 = 0;
        this.Qt1 = 0;
        this.It2 = 0;
        this.Qt2 = 0;
        this.decimIndex = 0;
        this.mixPhase = 0;
        this.firI = new Float64Array(RTL_CIC_COMP.length);
        this.firQ = new Float64Array(RTL_CIC_COMP.length);
        this.firPos = 0;
    }

    /**
     * @param {Uint8Array} src unsigned interleaved IQ
     * @param {number} nBytes
     * @param {Int16Array} dst
     * @returns {number} int16 samples written (two per complex sample)
     */
    process(src, nBytes, dst) {
        const taps = RTL_CIC_COMP;
        const len = taps.length;
        const scale = RTL_IQ_SCALE / RTL_CIC_GAIN;
        const n = nBytes & ~1;
        let o = 0;
        const outCap = dst.length;
        for (let i = 0; i < n; i += 2) {
            let I = src[i] ^ 0x80;
            let Q = src[i + 1] ^ 0x80;
            if (I & 0x80) I -= 256;
            if (Q & 0x80) Q -= 256;
            const p = this.mixPhase;
            this.mixPhase = (p + 1) & 3;
            if (p === 1) {
                const t = I;
                I = -Q;
                Q = t;
            } else if (p === 2) {
                I = -I;
                Q = -Q;
            } else if (p === 3) {
                const t = I;
                I = Q;
                Q = -t;
            }

            this.Ix1 = (this.Ix1 + I) | 0;
            this.Qx1 = (this.Qx1 + Q) | 0;
            this.Ix2 = (this.Ix2 + this.Ix1) | 0;
            this.Qx2 = (this.Qx2 + this.Qx1) | 0;
            this.decimIndex++;
            if (this.decimIndex < RTL_DECIM) continue;
            this.decimIndex = 0;

            const c1I = (this.Ix2 - this.It1) | 0;
            this.It1 = this.Ix2;
            const c1Q = (this.Qx2 - this.Qt1) | 0;
            this.Qt1 = this.Qx2;
            const c2I = (c1I - this.It2) | 0;
            this.It2 = c1I;
            const c2Q = (c1Q - this.Qt2) | 0;
            this.Qt2 = c1Q;

            const pos = this.firPos;
            this.firI[pos] = c2I;
            this.firQ[pos] = c2Q;
            let accI = 0;
            let accQ = 0;
            let k = pos;
            for (let t = 0; t < len; t++) {
                accI += this.firI[k] * taps[t];
                accQ += this.firQ[k] * taps[t];
                k = k === 0 ? len - 1 : k - 1;
            }
            this.firPos = pos + 1 === len ? 0 : pos + 1;

            if (o + 1 >= outCap) break;
            let si = accI * scale;
            let sq = accQ * scale;
            if (si > 32767) si = 32767;
            else if (si < -32768) si = -32768;
            if (sq > 32767) sq = 32767;
            else if (sq < -32768) sq = -32768;
            dst[o++] = si;
            dst[o++] = sq;
        }
        return o;
    }
}

/**
 * Tune helper shared by the device and the tests. `port.setTunerFrequency` is
 * the R820T PLL; direct sampling must not call it.
 */
async function rtlApplyCenter(port, mode, nominalHz) {
    const usePll = rtlUsesPll(mode, nominalHz);
    if (!usePll) {
        await port.ensureFrontEnd(mode);
        await port.setIfFrequency(nominalHz);
        return { usePll: false };
    }
    await port.ensureFrontEnd('tuner');
    await port.openI2C();
    try {
        await port.setTunerFrequency(nominalHz);
    } finally {
        await port.closeI2C();
    }
    return { usePll: true };
}

/* ------------------------------------------------------------------ */
/* USB register access. Control layout matches webrtlsdr's RtlCom.    */
/* ------------------------------------------------------------------ */

const RTL_WRITE_FLAG = 0x10;

function rtlNumberToBytes(value, len, bigEndian) {
    const buf = new Uint8Array(len);
    const view = new DataView(buf.buffer);
    if (len === 1) view.setUint8(0, value & 0xff);
    else if (len === 2) view.setUint16(0, value & 0xffff, !bigEndian);
    else if (len === 4) view.setUint32(0, value >>> 0, !bigEndian);
    else throw new Error('Bad RTL register width ' + len);
    return buf;
}

function rtlBytesToNumber(buf) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (buf.length === 1) return view.getUint8(0);
    if (buf.length === 2) return view.getUint16(0, true);
    if (buf.length === 4) return view.getUint32(0, true);
    return 0;
}

class RtlCom {
    constructor(device) {
        this.device = device;
    }

    async claim() {
        if (this.device.configuration == null) await this.device.selectConfiguration(1);
        try {
            await this.device.claimInterface(0);
        } catch (e) {
            throw new Error('Could not claim the RTL-SDR. Close other SDR apps, and on Linux unload dvb_usb_rtl28xxu.');
        }
    }

    async release() {
        try { await this.device.releaseInterface(0); } catch (e) { /* already gone */ }
    }

    async close() {
        try { await this.device.close(); } catch (e) { /* already closed */ }
    }

    async setUsbReg(address, value, length) {
        await this._write(address, 0x100 | RTL_WRITE_FLAG, rtlNumberToBytes(value, length, false));
    }

    async setSysReg(address, value) {
        await this._write(address, 0x200 | RTL_WRITE_FLAG, rtlNumberToBytes(value, 1, false));
    }

    async getSysReg(address) {
        return rtlBytesToNumber(await this._read(address, 0x200, 1));
    }

    async setDemodReg(page, addr, value, len) {
        await this._write((addr << 8) | 0x20, page | RTL_WRITE_FLAG, rtlNumberToBytes(value, len, true));
        await this._read(0x0120, 0x0a, 1);
    }

    async getI2CReg(addr, reg) {
        await this._write(addr, 0x600 | RTL_WRITE_FLAG, new Uint8Array([reg]));
        return rtlBytesToNumber(await this._read(addr, 0x600, 1));
    }

    async setI2CReg(addr, reg, value) {
        await this._write(addr, 0x600 | RTL_WRITE_FLAG, new Uint8Array([reg, value & 0xff]));
    }

    async getI2CRegBuffer(addr, reg, len) {
        await this._write(addr, 0x600 | RTL_WRITE_FLAG, new Uint8Array([reg]));
        return this._read(addr, 0x600, len);
    }

    async openI2C() {
        await this.setDemodReg(1, 0x01, 0x18, 1);
    }

    async closeI2C() {
        await this.setDemodReg(1, 0x01, 0x10, 1);
    }

    async setGpioOutput(gpio) {
        const bit = 1 << gpio;
        let r = await this.getSysReg(0x3004);
        await this.setSysReg(0x3004, r & ~bit);
        r = await this.getSysReg(0x3003);
        await this.setSysReg(0x3003, r | bit);
    }

    async setGpioBit(gpio, val) {
        const bit = 1 << gpio;
        let r = await this.getSysReg(0x3001);
        r = val ? (r | bit) : (r & ~bit);
        await this.setSysReg(0x3001, r & 0xff);
    }

    /** Copy a bulk IN into `dst`. Returns the byte count. */
    async readBulk(dst) {
        const result = await this.device.transferIn(1, dst.length);
        if (result.status === 'stall') {
            await this.device.clearHalt('in', 1);
            return 0;
        }
        if (result.status !== 'ok' || !result.data) {
            throw new Error('USB bulk read failed (' + (result && result.status) + ')');
        }
        const view = result.data;
        const n = Math.min(dst.length, view.byteLength);
        for (let i = 0; i < n; i++) dst[i] = view.getUint8(i);
        return n;
    }

    async resetBuffer() {
        await this.setUsbReg(0x2148, 0b0000001000010000, 2);
        await this.setUsbReg(0x2148, 0x0000, 2);
    }

    async _read(value, index, length) {
        const result = await this.device.controlTransferIn({
            requestType: 'vendor',
            recipient: 'device',
            request: 0,
            value: value,
            index: index
        }, Math.max(8, length));
        if (result.status !== 'ok' || !result.data) {
            throw new Error('USB read failed @' + value.toString(16));
        }
        const out = new Uint8Array(length);
        for (let i = 0; i < length; i++) out[i] = result.data.getUint8(i);
        return out;
    }

    async _write(value, index, bytes) {
        const result = await this.device.controlTransferOut({
            requestType: 'vendor',
            recipient: 'device',
            request: 0,
            value: value,
            index: index
        }, bytes);
        if (result.status !== 'ok') throw new Error('USB write failed @' + value.toString(16));
    }
}

const R820_REGISTERS = [
    0b10000011, 0b00110010, 0b01110101, 0b11000000, 0b01000000, 0b11010110,
    0b01101100, 0b11110101, 0b01100011, 0b01110101, 0b01101000, 0b01101100,
    0b10000011, 0b10000000, 0b00000000, 0b00001111, 0b00000000, 0b11000000,
    0b00110000, 0b01001000, 0b11001100, 0b01100000, 0b00000000, 0b01010100,
    0b10101110, 0b01001010, 0b11000000
];

const R820_MUX = [
    [0, 0b1000, 0b00000010, 0b11011111],
    [50, 0b1000, 0b00000010, 0b10111110],
    [55, 0b1000, 0b00000010, 0b10001011],
    [60, 0b1000, 0b00000010, 0b01111011],
    [65, 0b1000, 0b00000010, 0b01101001],
    [70, 0b1000, 0b00000010, 0b01011000],
    [75, 0b0000, 0b00000010, 0b01000100],
    [90, 0b0000, 0b00000010, 0b00110100],
    [110, 0b0000, 0b00000010, 0b00100100],
    [140, 0b0000, 0b00000010, 0b00010100],
    [180, 0b0000, 0b00000010, 0b00010011],
    [250, 0b0000, 0b00000010, 0b00010001],
    [280, 0b0000, 0b00000010, 0b00000000],
    [310, 0b0000, 0b01000001, 0b00000000],
    [588, 0b0000, 0b01000000, 0b00000000]
];

const R820_BIT_REV = [0x0, 0x8, 0x4, 0xc, 0x2, 0xa, 0x6, 0xe, 0x1, 0x9, 0x5, 0xd, 0x3, 0xb, 0x7, 0xf];

class R820Tuner {
    constructor(com) {
        this.com = com;
        this.i2c = 0x34;
        this.xtalFreq = RTL_XTAL_HZ;
        this.hasPllLock = false;
        this.shadow = new Uint8Array(R820_REGISTERS);
    }

    static async detect(com) {
        await com.openI2C();
        let found = false;
        try {
            found = (await com.getI2CReg(0x34, 0)) === 0x69;
        } catch (e) { found = false; }
        await com.closeI2C();
        return found;
    }

    setXtalFrequency(hz) {
        this.xtalFreq = hz;
    }

    async open() {
        await this.com.setDemodReg(1, 0xb1, 0b00011010, 1);
        await this.com.setDemodReg(0, 0x08, 0b01001101, 1);
        await this.com.setDemodReg(1, 0x15, 0b00000001, 1);
        await this.com.openI2C();
        this.shadow = new Uint8Array(R820_REGISTERS);
        for (let i = 0; i < this.shadow.length; i++) {
            await this.com.setI2CReg(this.i2c, i + 5, this.shadow[i]);
        }
        await this._initElectronics();
        await this.com.closeI2C();
    }

    async close() {
        await this._mask(0x06, 0b10110001, 0xff);
        await this._mask(0x05, 0b10110011, 0xff);
        await this._mask(0x07, 0b00111010, 0xff);
        await this._mask(0x08, 0b01000000, 0xff);
        await this._mask(0x09, 0b11000000, 0xff);
        await this._mask(0x0a, 0b00111010, 0xff);
        await this._mask(0x0c, 0b00110101, 0xff);
        await this._mask(0x0f, 0b01101000, 0xff);
        await this._mask(0x11, 0b00000011, 0xff);
        await this._mask(0x17, 0b11110100, 0xff);
        await this._mask(0x19, 0b00001100, 0xff);
    }

    async setAutoGain() {
        await this._mask(0x05, 0b00000000, 0b00010000);
        await this._mask(0x07, 0b00010000, 0b00010000);
        await this._mask(0x0c, 0b00001011, 0b10011111);
    }

    async setManualGain(gainDb) {
        let full = Math.floor(gainDb / 3.5);
        let half = gainDb - 3.5 * full >= 2.3 ? 1 : 0;
        if (full < 0) full = 0;
        if (full > 15) full = 15;
        if (full === 15) half = 0;
        await this._mask(0x05, 0b00010000, 0b00010000);
        await this._mask(0x07, 0b00000000, 0b00010000);
        await this._mask(0x0c, 0b00001000, 0b10011111);
        await this._mask(0x05, full + half, 0b00001111);
        await this._mask(0x07, full, 0b00001111);
    }

    /** Tune the PLL to `freq` Hz (the RF frequency, not including the 3.57 MHz IF). */
    async setFrequency(freq) {
        const target = freq + RTL_IF_HZ;
        await this._setMux(target);
        const actual = await this._setPll(target);
        return actual - RTL_IF_HZ;
    }

    async _mask(addr, value, mask) {
        const rc = this.shadow[addr - 5];
        const val = (rc & ~mask) | (value & mask);
        this.shadow[addr - 5] = val;
        await this.com.setI2CReg(this.i2c, addr, val);
    }

    async _readRegs(addr, length) {
        const data = await this.com.getI2CRegBuffer(this.i2c, addr, length);
        const buf = new Uint8Array(data);
        for (let i = 0; i < buf.length; i++) {
            const b = buf[i];
            buf[i] = (R820_BIT_REV[b & 0xf] << 4) | R820_BIT_REV[b >> 4];
        }
        return buf;
    }

    async _setMux(freq) {
        const mhz = freq / 1e6;
        let i = 0;
        for (; i < R820_MUX.length - 1; i++) {
            if (mhz < R820_MUX[i + 1][0]) break;
        }
        const cfg = R820_MUX[i];
        await this._mask(0x17, cfg[1], 0b00001000);
        await this._mask(0x1a, cfg[2], 0b11000011);
        await this._mask(0x1b, cfg[3], 0b11111111);
        await this._mask(0x10, 0b00000000, 0b00001011);
        await this._mask(0x08, 0b00000000, 0b00111111);
        await this._mask(0x09, 0b00000000, 0b00111111);
    }

    async _setPll(freq) {
        const pllRef = Math.floor(this.xtalFreq);
        await this._mask(0x10, 0b00000000, 0b00010000);
        await this._mask(0x1a, 0b00000000, 0b00001100);
        await this._mask(0x12, 0b10000000, 0b11100000);
        let divNum = Math.min(6, Math.floor(Math.log(1770000000 / freq) / Math.LN2));
        let mixDiv = 1 << (divNum + 1);
        const arr = await this._readRegs(0x00, 5);
        const vcoFine = (arr[4] & 0x30) >> 4;
        if (vcoFine > 2) divNum--;
        else if (vcoFine < 2) divNum++;
        await this._mask(0x10, divNum << 5, 0b11100000);
        const vcoFreq = freq * mixDiv;
        const nint = Math.floor(vcoFreq / (2 * pllRef));
        const vcoFra = vcoFreq % (2 * pllRef);
        if (nint > 63) {
            this.hasPllLock = false;
            return 0;
        }
        const ni = Math.floor((nint - 13) / 4);
        const si = (nint - 13) % 4;
        await this._mask(0x14, ni + (si << 6), 0b11111111);
        await this._mask(0x12, vcoFra === 0 ? 0b1000 : 0b0000, 0b00001000);
        const sdm = Math.min(65535, Math.floor((32768 * vcoFra) / pllRef));
        await this._mask(0x16, sdm >> 8, 0b11111111);
        await this._mask(0x15, sdm & 0xff, 0b11111111);
        await this._waitPll();
        await this._mask(0x1a, 0b00001000, 0b00001000);
        return (2 * pllRef * (nint + sdm / 65536)) / mixDiv;
    }

    async _waitPll() {
        let first = true;
        for (;;) {
            const arr = await this._readRegs(0x00, 3);
            if (arr[2] & 0b01000000) {
                this.hasPllLock = true;
                return;
            }
            if (!first) {
                this.hasPllLock = true;
                return;
            }
            await this._mask(0x12, 0b01100000, 0b11100000);
            first = false;
        }
    }

    async _calibrateFilter() {
        let first = true;
        for (;;) {
            await this._mask(0x0b, 0b01100000, 0b01100000);
            await this._mask(0x0f, 0b00000100, 0b00000100);
            await this._mask(0x10, 0b00000000, 0b00000011);
            await this._setPll(56000000);
            if (!this.hasPllLock) throw new Error('R820T PLL did not lock during filter calibration');
            await this._mask(0x0b, 0b00010000, 0b00010000);
            await this._mask(0x0b, 0b00000000, 0b00010000);
            await this._mask(0x0f, 0b00000000, 0b00000100);
            const arr = await this._readRegs(0x00, 5);
            let filterCap = arr[4] & 0b00001111;
            if (filterCap === 0b00001111) filterCap = 0;
            if (filterCap === 0 || !first) return filterCap;
            first = false;
        }
    }

    async _initElectronics() {
        await this._mask(0x0c, 0b00000000, 0b00001111);
        await this._mask(0x13, 0b00110001, 0b00111111);
        await this._mask(0x1d, 0b00000000, 0b00111000);
        const filterCap = await this._calibrateFilter();
        await this._mask(0x0a, 0b00010000 | filterCap, 0b00011111);
        await this._mask(0x0b, 0b01101011, 0b11101111);
        await this._mask(0x07, 0b00000000, 0b10000000);
        await this._mask(0x06, 0b00010000, 0b00110000);
        await this._mask(0x1e, 0b01000000, 0b01100000);
        await this._mask(0x05, 0b00000000, 0b10000000);
        await this._mask(0x1f, 0b00000000, 0b10000000);
        await this._mask(0x0f, 0b00000000, 0b10000000);
        await this._mask(0x19, 0b01100000, 0b01100000);
        await this._mask(0x1d, 0b11100101, 0b11000111);
        await this._mask(0x1c, 0b00100100, 0b11111000);
        await this._mask(0x0d, 0b01010011, 0b11111111);
        await this._mask(0x0e, 0b01110101, 0b11111111);
        await this._mask(0x05, 0b00000000, 0b01100000);
        await this._mask(0x06, 0b00000000, 0b00001000);
        await this._mask(0x11, 0b00111000, 0b00001000);
        await this._mask(0x17, 0b00110000, 0b00110000);
        await this._mask(0x0a, 0b01000000, 0b01100000);
        await this._mask(0x1d, 0b00000000, 0b00111000);
        await this._mask(0x1c, 0b00000000, 0b00000100);
        await this._mask(0x06, 0b00000000, 0b01000000);
        await this._mask(0x1a, 0b00110000, 0b00110000);
        await this._mask(0x1d, 0b00011000, 0b00111000);
        await this._mask(0x1c, 0b00100100, 0b00000100);
        await this._mask(0x1e, 0b00001101, 0b00011111);
        await this._mask(0x1a, 0b00100000, 0b00110000);
    }
}

async function rtlDemodInit(com) {
    await com.setUsbReg(0x2000, 0b00001001, 1);
    await com.setUsbReg(0x2158, 0x0200, 2);
    await com.setUsbReg(0x2148, 0b0000001000010000, 2);
    await com.setSysReg(0x300b, 0b00100010);
    await com.setSysReg(0x3000, 0b11101000);
    await com.setDemodReg(1, 0x01, 0b00010100, 1);
    await com.setDemodReg(1, 0x01, 0b00010000, 1);
    await com.setDemodReg(1, 0x15, 0b00000000, 1);
    await com.setDemodReg(1, 0x16, 0x00, 1);
    await com.setDemodReg(1, 0x17, 0x00, 1);
    await com.setDemodReg(1, 0x18, 0x00, 1);
    await com.setDemodReg(1, 0x19, 0x00, 1);
    await com.setDemodReg(1, 0x1a, 0x00, 1);
    await com.setDemodReg(1, 0x1b, 0x00, 1);
    const lpf = [
        0xca, 0xdc, 0xd7, 0xd8, 0xe0, 0xf2, 0x0e, 0x35, 0x06, 0x50, 0x9c, 0x0d,
        0x71, 0x11, 0x14, 0x71, 0x74, 0x19, 0x41, 0xa5
    ];
    for (let i = 0; i < lpf.length; i++) await com.setDemodReg(1, 0x1c + i, lpf[i], 1);
    await com.setDemodReg(0, 0x19, 0b00000101, 1);
    await com.setDemodReg(1, 0x93, 0b11110000, 1);
    await com.setDemodReg(1, 0x94, 0b00001111, 1);
    await com.setDemodReg(1, 0x11, 0b00000000, 1);
    await com.setDemodReg(1, 0x04, 0b00000000, 1);
    await com.setDemodReg(0, 0x61, 0b01100000, 1);
    await com.setDemodReg(0, 0x06, 0b10000000, 1);
    await com.setDemodReg(1, 0xb1, 0b00011011, 1);
    await com.setDemodReg(0, 0x0d, 0b10000011, 1);
}

class RtlSdrSource {
    constructor(options) {
        this.onRawIQ = options.onRawIQ || null;
        this.onReady = options.onReady || null;
        this.onStatusChange = options.onStatusChange || null;

        this.mode = 'direct-q';
        this.ppm = 0;
        this.gain = null;
        this.upconverterHz = 0;
        this.biasTee = false;
        this.displayHz = 14048000;

        this.connected = false;
        this.streaming = false;
        this._wantStream = false;
        this._device = null;
        this._com = null;
        this._tuner = null;
        this._front = 'tuner';
        this._reading = false;
        this._opening = null;
        this._freqTimer = null;
        this._tuneSeq = 0;
        this._decimator = new RtlDecimator();
        this._bulk = new Uint8Array(RTL_BULK_BYTES);
        this._out = new Int16Array((RTL_BULK_BYTES / 2 / RTL_DECIM) * 2);
    }

    _status(text, ok) {
        if (this.onStatusChange) this.onStatusChange(text, !!ok);
    }

    setMode(mode) {
        this.mode = mode === 'direct-i' || mode === 'tuner' ? mode : 'direct-q';
        this._scheduleTune();
    }

    setPpm(ppm) {
        const n = Math.round(Number(ppm) || 0);
        if (n === this.ppm) return;
        this.ppm = n;
        if (this._com) this._pushPpm();
    }

    setGainDb(gain) {
        this.gain = gain == null || gain === 'auto' ? null : Number(gain);
        if (this._com) this._pushGain();
    }

    setUpconverterHz(hz) {
        this.upconverterHz = Math.round(Number(hz) || 0);
        this._scheduleTune();
    }

    setBiasTee(on) {
        this.biasTee = !!on;
        if (this._com) this._pushBias();
    }

    setDisplayHz(hz) {
        this.displayHz = Math.round(Number(hz) || 0);
        this._scheduleTune();
    }

    _scheduleTune() {
        if (!this.connected) return;
        if (this._freqTimer) clearTimeout(this._freqTimer);
        this._freqTimer = setTimeout(() => {
            this._freqTimer = null;
            this._pushFrequency();
        }, 60);
    }

    /** Open the stick if needed and start the bulk read loop. */
    start() {
        this._wantStream = true;
        if (this._opening) {
            return this._opening.then(() => {
                if (this._wantStream && this._device) this._stream();
                return this.connected;
            });
        }
        if (this._device) {
            this._stream();
            return Promise.resolve(true);
        }
        return this._open();
    }

    /** Claim the stick without reading, so a later Power-on can stream. */
    prepare() {
        if (this._device) return Promise.resolve(true);
        return this._open();
    }

    stop() {
        this._wantStream = false;
        this._reading = false;
        this.streaming = false;
    }

    async close() {
        this.stop();
        if (this._freqTimer) {
            clearTimeout(this._freqTimer);
            this._freqTimer = null;
        }
        const com = this._com;
        const tuner = this._tuner;
        const front = this._front;
        this.connected = false;
        this._device = null;
        this._com = null;
        this._tuner = null;
        this._front = 'tuner';
        if (com) {
            try {
                if (tuner && front === 'tuner') {
                    await com.openI2C();
                    await tuner.close();
                    await com.closeI2C();
                }
            } catch (e) { /* unplug */ }
            try { await com.release(); } catch (e) { /* unplug */ }
            await com.close();
        }
        this._status('RTL-SDR disconnected', false);
    }

    async _open() {
        const usb = typeof navigator !== 'undefined' ? navigator.usb : null;
        if (!usb || !usb.requestDevice) {
            this._status('WebUSB needs Chrome or Edge', false);
            return false;
        }
        this._opening = (async () => {
            let device;
            try {
                device = await usb.requestDevice({ filters: RTL_USB_FILTERS });
            } catch (e) {
                this._status('No RTL-SDR selected', false);
                return false;
            }
            try {
                await device.open();
                const com = new RtlCom(device);
                await com.claim();
                await rtlDemodInit(com);
                const found = await R820Tuner.detect(com);
                if (!found) {
                    await com.release();
                    await com.close();
                    this._status('This stick is not an R820T or R820T2', false);
                    return false;
                }
                const tuner = new R820Tuner(com);
                await tuner.open();
                this._device = device;
                this._com = com;
                this._tuner = tuner;
                this._front = 'tuner';
                this.connected = true;
                await this._applyPpm();
                await this._applySampleRate();
                await this._applyGain();
                await this._applyBias();
                await this._tuneNow();
                await com.resetBuffer();
                this._decimator.reset();
                this._status('RTL-SDR connected', true);
                if (this.onReady) this.onReady({ sampleRate: RTL_IQ_RATE, centerFreq: this.displayHz });
                if (this._wantStream) this._stream();
                return true;
            } catch (e) {
                this.connected = false;
                this._device = null;
                this._com = null;
                this._tuner = null;
                try { await device.close(); } catch (err) { /* ignore */ }
                this._status(e && e.message ? e.message : 'RTL-SDR open failed', false);
                return false;
            }
        })();
        try {
            return await this._opening;
        } finally {
            this._opening = null;
        }
    }

    _stream() {
        if (this._reading || !this._com) return;
        this._reading = true;
        this.streaming = true;
        const com = this._com;
        const loop = async () => {
            try {
                await com.resetBuffer();
                this._decimator.reset();
            } catch (e) {
                if (this._reading) this._status('RTL-SDR buffer reset failed', false);
                this._reading = false;
                this.streaming = false;
                return;
            }
            while (this._reading && this._com === com) {
                let n = 0;
                try {
                    n = await com.readBulk(this._bulk);
                } catch (e) {
                    if (!this._reading) return;
                    this._reading = false;
                    this.streaming = false;
                    this._status('USB read failed', false);
                    return;
                }
                if (!this._reading || n < 2) continue;
                const samples = this._decimator.process(this._bulk, n, this._out);
                if (samples > 0 && this.onRawIQ) this.onRawIQ(this._out.subarray(0, samples));
            }
            this.streaming = false;
        };
        loop();
    }

    _xtal() {
        return Math.floor(RTL_XTAL_HZ * (1 + this.ppm / 1e6));
    }

    async _applyPpm() {
        const com = this._com;
        if (!com) return;
        let ppmOffset = -1 * Math.floor((this.ppm * (1 << 24)) / 1000000);
        ppmOffset |= 0;
        await com.setDemodReg(1, 0x3e, (ppmOffset >> 8) & 0x3f, 1);
        await com.setDemodReg(1, 0x3f, ppmOffset & 0xff, 1);
        if (this._tuner) this._tuner.setXtalFrequency(this._xtal());
        if (this._front === 'tuner') await this._setIfFrequency(RTL_IF_HZ);
    }

    async _applySampleRate() {
        const com = this._com;
        if (!com) return;
        let ratio = Math.floor((this._xtal() * (1 << 22)) / RTL_CAPTURE_RATE);
        ratio &= 0x0ffffffc;
        await com.setDemodReg(1, 0x9f, (ratio >> 16) & 0xffff, 2);
        await com.setDemodReg(1, 0xa1, ratio & 0xffff, 2);
        await com.setDemodReg(1, 0x01, 0b00010100, 1);
        await com.setDemodReg(1, 0x01, 0b00010000, 1);
    }

    async _setIfFrequency(ifFreq) {
        const xtal = this._xtal();
        let multiplier = -1 * Math.floor((ifFreq * (1 << 22)) / xtal);
        multiplier |= 0;
        await this._com.setDemodReg(1, 0x19, (multiplier >> 16) & 0x3f, 1);
        await this._com.setDemodReg(1, 0x1a, (multiplier >> 8) & 0xff, 1);
        await this._com.setDemodReg(1, 0x1b, multiplier & 0xff, 1);
    }

    async _enableRtlAgc(on) {
        await this._com.setDemodReg(0, 0x19, on ? 0x25 : 0x05, 1);
    }

    async _applyGain() {
        if (!this._com) return;
        if (this._front !== 'tuner') {
            await this._enableRtlAgc(this.gain == null);
            return;
        }
        await this._com.openI2C();
        try {
            if (this.gain == null) await this._tuner.setAutoGain();
            else await this._tuner.setManualGain(this.gain);
        } finally {
            await this._com.closeI2C();
        }
    }

    async _applyBias() {
        if (!this._com) return;
        await this._com.setGpioOutput(0);
        await this._com.setGpioBit(0, this.biasTee ? 1 : 0);
    }

    async _ensureFrontEnd(front) {
        if (this._front === front) return;
        const wasTuner = this._front === 'tuner';
        const useDirect = front !== 'tuner';
        this._front = front;
        if (useDirect) {
            if (wasTuner && this._tuner) {
                await this._com.openI2C();
                await this._tuner.close();
                await this._com.closeI2C();
            }
            await this._com.setDemodReg(1, 0xb1, 0b00011010, 1);
            await this._com.setDemodReg(1, 0x15, 0b00000000, 1);
            await this._com.setDemodReg(0, 0x06, front === 'direct-i' ? 0b10000000 : 0b10010000, 1);
            await this._enableRtlAgc(this.gain == null);
        } else {
            await this._com.openI2C();
            await this._tuner.open();
            await this._com.closeI2C();
            await this._setIfFrequency(RTL_IF_HZ);
            await this._com.setDemodReg(1, 0x15, 0b00000001, 1);
            await this._com.setDemodReg(0, 0x06, 0b10000000, 1);
            await this._enableRtlAgc(false);
            await this._applyGain();
        }
    }

    _port() {
        const self = this;
        return {
            ensureFrontEnd: (front) => self._ensureFrontEnd(front),
            setIfFrequency: (hz) => self._setIfFrequency(hz),
            openI2C: () => self._com.openI2C(),
            closeI2C: () => self._com.closeI2C(),
            setTunerFrequency: (hz) => self._tuner.setFrequency(hz)
        };
    }

    async _tuneNow() {
        if (!this._com || !this._tuner) return;
        const seq = ++this._tuneSeq;
        const nominal = rtlNominalHz(this.displayHz, this.upconverterHz);
        await rtlApplyCenter(this._port(), this.mode, nominal);
        if (seq !== this._tuneSeq) return;
    }

    _pushFrequency() {
        this._tuneNow().catch((e) => {
            if (this.connected) this._status(e && e.message ? e.message : 'Tune failed', false);
        });
    }

    _pushPpm() {
        this._applyPpm()
            .then(() => this._applySampleRate())
            .then(() => this._tuneNow())
            .catch(() => {});
    }

    _pushGain() {
        this._applyGain().catch(() => {});
    }

    _pushBias() {
        this._applyBias().catch(() => {});
    }
}

if (typeof module !== 'undefined') {
    module.exports = {
        RTL_CAPTURE_RATE, RTL_IQ_RATE, RTL_FS4_HZ, RTL_DECIM, RTL_XTAL_HZ, RTL_CIC_COMP,
        rtlNominalHz, rtlHardwareHz, rtlUsesPll, rtlApplyCenter, RtlDecimator, RtlSdrSource,
        rtlNumberToBytes
    };
}
