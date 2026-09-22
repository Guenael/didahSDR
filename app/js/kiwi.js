/**
 * didahSDR - KiwiSDR SND client (mod=iq)
 *
 * Binary frames start with a 3-byte tag (MSG / SND). IQ is big-endian int16
 * interleaved I/Q after a 10-byte GPS header. Unpack is allocation-free once
 * the destination Int16Array matches the payload size.
 */

const KIWI_SND_FLAG_STEREO = 0x08;
const KIWI_GPS_BYTES = 10;
const KIWI_SND_HEADER = 7; // flags u8 + seq u32le + smeter u16be
const KIWI_DEFAULT_PORT = 8073;
const KIWI_EXAMPLE_URL = 'http://oh5ae.dyndns.org:8073';

function kiwiHostForUrl(host) {
    return host.indexOf(':') >= 0 ? `[${host}]` : host;
}

function kiwiSndUrl(host, port, secure) {
    const scheme = secure ? 'wss' : 'ws';
    return `${scheme}://${kiwiHostForUrl(host)}:${port}/${Math.floor(Date.now() / 1000)}/SND`;
}

/**
 * Normalise a user-typed KiwiSDR web address into host / port / ws scheme.
 * Accepts with or without http(s)://, trailing slashes, and a path (path is ignored).
 * @returns {{ ok: true, host: string, port: number, secure: boolean, href: string } | { ok: false, error: string }}
 */
function normalizeKiwiUrl(input) {
    let raw = String(input == null ? '' : input).trim();
    if (!raw) return { ok: false, error: 'Enter a KiwiSDR URL.' };
    raw = raw.replace(/^['"]+|['"]+$/g, '').trim();
    raw = raw.replace(/\s+/g, '');
    if (!raw) return { ok: false, error: 'Enter a KiwiSDR URL.' };

    if (raw.startsWith('//')) raw = 'http:' + raw;
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) raw = 'http://' + raw;

    let url;
    try {
        url = new URL(raw);
    } catch (e) {
        return { ok: false, error: 'Invalid KiwiSDR URL.' };
    }

    const protocol = url.protocol.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:' && protocol !== 'ws:' && protocol !== 'wss:') {
        return { ok: false, error: 'Use an http(s) KiwiSDR address.' };
    }

    let host = (url.hostname || '').replace(/\.$/, '').toLowerCase();
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    if (!host) return { ok: false, error: 'Missing host.' };

    const secure = protocol === 'https:' || protocol === 'wss:';
    const port = kiwiPortFromAuthority(raw, secure);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { ok: false, error: 'Port must be 1–65535.' };
    }

    const href = `${secure ? 'https' : 'http'}://${kiwiHostForUrl(host)}:${port}`;
    return { ok: true, host, port, secure, href };
}

