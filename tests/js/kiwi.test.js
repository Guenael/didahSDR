'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { req } = require('./load.js');
const { unpackKiwiSndIq, parseKiwiMsg, kiwiSndUrl, normalizeKiwiUrl, kiwiHostForUrl,
        KiwiConnection, KIWI_EXAMPLE_URL, KIWI_DEFAULT_PORT } = req('kiwi.js');
const { findSource, SOURCES } = req('sources.js');

function buildSndFrame({ i = 1000, q = -2000, n = 4, flags = 0x08, seq = 7, smeter = 800 }) {
    const gps = 10;
    const header = 7;
    const payload = n * 2 * 2; // n complex * 2 int16 * 2 bytes
    const buf = new Uint8Array(3 + header + gps + payload);
    buf[0] = 0x53; buf[1] = 0x4e; buf[2] = 0x44; // SND
    buf[3] = flags;
    buf[4] = seq & 0xff; buf[5] = (seq >> 8) & 0xff; buf[6] = (seq >> 16) & 0xff; buf[7] = (seq >> 24) & 0xff;
    buf[8] = (smeter >> 8) & 0xff; buf[9] = smeter & 0xff;
    const view = new DataView(buf.buffer);
    for (let k = 0; k < n; k++) {
        const off = 3 + header + gps + k * 4;
        view.setInt16(off, i, false);
        view.setInt16(off + 2, q, false);
    }
    return buf;
}

test('catalog default is VA2GKA replay; kiwi live defaults to F4KIY at 7.1 MHz', () => {
    assert.equal(SOURCES[0].id, 'va2gka');
    assert.equal(SOURCES[0].protocol, 'didah');
    const live = findSource('f4kiy');
    assert.equal(live.protocol, 'kiwi');
    assert.equal(live.host, 'f4kiy.ddns.net');
    assert.equal(live.port, 8073);
    assert.equal(live.secure, false);
    assert.equal(live.startFreq, 7100000);
    assert.equal(live.startMod, 'cw');
    assert.equal(findSource('missing').id, 'va2gka');
    assert.equal(findSource('soundcard').protocol, 'soundcard');
    assert.equal(findSource('soundcard').startFreq, 0);
});

test('normalizeKiwiUrl strips http(s), path, and whitespace then splits host/port', () => {
    const example = normalizeKiwiUrl(KIWI_EXAMPLE_URL);
    assert.equal(example.ok, true);
    assert.equal(example.host, 'f4kiy.ddns.net');
    assert.equal(example.port, 8073);
    assert.equal(example.secure, false);
    assert.equal(example.href, 'http://f4kiy.ddns.net:8073');

    const messy = normalizeKiwiUrl('  HTTP://F4KIY.DDNS.NET:8073/kiwi/?x=1  ');
    assert.equal(messy.ok, true);
    assert.equal(messy.host, 'f4kiy.ddns.net');
    assert.equal(messy.port, 8073);
    assert.equal(messy.href, 'http://f4kiy.ddns.net:8073');

    const bare = normalizeKiwiUrl('f4kiy.ddns.net:8073');
    assert.equal(bare.ok, true);
    assert.equal(bare.host, 'f4kiy.ddns.net');
    assert.equal(bare.port, KIWI_DEFAULT_PORT);

    const ironstone = normalizeKiwiUrl('sdr.ironstonerange.com:8076');
    assert.equal(ironstone.ok, true);
    assert.equal(ironstone.host, 'sdr.ironstonerange.com');
    assert.equal(ironstone.port, 8076);
    assert.equal(ironstone.href, 'http://sdr.ironstonerange.com:8076');

    const noPort = normalizeKiwiUrl('http://kiwi.example.com');
    assert.equal(noPort.ok, true);
    assert.equal(noPort.port, KIWI_DEFAULT_PORT);
    assert.equal(noPort.href, 'http://kiwi.example.com:8073');

    const tls = normalizeKiwiUrl('https://kiwi.example.com:443/');
    assert.equal(tls.ok, true);
    assert.equal(tls.secure, true);
    assert.equal(tls.port, 443);
    assert.equal(tls.href, 'https://kiwi.example.com:443');

    const protoRel = normalizeKiwiUrl('//f4kiy.ddns.net:8073');
    assert.equal(protoRel.ok, true);
    assert.equal(protoRel.host, 'f4kiy.ddns.net');

    const ipv6 = normalizeKiwiUrl('http://[2001:db8::1]:8073/');
    assert.equal(ipv6.ok, true);
    assert.equal(ipv6.host, '2001:db8::1');
    assert.equal(ipv6.port, 8073);
    assert.equal(ipv6.href, 'http://[2001:db8::1]:8073');

    const quoted = normalizeKiwiUrl('"http://f4kiy.ddns.net:8073"');
    assert.equal(quoted.ok, true);
    assert.equal(quoted.host, 'f4kiy.ddns.net');

    assert.equal(normalizeKiwiUrl('').ok, false);
    assert.equal(normalizeKiwiUrl('ftp://f4kiy.ddns.net:8073').ok, false);
    assert.equal(normalizeKiwiUrl('http://').ok, false);
});

