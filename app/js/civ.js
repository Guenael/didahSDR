/**
 * didahSDR - Icom CI-V frames for the IC-7300
 *
 * Binary only: FE FE [to] [from] [cmd] [data…] FD. Address 0x94, controller 0xE0.
 * Frequency is 5-byte packed BCD, least significant byte first. Command 0x05 writes
 * the VFO and 0x06 writes the mode. CW: DTR is USB Keying, RTS is USB SEND.
 */

const CIV_ADDR_IC7300 = 0x94;
const CIV_ADDR_CONTROLLER = 0xE0;
const CIV_BAUD_DEFAULT = 19200;
const CIV_BAUDS = [4800, 9600, 19200, 38400];

/** 5-byte CI-V frequency, LSB first. 14200000 Hz → 00 00 20 14 00. */
function encodeFreqBcd(hz) {
    const n = Math.max(0, Math.min(9999999999, Math.round(Number(hz) || 0)));
    const digits = String(n).padStart(10, '0').slice(-10);
    const out = new Uint8Array(5);
    for (let i = 0; i < 5; i++) {
        out[i] = parseInt(digits.slice(8 - i * 2, 10 - i * 2), 16);
    }
    return out;
}

/** @returns {number|null} hertz, or null if a nibble is not decimal. */
function decodeFreqBcd(bytes) {
    if (!bytes || bytes.length < 5) return null;
    let hz = 0;
    let mul = 1;
    for (let i = 0; i < 5; i++) {
        const b = bytes[i] & 0xff;
        const lo = b & 0x0f;
        const hi = (b >> 4) & 0x0f;
        if (lo > 9 || hi > 9) return null;
        hz += (lo + hi * 10) * mul;
        mul *= 100;
    }
    return hz;
}

/** Read-frequency (0x03) or read-mode (0x04) frame. No payload. */
function civCommand(cmd) {
    return new Uint8Array([0xFE, 0xFE, CIV_ADDR_IC7300, CIV_ADDR_CONTROLLER, cmd & 0xff, 0xFD]);
}

/** Set operating frequency (0x05). */
function civSetFrequency(hz) {
    const bcd = encodeFreqBcd(hz);
    const frame = new Uint8Array(6 + bcd.length);
    frame.set([0xFE, 0xFE, CIV_ADDR_IC7300, CIV_ADDR_CONTROLLER, 0x05], 0);
    frame.set(bcd, 5);
    frame[frame.length - 1] = 0xFD;
    return frame;
}

/** Keyer speed 0x14 0x0C: WPM 6 → 0, WPM 48 → 255, two-byte BCD. */
function civKeySpeedValue(wpm) {
    const w = Math.max(6, Math.min(48, Math.round(Number(wpm) || 6)));
    return Math.round((w - 6) * 255 / 42);
}

function civSetKeySpeed(wpm) {
    const n = civKeySpeedValue(wpm);
    const digits = String(n).padStart(4, '0');
    const lo = parseInt(digits.slice(2, 4), 16);
    const hi = parseInt(digits.slice(0, 2), 16);
    return new Uint8Array([
        0xFE, 0xFE, CIV_ADDR_IC7300, CIV_ADDR_CONTROLLER, 0x14, 0x0C, lo, hi, 0xFD
    ]);
}

/** Send CW memory text (0x17). At most 30 ASCII characters. Empty text is not a frame. */
function civSendCw(text) {
    const s = String(text || '').replace(/[^\x20-\x7E]/g, '').slice(0, 30);
    if (!s) return null;
    const frame = new Uint8Array(6 + s.length);
    frame.set([0xFE, 0xFE, CIV_ADDR_IC7300, CIV_ADDR_CONTROLLER, 0x17], 0);
    for (let i = 0; i < s.length; i++) frame[5 + i] = s.charCodeAt(i) & 0x7f;
    frame[frame.length - 1] = 0xFD;
    return frame;
}

/** Set operating mode (0x06) plus filter number (1–3). */
function civSetMode(mode, filter) {
    const fil = Math.max(1, Math.min(3, filter || 1));
    return new Uint8Array([
        0xFE, 0xFE, CIV_ADDR_IC7300, CIV_ADDR_CONTROLLER, 0x06, mode & 0xff, fil, 0xFD
    ]);
}

/**
 * One frame body, without the FE FE preamble and FD tail.
 * @returns {{kind:'echo'|'freq'|'mode'}|null}
 */
