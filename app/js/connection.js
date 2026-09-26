/**
 * didahSDR - replay / device link over WebSocket, protocol v1 (docs/protocol.md, codec in didah_proto.js).
 *
 * open -> HELLO -> DEVICE_INFO + STATUS (centre) -> onReady -> SET_RX_STREAM 1 -> RX_IQ.
 * RX_IQ carries a sample index: a gap (dropped packet) is zero-filled up to 250 ms and counted,
 * so the audio and waterfall keep their time base. PING every 2 s measures the round trip and
 * feeds the device's TX watchdog. TX: setPtt() and sendTxIq() (the frames come from txFrame()).
 */

const PING_INTERVAL_MS = 2000;
const GAP_FILL_MAX_S = 0.25;

class DidahConnection {
    constructor(options = {}) {
        this.url = options.url || this.getDefaultWsUrl();
        this.ws = null;
        this.connected = false;
        this.reconnectTimer = null;
        this.reconnectInterval = 3000;
        this.handshakeComplete = false;
        this.seq = 0;
        this.info = null;
        this.status = null;
        this.centerFreq = 0;
        this.ready = false;
        this.pingTimer = null;
        this.rttMs = 0;
        this.nextIndex = -1;       // expected RX sample index, -1 before the first packet
        this.rxIndex = 0;          // index after the last RX sample received
        this.stats = { packets: 0, gaps: 0, lostSamples: 0 };
        this.f32 = new Float32Array(0);
        this.zeros = new Float32Array(0);
        this.txFrameBuf = null;

        // Callback hooks
        this.onRawIQ = options.onRawIQ || null;             // (Float32Array interleaved ±1, nComplex) => void
        this.onReady = options.onReady || null;             // ({ sampleRate, centerFreq, info }) => void
        this.onCenterApplied = options.onCenterApplied || null; // (hz) => void, the device moved its LO
        this.onTelemetry = options.onTelemetry || null;     // (status) => void, STATUS messages
        this.onStatusChange = options.onStatusChange || null; // (statusStr, isConnected) => void
    }

    getDefaultWsUrl() {
        // Check query parameter ?ws=...
        if (typeof window !== 'undefined' && window.location) {
            const params = new URLSearchParams(window.location.search);
            if (params.has('ws')) {
                return params.get('ws');
            }
        }

        const loc = window.location;
        const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
        // Connect to /ws on current host, or fallback to port 9000 if opened via file://
        if (loc.host) {
            return `${proto}//${loc.host}/ws`;
        }
        return 'ws://localhost:9000/ws';
    }

    connect(targetUrl) {
        if (targetUrl) this.url = targetUrl;
        if (this.ws) {
            this.disconnect();
        }

        this.notifyStatus('Connecting...', false);

        try {
            this.ws = new WebSocket(this.url);
            this.ws.binaryType = 'arraybuffer';

            this.ws.onopen = () => {
                this.connected = true;
                this._resetSession();
                this.notifyStatus('Handshaking...', false);
                this.send(encodeHello(this._seq(), 'didahSDR web', PROTO.CAP.RX_IQ | PROTO.CAP.TX_IQ));
                this.pingTimer = setInterval(() => this.send(encodePing(this._seq(), Date.now())), PING_INTERVAL_MS);
            };

            this.ws.onmessage = (event) => {
                if (event.data instanceof ArrayBuffer) this.handleMessage(event.data);
            };

            this.ws.onclose = () => {
                this._stopPing();
                this.connected = false;
                this.handshakeComplete = false;
                this.notifyStatus('Disconnected. Retrying...', false);
                this.scheduleReconnect();
            };

            this.ws.onerror = (err) => {
                console.warn('WebSocket error:', err);
                this.connected = false;
                this.notifyStatus('Connection Error', false);
            };
        } catch (e) {
            console.error('Failed to instantiate WebSocket:', e);
            this.scheduleReconnect();
        }
    }

    disconnect() {
        clearReconnectTimer(this);
        this._stopPing();
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
        this.handshakeComplete = false;
        this.ready = false;
        this.notifyStatus('Stopped', false);
    }

    scheduleReconnect() {
        armReconnect(this, this.reconnectInterval, () => this.connect());
    }

    notifyStatus(msg, isConnected) {
        if (this.onStatusChange) {
            this.onStatusChange(msg, isConnected);
        }
    }

    _resetSession() {
        this.seq = 0;
        this.info = null;
        this.status = null;
        this.ready = false;
        this.nextIndex = -1;
        this.stats = { packets: 0, gaps: 0, lostSamples: 0 };
    }

