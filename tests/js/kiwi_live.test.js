'use strict';
/**
 * Optional live smoke: DIDAH_LIVE=1 node --test tests/js/kiwi_live.test.js
 * Skips when the env var is unset so CI does not depend on F4KIY being reachable.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { req } = require('./load.js');
const { unpackKiwiSndIq, kiwiSndUrl, parseKiwiMsg } = req('kiwi.js');

test('F4KIY live SND delivers BE IQ after auth + AR OK + mod=iq', { skip: process.env.DIDAH_LIVE !== '1' }, async () => {
    const WebSocket = global.WebSocket;
    assert.ok(WebSocket, 'Node WebSocket is required for the live probe');

    const url = kiwiSndUrl('f4kiy.ddns.net', 8073);
    // Node's WebSocket omits Origin; F4KIY will not start SND without one.
    const ws = new WebSocket(url, { headers: { Origin: 'http://localhost:8073' } });
    ws.binaryType = 'arraybuffer';

    let sampleRate = 0;
    let iq = null;
    let arOk = false;
    let setupSent = false;
    const done = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('F4KIY handshake timed out')), 12000);
        const maybeSetup = () => {
            if (setupSent || !arOk || !sampleRate) return;
            setupSent = true;
            ws.send('SET compression=0');
            ws.send('SET ident_user=didahSDR-test');
            ws.send('SET mod=iq low_cut=-5980 high_cut=5980 freq=7100.000');
            ws.send('SET agc=1 hang=0 thresh=-90 slope=6 decay=1000 manGain=50');
            ws.send('SET squelch=0 max=0');
            ws.send('SET keepalive');
        };
        ws.addEventListener('error', () => {
            clearTimeout(timer);
            reject(new Error('F4KIY WebSocket error'));
        });
        ws.addEventListener('message', (event) => {
            const bytes = typeof event.data === 'string'
                ? new TextEncoder().encode(event.data)
                : new Uint8Array(event.data);
            if (bytes.length < 3) return;
            const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2]);
            if (tag === 'MSG') {
                const kv = parseKiwiMsg(bytes.subarray(3));
                if (kv.audio_rate) {
                    ws.send(`SET AR OK in=${parseInt(kv.audio_rate, 10)} out=48000`);
                    arOk = true;
                    maybeSetup();
                }
                if (kv.sample_rate) {
                    sampleRate = parseFloat(kv.sample_rate);
                    maybeSetup();
                }
            } else if (tag === 'SND') {
                const unpacked = unpackKiwiSndIq(bytes);
                if (unpacked.iq.length >= 64) {
                    iq = unpacked.iq;
                    clearTimeout(timer);
                    resolve();
                }
            }
        });
        ws.addEventListener('open', () => ws.send('SET auth t=kiwi p='));
    });

    try {
        await done;
        assert.ok(sampleRate > 11000 && sampleRate < 13000, `sample_rate ${sampleRate}`);
        assert.ok(iq && iq.length >= 64);
        let peak = 0;
        for (let i = 0; i < iq.length; i++) {
            const a = Math.abs(iq[i]);
            if (a > peak) peak = a;
        }
        assert.ok(peak > 0, 'IQ payload is not all zeros');
    } finally {
        ws.close();
    }
});