test('kiwiSndUrl uses unix seconds and /SND; https becomes wss and IPv6 is bracketed', () => {
    const url = kiwiSndUrl('f4kiy.ddns.net', 8073);
    assert.match(url, /^ws:\/\/f4kiy\.ddns\.net:8073\/\d+\/SND$/);
    const secure = kiwiSndUrl('f4kiy.ddns.net', 8073, true);
    assert.match(secure, /^wss:\/\/f4kiy\.ddns\.net:8073\/\d+\/SND$/);
    assert.equal(kiwiHostForUrl('2001:db8::1'), '[2001:db8::1]');
    assert.match(kiwiSndUrl('2001:db8::1', 8073), /^ws:\/\/\[2001:db8::1\]:8073\/\d+\/SND$/);
});

test('parseKiwiMsg skips the leading flag byte then splits key=value pairs', () => {
    const body = Uint8Array.from([0x00, ...Buffer.from('audio_rate=12000 sample_rate=11998.8')]);
    const kv = parseKiwiMsg(body);
    assert.equal(kv.audio_rate, '12000');
    assert.equal(kv.sample_rate, '11998.8');
});

test('unpackKiwiSndIq byte-swaps BE stereo IQ after the GPS header', () => {
    const raw = buildSndFrame({ i: 12345, q: -23456, n: 8, seq: 42, smeter: 900 });
    const dest = new Int16Array(0);
    const a = unpackKiwiSndIq(raw, dest);
    assert.equal(a.seq, 42);
    assert.equal(a.iq.length, 16);
    assert.equal(a.iq[0], 12345);
    assert.equal(a.iq[1], -23456);
    assert.ok(Math.abs(a.rssi - (0.1 * 900 - 127)) < 1e-9);

    const b = unpackKiwiSndIq(raw, a.iq);
    assert.equal(b.iq, a.iq, 'destination buffer is reused when the size matches');
});

test('KiwiConnection sends AR OK then IQ setup only after both handshake messages', () => {
    const sent = [];
    const k = new KiwiConnection({ startFreqHz: 7100000 });
    k.ws = { readyState: 1, send: (t) => sent.push(t) };
    k._startKeepalive = () => {};

    k._handleMsg({ sample_rate: '11998.8' });
    assert.equal(k.handshakeComplete, false);
    assert.equal(sent.length, 0);

    k._handleMsg({ audio_rate: '12000' });
    assert.equal(k.handshakeComplete, true);
    assert.equal(k.sampleRate, 11998.8);
    assert.ok(sent.some((s) => s.startsWith('SET AR OK in=12000')));
    assert.ok(sent.some((s) => s.includes('SET mod=iq') && s.includes('freq=7100.000')));
});