    _stopPing() {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    _seq() {
        const s = this.seq;
        this.seq = (this.seq + 1) >>> 0;
        return s;
    }

    send(buffer) {
        if (!this.ws || !this.connected || this.ws.readyState !== 1) return false;
        this.ws.send(buffer);
        return true;
    }

    /** COMMAND (docs/protocol.md). The ACK / ERROR is logged, not awaited. */
    command(cmd, value, ackReq = true) {
        return this.send(encodeCommand(this._seq(), cmd, value, ackReq));
    }

    setPtt(on) {
        return this.command(PROTO.CMD.SET_PTT, on ? 1 : 0);
    }

    /** Interleaved int16 view of a reused TX_IQ frame for n complex samples. */
    txFrame(nComplex) {
        if (!this.txFrameBuf || this.txFrameBuf.nComplex !== nComplex) {
            this.txFrameBuf = allocStreamFrame(PROTO.TYPE.TX_IQ, nComplex);
        }
        return this.txFrameBuf.samples;
    }

    /** Send the frame returned by txFrame(); WebSocket.send copies it, so the buffer is reused. */
    sendTxIq(sampleIndex, sampleRate) {
        if (!this.txFrameBuf) return false;
        return this.send(writeStreamFrame(this.txFrameBuf, this._seq(), sampleIndex, sampleRate));
    }

    handleMessage(buffer) {
        const h = readProtoHeader(buffer);
        if (!h) return;
        if (h.verMajor !== PROTO.VER_MAJOR) {
            this.notifyStatus(`Protocol v${h.verMajor} not supported (v${PROTO.VER_MAJOR})`, false);
            this.disconnect();
            return;
        }
        const T = PROTO.TYPE;
        switch (h.type) {
            case T.RX_IQ:
                this._rxIq(buffer);
                break;
            case T.DEVICE_INFO:
                this.info = decodeDeviceInfo(buffer);
                this.handshakeComplete = true;
                break;
            case T.STATUS:
                this._status(decodeStatus(buffer));
                break;
            case T.PING:
                this.send(encodePing(this._seq(), new DataView(buffer).getUint32(24, true), true));
                break;
            case T.PONG:
                this.rttMs = ((Date.now() >>> 0) - new DataView(buffer).getUint32(24, true)) >>> 0;
                break;
            case T.ERROR: {
                const e = decodeError(buffer);
                console.warn('didah link: ERROR', e);
                break;
            }
            case T.EVENT:
                console.warn('didah link: EVENT', decodeEvent(buffer));
                break;
            default:
                break;    // ACK and unknown types (a newer minor) are ignored
        }
    }

    _status(st) {
        if (!st) return;
        this.status = st;
        if (!this.ready && this.info) {
            this.ready = true;
            this.centerFreq = st.freqHz;
            this.notifyStatus('Connected', true);
            if (this.onReady) this.onReady({ sampleRate: this.info.sampleRate, centerFreq: st.freqHz, info: this.info });
            this.command(PROTO.CMD.SET_RX_STREAM, 1);
        } else if (this.ready && st.freqHz !== this.centerFreq) {
            this.centerFreq = st.freqHz;
            if (this.onCenterApplied) this.onCenterApplied(st.freqHz);
        }
        if (this.onTelemetry) this.onTelemetry(st);
    }

    _rxIq(buffer) {
        const sh = decodeStreamHeader(buffer);
        if (!sh || sh.channels !== 2 || !this.onRawIQ) return;
        const off = PROTO.HEADER_BYTES + PROTO.STREAM_HEADER_BYTES;
        const n = Math.floor((buffer.byteLength - off) / protoSampleBytes(sh.format));
        if (n <= 0) return;
        this.stats.packets++;
        if (this.nextIndex >= 0 && sh.sampleIndex !== this.nextIndex) {
            const gap = sh.sampleIndex - this.nextIndex;
            this.stats.gaps++;
            if (gap > 0) {
                this.stats.lostSamples += gap;
                this._fillGap(gap, sh.sampleRate);
            }
        }
        this.nextIndex = sh.sampleIndex + n;
        this.rxIndex = this.nextIndex;

        // The 40-byte headers keep the samples aligned: a typed view, then one scaling pass.
        if (this.f32.length !== 2 * n) this.f32 = new Float32Array(2 * n);
        const f = this.f32;
        if (sh.format === PROTO.FMT.INT16) {
            const v = new Int16Array(buffer, off, 2 * n);
            for (let i = 0; i < 2 * n; i++) f[i] = v[i] * (1 / 32768);
        } else if (sh.format === PROTO.FMT.INT24) {
            const v = new Int32Array(buffer, off, 2 * n);
            for (let i = 0; i < 2 * n; i++) f[i] = v[i] * (1 / 8388608);
        } else if (sh.format === PROTO.FMT.FLOAT32) {
            f.set(new Float32Array(buffer, off, 2 * n));
        } else {
            return;
        }
        // Valid until the next packet (same contract as the demodulator output).
        this.onRawIQ(f, n);
    }

    /** Zeros for a dropped packet, so the timeline holds. Longer gaps are only counted. */
    _fillGap(gap, rate) {
        const max = Math.round(rate * GAP_FILL_MAX_S);
        if (gap > max) return;
        if (this.zeros.length < 2 * max) this.zeros = new Float32Array(2 * max);
        this.onRawIQ(this.zeros.subarray(0, 2 * gap), gap);
    }
}

if (typeof module !== 'undefined') module.exports = DidahConnection;