function classifyCivFrame(body) {
    if (!body || body.length < 3) return null;
    const to = body[0] & 0xff;
    const cmd = body[2] & 0xff;
    if (to === CIV_ADDR_IC7300) return { kind: 'echo' };
    if (to !== CIV_ADDR_CONTROLLER && to !== 0x00) return null;
    if (cmd === 0x03 || cmd === 0x00) {
        const hz = decodeFreqBcd(body.subarray ? body.subarray(3, 8) : body.slice(3, 8));
        if (hz == null || hz < 1000) return null;
        return { kind: 'freq', hz };
    }
    if ((cmd === 0x04 || cmd === 0x01) && body.length >= 4) {
        return {
            kind: 'mode',
            mode: body[3] & 0xff,
            filter: body.length > 4 ? (body[4] & 0xff) : 0
        };
    }
    return null;
}

/** Streaming FE FE … FD splitter. A 0xFE inside a body resyncs. */
class CivParser {
    constructor() {
        this._buf = [];
        this._pre = 0;
    }

    reset() {
        this._buf.length = 0;
        this._pre = 0;
    }

    push(bytes, onFrame) {
        if (!bytes) return;
        for (let i = 0; i < bytes.length; i++) {
            const b = bytes[i] & 0xff;
            if (this._pre < 2) {
                this._pre = b === 0xFE ? this._pre + 1 : 0;
                continue;
            }
            if (b === 0xFD) {
                onFrame(Uint8Array.from(this._buf));
                this._buf.length = 0;
                this._pre = 0;
                continue;
            }
            if (b === 0xFE) {
                this._buf.length = 0;
                this._pre = 1;
                continue;
            }
            this._buf.push(b);
            if (this._buf.length > 32) {
                this._buf.length = 0;
                this._pre = 0;
            }
        }
    }
}

/**
 * Web Serial session. `connect()` needs a user click. DTR follows Morse elements
 * (USB Keying CW). RTS is USB SEND and stays high for the whole transmission,
 * which is what the radio requires when BK-IN is off.
 */
class Ic7300Cat {
    constructor(options) {
        const opts = options || {};
        this.onFrequency = opts.onFrequency || function () {};
        this.onMode = opts.onMode || function () {};
        this.onStatus = opts.onStatus || function () {};
        this.baud = opts.baud || CIV_BAUD_DEFAULT;
        this.port = null;
        this.connected = false;
        this.keepReading = false;
        this.parser = new CivParser();
        this._dtr = false;
        this._rts = false;
        this._linesSent = false;
        this.pttOnDtr = false;
        this._poll = null;
        this._reader = null;
        this._readDone = null;
        this._writeChain = Promise.resolve();
        this._signalChain = Promise.resolve();
    }

    setBaud(baud) {
        const n = CIV_BAUDS.indexOf(baud) >= 0 ? baud : CIV_BAUD_DEFAULT;
        this.baud = n;
        if (this.connected && this.port) return this._reopen();
        return Promise.resolve();
    }

    setFrequency(hz) {
        if (!this.connected) return;
        this._write(civSetFrequency(hz));
    }

    setMode(mode, filter) {
        if (!this.connected) return;
        this._write(civSetMode(mode, filter));
    }

    setKeySpeed(wpm) {
        if (!this.connected) return;
        this._write(civSetKeySpeed(wpm));
    }

    sendCw(text) {
        if (!this.connected) return false;
        const frame = civSendCw(text);
        if (!frame) return false;
        this._write(frame);
        return true;
    }

    async connect() {
        if (typeof navigator === 'undefined' || !navigator.serial) {
            this.onStatus('Web Serial is not available in this browser. Audio receive still works.', false);
            return false;
        }
        try {
            this.port = await navigator.serial.requestPort();
        } catch (e) {
            this.onStatus('CI-V port was not selected.', false);
            return false;
        }
        return this._open();
    }

    async disconnect() {
        await this.releaseKey();
        const port = this.port;
        await this._stopReader();
        if (port) {
            try { await port.close(); } catch (e) { /* already closed */ }
        }
        this.port = null;
        this.connected = false;
        this._linesSent = false;
        this.parser.reset();
        this.onStatus('CI-V disconnected.', false);
    }

    /** `ptt-dtr` puts USB SEND on DTR and the CW key on RTS. Default is PTT on RTS, CW on DTR. */
    setWiring(mode) {
        this.pttOnDtr = mode === 'ptt-dtr';
    }

    /**
     * @param {boolean} keyDown CW element
     * @param {boolean} sendHeld PTT for the whole transmission
     * SEND is raised one step before the key so the first dit is not lost when BK-IN is off.
     */
    setLines(keyDown, sendHeld) {
        const key = !!keyDown;
        const send = !!sendHeld;
        const swap = this.pttOnDtr;
        const d = swap ? send : key;
        const r = swap ? key : send;
        if (d === this._dtr && r === this._rts && this._linesSent) return this._signalChain;
        const sendWas = swap ? this._dtr : this._rts;
        this._dtr = d;
        this._rts = r;
        this._linesSent = true;
        if (send && key && !sendWas) this._enqueueSignals(swap, !swap);
        return this._enqueueSignals(d, r);
    }