/** Port from the typed authority. WHATWG URL hides :80 / :443, so we scan the raw string. */
function kiwiPortFromAuthority(raw, secure) {
    const withoutScheme = raw.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
    const authority = withoutScheme.split(/[/?#]/)[0];
    const ipv6 = authority.match(/^\[(?:[^\]]+)\]:(\d+)$/);
    if (ipv6) return parseInt(ipv6[1], 10);
    if (authority.indexOf(']') < 0) {
        const colon = authority.lastIndexOf(':');
        if (colon > 0) {
            const digits = authority.slice(colon + 1);
            if (/^\d+$/.test(digits)) return parseInt(digits, 10);
        }
    }
    return secure ? 443 : KIWI_DEFAULT_PORT;
}

/** Parse a MSG payload (bytes after the 'MSG' tag). First body byte is skipped, as in kiwiclient. */
function parseKiwiMsg(body) {
    const start = body.length > 0 ? 1 : 0;
    let text = '';
    for (let i = start; i < body.length; i++) text += String.fromCharCode(body[i]);
    const out = {};
    const parts = text.trim().split(/\s+/);
    for (let i = 0; i < parts.length; i++) {
        const pair = parts[i];
        const eq = pair.indexOf('=');
        if (eq < 0) out[pair] = null;
        else out[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    return out;
}

/**
 * Unpack a full SND websocket payload (including the 'SND' tag) into little-endian Int16 I/Q.
 * @param {ArrayBuffer|Uint8Array} raw
 * @param {Int16Array} [dest] reused buffer; reallocated if the payload size changes
 * @returns {{ iq: Int16Array, rssi: number, flags: number, seq: number }}
 */
function unpackKiwiSndIq(raw, dest) {
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    let off = 0;
    if (bytes.length >= 3 && bytes[0] === 0x53 && bytes[1] === 0x4e && bytes[2] === 0x44) off = 3; // 'SND'
    if (bytes.length < off + KIWI_SND_HEADER + KIWI_GPS_BYTES + 4) {
        return { iq: dest && dest.length ? dest.subarray(0, 0) : new Int16Array(0), rssi: 0, flags: 0, seq: 0 };
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset + off, bytes.length - off);
    const flags = view.getUint8(0);
    const seq = view.getUint32(1, true);
    const smeter = view.getUint16(5, false);
    const rssi = 0.1 * smeter - 127;
    const payloadOff = KIWI_SND_HEADER + KIWI_GPS_BYTES;
    const payloadBytes = (bytes.length - off - payloadOff) & ~1;
    const n = payloadBytes >> 1;
    let iq = dest;
    if (!iq || iq.length !== n) iq = new Int16Array(n);
    for (let i = 0; i < n; i++) iq[i] = view.getInt16(payloadOff + i * 2, false);
    return { iq, rssi, flags, seq };
}

class KiwiConnection {
    constructor(options = {}) {
        this.host = options.host || 'localhost';
        this.port = options.port || KIWI_DEFAULT_PORT;
        this.secure = !!options.secure;
        this.password = options.password || '';
        this.ident = options.ident || 'didahSDR';
        this.lowCut = options.lowCut !== undefined ? options.lowCut : -5980;
        this.highCut = options.highCut !== undefined ? options.highCut : 5980;
        this.startFreqHz = options.startFreqHz || 7100000;

        this.ws = null;
        this.connected = false;
        this.handshakeComplete = false;
        this.reconnectTimer = null;
        this.reconnectInterval = 3000;
        this.keepaliveTimer = null;
        this.iqBuf = new Int16Array(0);
        this.sampleRate = 12000;
        this.ddcHz = this.startFreqHz;
        this._tunePending = false;
        this._lastTuneKey = '';
        this._wantConnect = false;
        this._arOk = false;
        this._haveSampleRate = false;
        this._iqSetupSent = false;

        this.onRawIQ = options.onRawIQ || null;
        this.onReady = options.onReady || null;             // ({ sampleRate, centerFreq }) => void
        this.onStatusChange = options.onStatusChange || null;
    }

    connect() {
        this._wantConnect = true;
        if (this.ws) this.disconnect(true);
        this.notifyStatus('Connecting...', false);
        const url = kiwiSndUrl(this.host, this.port, this.secure);
        try {
            this.ws = new WebSocket(url);
            this.ws.binaryType = 'arraybuffer';
            this.ws.onopen = () => {
                this.connected = true;
                this.notifyStatus('Handshaking...', false);
                this._send(`SET auth t=kiwi p=${this.password}`);
            };
            this.ws.onmessage = (event) => {
                if (typeof event.data === 'string') this._handleBytes(new TextEncoder().encode(event.data));
                else this._handleBytes(new Uint8Array(event.data));
            };
            this.ws.onclose = () => {
                this.connected = false;
                this.handshakeComplete = false;
                this._stopKeepalive();
                this.notifyStatus('Disconnected. Retrying...', false);
                this._scheduleReconnect();
            };
            this.ws.onerror = () => {
                this.connected = false;
                this.notifyStatus('Connection Error', false);
            };
        } catch (e) {
            console.error('Kiwi WebSocket failed:', e);
            this._scheduleReconnect();
        }
    }

    /**
     * @param {boolean} [keepWanted] if true, do not clear the reconnect intent (internal reconnect)
     */
    disconnect(keepWanted = false) {
        if (!keepWanted) this._wantConnect = false;
        clearReconnectTimer(this);
        this._stopKeepalive();
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
        this.handshakeComplete = false;
        this._arOk = false;
        this._haveSampleRate = false;
        this._iqSetupSent = false;
        this._lastTuneKey = '';
        if (!keepWanted) this.notifyStatus('Stopped', false);
    }

    tune(freqHz) {
        this.ddcHz = freqHz;
        if (this._tunePending) return;
        this._tunePending = true;
        const send = () => {
            this._tunePending = false;
            const key = `${Math.round(this.ddcHz)}|${this.lowCut}|${this.highCut}`;
            if (key === this._lastTuneKey) return;
            this._lastTuneKey = key;
            this._sendMod(this.ddcHz);
            if (this.onCenterApplied) this.onCenterApplied(Math.round(this.ddcHz));
        };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(send);
        else send();
    }

    _scheduleReconnect() {
        if (!this._wantConnect) return;
        armReconnect(this, this.reconnectInterval, () => {
            if (this._wantConnect) this.connect();
        });
    }

    _send(text) {
        if (this.ws && this.ws.readyState === 1) this.ws.send(text);
    }

    _sendMod(freqHz) {
        const khz = (freqHz / 1000).toFixed(3);
        this._send(`SET mod=iq low_cut=${this.lowCut} high_cut=${this.highCut} freq=${khz}`);
    }

    _startKeepalive() {
        this._stopKeepalive();
        this.keepaliveTimer = setInterval(() => this._send('SET keepalive'), 1000);
    }

    _stopKeepalive() {
        if (this.keepaliveTimer) {
            clearInterval(this.keepaliveTimer);
            this.keepaliveTimer = null;
        }
    }

    _handleBytes(bytes) {
        if (bytes.length < 3) return;
        const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2]);
        if (tag === 'MSG') this._handleMsg(parseKiwiMsg(bytes.subarray(3)));
        else if (tag === 'SND' && this.onRawIQ) {
            const unpacked = unpackKiwiSndIq(bytes, this.iqBuf);
            this.iqBuf = unpacked.iq;
            const n = unpacked.iq.length;
            if (n) {
                if (!this.f32 || this.f32.length !== n) this.f32 = new Float32Array(n);
                const scale = 1 / 32768;
                for (let i = 0; i < n; i++) this.f32[i] = unpacked.iq[i] * scale;
                this.onRawIQ(this.f32, n >> 1);
            }
        }
    }

    _sendIqSetup() {
        if (this._iqSetupSent || !this._arOk || !this._haveSampleRate) return;
        this._iqSetupSent = true;
        this._send('SET compression=0');
        this._send(`SET ident_user=${this.ident}`);
        this._sendMod(this.ddcHz);
        this._send('SET agc=1 hang=0 thresh=-90 slope=6 decay=1000 manGain=50');
        this._send('SET squelch=0 max=0');
        this._send('SET keepalive');
        this._startKeepalive();
        this.handshakeComplete = true;
        this.notifyStatus('Connected', true);
        if (this.onReady) this.onReady({ sampleRate: this.sampleRate, centerFreq: this.ddcHz });
    }

    _handleMsg(kv) {
        if (kv.audio_rate !== undefined) {
            const rate = parseInt(kv.audio_rate, 10);
            if (rate) this._send(`SET AR OK in=${rate} out=48000`);
            this._arOk = true;
            this._sendIqSetup();
        }
        if (kv.sample_rate !== undefined) {
            const sr = parseFloat(kv.sample_rate);
            if (sr > 0) {
                this.sampleRate = sr;
                this._haveSampleRate = true;
            }
            this._sendIqSetup();
        }
        if (kv.badp === '1' || kv.too_busy !== undefined) {
            this.notifyStatus('Kiwi busy or auth failed', false);
        }
    }

    notifyStatus(msg, isConnected) {
        if (this.onStatusChange) this.onStatusChange(msg, isConnected);
    }
}

if (typeof module !== 'undefined') {
    module.exports = {
        KiwiConnection, unpackKiwiSndIq, parseKiwiMsg, kiwiSndUrl, normalizeKiwiUrl,
        kiwiHostForUrl, KIWI_SND_FLAG_STEREO, KIWI_DEFAULT_PORT, KIWI_EXAMPLE_URL
    };
}
