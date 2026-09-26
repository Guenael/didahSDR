'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { req } = require('./load.js');

// logbook.js uses macros.js globals (sanitisers, MY_CALL placeholder), as in the page.
const macros = req('macros.js');
for (const k of ['sanitizeCallsign', 'sanitizeExtra', 'MY_CALL_DEFAULT']) global[k] = macros[k];
global.EXTRA_MAX = 32;
const {
    utcDateParts,
    createLogEntry,
    sanitizeLogbook,
    loadLogbook,
    adifField,
    hzToAdifMhz,
    toAdif,
    adifFileName,
} = req('logbook.js');

const DATE = new Date(Date.UTC(2026, 8, 6, 3, 4, 5));   // 2026-09-06 03:04:05Z

test('UTC date and time parts', () => {
    assert.deepEqual(utcDateParts(DATE), { date: '20260906', time: '030405' });
    assert.equal(adifFileName(DATE), 'didahSDR_log_20260906_030405Z.adi');
});

test('entry creation', () => {
    const e = createLogEntry({ call: 'f4kiy', date: DATE, freqHz: 14050800.4, modulation: 'cw', extra: '007' });
    assert.deepEqual(e, {
        call: 'F4KIY', qso_date: '20260906', time_off: '030405', freq_hz: 14050800,
        mode: 'CW', rst_sent: '599', rst_rcvd: '599', extra: '007',
    });
    assert.equal(createLogEntry({ call: 'X1', date: DATE, freqHz: 7, modulation: 'usb' }).mode, 'USB');
});

test('stored log: junk dropped, missing store is empty', () => {
    const ok = createLogEntry({ call: 'K1ABC', date: DATE, freqHz: 7030000, modulation: 'cw' });
    assert.deepEqual(sanitizeLogbook([ok, null, { call: '' }, { ...ok, qso_date: 'bad' }]), [ok]);
    assert.deepEqual(sanitizeLogbook('nope'), []);
    const storage = { getItem: () => null };
    assert.deepEqual(loadLogbook(storage), []);
    assert.deepEqual(loadLogbook({ getItem: () => '{' }), []);
});

test('ADIF fields use byte lengths and MHz', () => {
    assert.equal(adifField('CALL', 'F4KIY'), '<CALL:5>F4KIY');
    assert.equal(adifField('X', 'é'), '<X:2>é');
    assert.equal(hzToAdifMhz(14050800), '14.050800');
    assert.equal(hzToAdifMhz(7000001), '7.000001');
    assert.equal(hzToAdifMhz(475000), '0.475000');
});

test('ADIF export of one record', () => {
    const e = createLogEntry({ call: 'F4KIY', date: DATE, freqHz: 14050800, modulation: 'cw', extra: '007' });
    assert.equal(toAdif([e], { myCall: 'VA2GKA' }),
        'didahSDR ADIF export\n<ADIF_VER:5>3.1.4\n<PROGRAMID:8>didahSDR\n<EOH>\n'
        + '<CALL:5>F4KIY <QSO_DATE:8>20260906 <TIME_ON:6>030405 <TIME_OFF:6>030405 <FREQ:9>14.050800 '
        + '<MODE:2>CW <RST_SENT:3>599 <RST_RCVD:3>599 <STX_STRING:3>007 <STATION_CALLSIGN:6>VA2GKA <EOR>\n');
});

test('ADIF: no empty extra, SSB submode, placeholder callsign omitted', () => {
    const e = createLogEntry({ call: 'K1ABC', date: DATE, freqHz: 14250000, modulation: 'lsb' });
    const out = toAdif([e], { myCall: 'MY/CALL' });
    assert.ok(out.includes('<MODE:3>SSB <SUBMODE:3>LSB'));
    assert.ok(!out.includes('STX_STRING'));
    assert.ok(!out.includes('STATION_CALLSIGN'));
});
