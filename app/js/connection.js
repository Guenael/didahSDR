/**
 * didahSDR - WebSocket Connection Client
 */

class DidahConnection {
    constructor(options = {}) {
        this.url = options.url || this.getDefaultWsUrl();
        this.ws = null;
        this.connected = false;
        this.reconnectTimer = null;
        this.reconnectInterval = 3000;
        this.handshakeComplete = false;
        this.iqBuf = new Int16Array(0);   // reused receive buffer, reallocated only if the packet size changes

        // Callback hooks
        this.onRawIQ = options.onRawIQ || null;             // (Int16Array) => void (0x03 raw binary)
        this.onConfig = options.onConfig || null;           // (configObj) => void
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
                this.notifyStatus('Handshaking...', false);
                // Send handshake
                this.ws.send('SERVER DE CLIENT client=didahsdr version=1.0.0-cw type=receiver');
            };

            this.ws.onmessage = (event) => {
                if (typeof event.data === 'string') {
                    this.handleTextMessage(event.data);
                } else if (event.data instanceof ArrayBuffer) {
                    this.handleBinaryMessage(event.data);
                }
            };

            this.ws.onclose = () => {
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
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
        this.handshakeComplete = false;
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

    handleTextMessage(text) {
        if (text.startsWith('CLIENT DE SERVER')) {
            this.handshakeComplete = true;
            this.notifyStatus('Connected', true);
            return;
        }

        try {
            const msg = JSON.parse(text);
            if (msg.type === 'config' && this.onConfig) {
                this.onConfig(msg.value);
            }
            // 'modes' is sent by the server for protocol compatibility; the client uses its own mode table.
        } catch (e) {
            console.warn('Non-JSON text message received:', text);
        }
    }

    handleBinaryMessage(buffer) {
        if (buffer.byteLength < 1) return;
        const type = new Uint8Array(buffer, 0, 1)[0];
        if (type === 0x03 && this.onRawIQ) {
            // Raw 16-bit interleaved IQ [I0, Q0, I1, Q1, ...]. The 1-byte header misaligns the
            // payload, so it is copied into a reused, aligned Int16Array. The array handed to
            // onRawIQ is valid until the next packet (same contract as the demodulator output).
            const payloadBytes = buffer.byteLength - 1;
            if (this.iqBuf.byteLength !== payloadBytes) this.iqBuf = new Int16Array(payloadBytes >> 1);
            new Uint8Array(this.iqBuf.buffer).set(new Uint8Array(buffer, 1, payloadBytes & ~1));
            const n = this.iqBuf.length;
            if (!this.f32 || this.f32.length !== n) this.f32 = new Float32Array(n);
            const scale = 1 / 32768;
            for (let i = 0; i < n; i++) this.f32[i] = this.iqBuf[i] * scale;
            this.onRawIQ(this.f32, n >> 1);
        }
    }

    setStreamMode(mode) {
        if (this.ws && this.connected) {
            this.ws.send(JSON.stringify({
                type: 'set_stream_mode',
                mode: mode
            }));
        }
    }

    /** Informs the server of the current tuning; the test server ignores it, a real backend may not. */
    setDemodParams(params) {
        if (this.ws && this.connected) {
            this.ws.send(JSON.stringify({
                type: 'dspcontrol',
                params: params
            }));
        }
    }
}

if (typeof module !== 'undefined') module.exports = DidahConnection;