    releaseKey() {
        this._dtr = false;
        this._rts = false;
        this._linesSent = true;
        return this._enqueueSignals(false, false);
    }

    /** Each edge is applied in order. Levels are captured so a later dit cannot erase an earlier one. */
    _enqueueSignals(dtr, rts) {
        this._signalChain = this._signalChain.then(() => {
            if (!this.port || !this.port.setSignals) return;
            return Promise.resolve(this.port.setSignals({
                dataTerminalReady: dtr,
                requestToSend: rts
            })).catch(() => {});
        });
        return this._signalChain;
    }

    _onFrame(body) {
        const msg = classifyCivFrame(body);
        if (!msg || msg.kind === 'echo') return;
        if (msg.kind === 'freq') this.onFrequency(msg.hz);
        else if (msg.kind === 'mode') this.onMode(msg.mode, msg.filter);
    }

    _write(bytes) {
        this._writeChain = this._writeChain.then(async () => {
            if (!this.port || !this.port.writable) return;
            const writer = this.port.writable.getWriter();
            try { await writer.write(bytes); }
            finally { writer.releaseLock(); }
        }).catch(() => {});
        return this._writeChain;
    }

    _pollOnce() {
        this._write(civCommand(0x03));
        this._write(civCommand(0x04));
    }

    async _stopReader() {
        this.keepReading = false;
        if (this._poll) {
            clearInterval(this._poll);
            this._poll = null;
        }
        if (this._reader) {
            try { await this._reader.cancel(); } catch (e) { /* already closed */ }
        }
        if (this._readDone) {
            try { await this._readDone; } catch (e) { /* loop ended */ }
            this._readDone = null;
        }
        this._reader = null;
    }

    async _reopen() {
        const port = this.port;
        if (!port) return false;
        await this._stopReader();
        try { await port.close(); } catch (e) { /* not open */ }
        this.port = port;
        return this._open();
    }

    async _open() {
        try {
            await this.port.open({
                baudRate: this.baud,
                dataBits: 8,
                stopBits: 1,
                parity: 'none'
            });
        } catch (e) {
            this.connected = false;
            this.onStatus((e && e.message) ? e.message : 'CI-V open failed.', false);
            return false;
        }
        this.connected = true;
        this.keepReading = true;
        this._dtr = false;
        this._rts = false;
        this._linesSent = false;
        await this.releaseKey();
        this.onStatus('CI-V ' + this.baud + ' baud.', true);
        this._pollOnce();
        if (this._poll) clearInterval(this._poll);
        this._poll = setInterval(() => this._pollOnce(), 750);
        this._readLoop();
        return true;
    }

    _readLoop() {
        this._readDone = this._readBody();
    }

    async _readBody() {
        while (this.keepReading && this.port && this.port.readable) {
            let reader;
            try {
                reader = this.port.readable.getReader();
            } catch (e) {
                break;
            }
            this._reader = reader;
            try {
                while (this.keepReading) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    if (value) this.parser.push(value, (frame) => this._onFrame(frame));
                }
            } catch (e) {
                if (this.keepReading) this.onStatus('CI-V read stopped.', false);
            } finally {
                this._reader = null;
                try { reader.releaseLock(); } catch (err) { /* released */ }
            }
        }
    }
}

if (typeof globalThis !== 'undefined') {
    globalThis.CIV_ADDR_IC7300 = CIV_ADDR_IC7300;
    globalThis.CIV_ADDR_CONTROLLER = CIV_ADDR_CONTROLLER;
    globalThis.CIV_BAUD_DEFAULT = CIV_BAUD_DEFAULT;
    globalThis.encodeFreqBcd = encodeFreqBcd;
    globalThis.decodeFreqBcd = decodeFreqBcd;
    globalThis.civCommand = civCommand;
    globalThis.civSetFrequency = civSetFrequency;
    globalThis.civSetMode = civSetMode;
    globalThis.civSetKeySpeed = civSetKeySpeed;
    globalThis.civSendCw = civSendCw;
    globalThis.civKeySpeedValue = civKeySpeedValue;
    globalThis.classifyCivFrame = classifyCivFrame;
    globalThis.CivParser = CivParser;
    globalThis.Ic7300Cat = Ic7300Cat;
}
if (typeof module !== 'undefined') {
    module.exports = {
        CIV_ADDR_IC7300, CIV_ADDR_CONTROLLER, CIV_BAUD_DEFAULT, CIV_BAUDS,
        encodeFreqBcd, decodeFreqBcd, civCommand, civSetFrequency, civSetMode,
        civSetKeySpeed, civSendCw, civKeySpeedValue, classifyCivFrame, CivParser, Ic7300Cat
    };
}
