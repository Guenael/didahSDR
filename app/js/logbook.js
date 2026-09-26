/**
 * didahSDR - QSO logbook: entries written by the macros that send a report (macros.js), shown in a
 * floating window (newest first, RST R and Extra editable) and exported as ADIF 3.1.4.
 *
 * Stored in localStorage under `didah_logbook` (array, oldest first), separate from didah_settings.
 * The top part is DOM-free and tested in Node; `createLogbook(ctx)` builds the window.
 */

const LOGBOOK_KEY = 'didah_logbook';
const LOGBOOK_MAX = 10000;

const pad2 = (n) => String(n).padStart(2, '0');

/** UTC 'YYYYMMDD' and 'HHMMSS'. */
function utcDateParts(date) {
    const d = date instanceof Date ? date : new Date(date);
    return {
        date: `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`,
        time: `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`,
    };
}

/** RST: uppercase digits / letters (5NN) and a sign, at most 6. */
function sanitizeRst(raw) {
    return String(raw ?? '').toUpperCase().replace(/[^0-9A-Z+-]/g, '').slice(0, 6);
}

const LOG_MODES = { cw: 'CW', usb: 'USB', lsb: 'LSB' };

function createLogEntry({ call, date = new Date(), freqHz, modulation, extra = '', rstSent = '599', rstRcvd = '599' }) {
    const t = utcDateParts(date);
    return {
        call: sanitizeCallsign(call),
        qso_date: t.date,
        time_off: t.time,
        freq_hz: Math.max(0, Math.round(Number(freqHz)) || 0),
        mode: LOG_MODES[String(modulation).toLowerCase()] || 'CW',
        rst_sent: sanitizeRst(rstSent),
        rst_rcvd: sanitizeRst(rstRcvd),
        extra: sanitizeExtra(extra),
    };
}

/** Stored entry -> clean entry, or null when it is not one. */
function sanitizeLogEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const call = sanitizeCallsign(raw.call);
    const date = String(raw.qso_date ?? '');
    const time = String(raw.time_off ?? '');
    if (!call || !/^\d{8}$/.test(date) || !/^\d{6}$/.test(time)) return null;
    const mode = String(raw.mode ?? '').toUpperCase();
    return {
        call,
        qso_date: date,
        time_off: time,
        freq_hz: Math.max(0, Math.round(Number(raw.freq_hz)) || 0),
        mode: mode === 'USB' || mode === 'LSB' ? mode : 'CW',
        rst_sent: sanitizeRst(raw.rst_sent),
        rst_rcvd: sanitizeRst(raw.rst_rcvd),
        extra: sanitizeExtra(raw.extra),
    };
}

function sanitizeLogbook(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const r of raw) {
        const e = sanitizeLogEntry(r);
        if (e) out.push(e);
    }
    return out.slice(-LOGBOOK_MAX);
}

function loadLogbook(storage, key = LOGBOOK_KEY) {
    let raw = null;
    try {
        const text = storage.getItem(key);
        if (text) raw = JSON.parse(text);
    } catch (e) { /* corrupt or unavailable */ }
    return sanitizeLogbook(raw);
}

/** `<NAME:len>value`, len in bytes (ADIF). */
function adifField(name, value) {
    const v = String(value);
    return `<${name}:${new TextEncoder().encode(v).length}>${v}`;
}

/** 14050800 -> "14.050800" (integer maths, no float rounding). */
function hzToAdifMhz(hz) {
    const n = Math.max(0, Math.round(Number(hz)) || 0);
    return `${Math.floor(n / 1000000)}.${String(n % 1000000).padStart(6, '0')}`;
}

/**
 * ADIF 3.1.4 text. USB/LSB are MODE SSB + SUBMODE (the ADIF mode list has no USB/LSB mode).
 * STATION_CALLSIGN is omitted while the operator callsign is still the MY/CALL placeholder.
 */
function toAdif(entries, { myCall = '' } = {}) {
    const station = sanitizeCallsign(myCall);
    const withStation = station && station !== MY_CALL_DEFAULT;
    let out = 'didahSDR ADIF export\n'
        + `${adifField('ADIF_VER', '3.1.4')}\n${adifField('PROGRAMID', 'didahSDR')}\n<EOH>\n`;
    for (const e of entries) {
        const f = [
            adifField('CALL', e.call),
            adifField('QSO_DATE', e.qso_date),
            adifField('TIME_ON', e.time_off),
            adifField('TIME_OFF', e.time_off),
            adifField('FREQ', hzToAdifMhz(e.freq_hz)),
        ];
        if (e.mode === 'USB' || e.mode === 'LSB') f.push(adifField('MODE', 'SSB'), adifField('SUBMODE', e.mode));
        else f.push(adifField('MODE', 'CW'));
        if (e.rst_sent) f.push(adifField('RST_SENT', e.rst_sent));
        if (e.rst_rcvd) f.push(adifField('RST_RCVD', e.rst_rcvd));
        if (e.extra) f.push(adifField('STX_STRING', e.extra));
        if (withStation) f.push(adifField('STATION_CALLSIGN', station));
        out += `${f.join(' ')} <EOR>\n`;
    }
    return out;
}

function adifFileName(date = new Date()) {
    const t = utcDateParts(date);
    return `didahSDR_log_${t.date}_${t.time}Z.adi`;
}

function saveTextFile(text, name, type) {
    const blob = new Blob([text], { type });
    if (typeof downloadBlob === 'function') {   // cw_recorder.js
        downloadBlob(name, blob);
        return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function createLogbook(ctx) {
    const byId = (id) => document.getElementById(id);
    const listEl = byId('logbook-list');
    const emptyEl = byId('logbook-empty');
    const countEl = byId('logbook-count');
    const exportBtn = byId('logbook-export');
    const clearBtn = byId('logbook-clear');

    setupFloatingWindow({
        windowId: 'logbook-window', headerId: 'logbook-header', closeBtnId: 'logbook-close-btn',
        toggleBtnId: 'logbook-btn', storageKey: 'didah_logbook_win', defaultVisible: false,
        defaultPos: { top: 'auto', bottom: '150px', left: 'auto', right: '20px' }
    });

    let storage;
    try { storage = window.localStorage; } catch (e) { storage = null; }
    if (!storage) storage = { getItem: () => null, setItem: () => {} };
    let entries = loadLogbook(storage);

    const persist = () => {
        try { storage.setItem(LOGBOOK_KEY, JSON.stringify(entries)); } catch (e) { /* storage unavailable */ }
    };

    const cell = (tr, text, cls) => {
        const td = document.createElement('td');
        if (cls) td.className = cls;
        td.textContent = text;
        tr.appendChild(td);
        return td;
    };
    const editCell = (tr, entry, field, sanitize, maxLength, label) => {
        const td = document.createElement('td');
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'logbook-edit';
        input.maxLength = maxLength;
        input.spellcheck = false;
        input.autocomplete = 'off';
        input.setAttribute('aria-label', label);
        input.value = entry[field];
        input.addEventListener('input', () => {
            const v = sanitize(input.value);
            if (v !== input.value) input.value = v;
        });
        input.addEventListener('change', () => {
            entry[field] = sanitize(input.value);
            input.value = entry[field];
            persist();
        });
        td.appendChild(input);
        tr.appendChild(td);
    };
    const freqText = (hz) => (typeof formatVfoHz === 'function' ? formatVfoHz(hz) : String(hz));

    function render() {
        if (!listEl) return;
        listEl.textContent = '';
        for (let i = entries.length - 1; i >= 0; i--) {
            const e = entries[i];
            const tr = document.createElement('tr');
            cell(tr, e.call, 'logbook-call');
            cell(tr, `${e.qso_date.slice(0, 4)}-${e.qso_date.slice(4, 6)}-${e.qso_date.slice(6)}`);
            cell(tr, `${e.time_off.slice(0, 2)}:${e.time_off.slice(2, 4)}:${e.time_off.slice(4)}`);
            cell(tr, freqText(e.freq_hz), 'logbook-freq');
            cell(tr, e.mode);
            cell(tr, e.rst_sent);
            editCell(tr, e, 'rst_rcvd', sanitizeRst, 6, 'RST received');
            editCell(tr, e, 'extra', sanitizeExtra, EXTRA_MAX, 'Exchange');
            const td = document.createElement('td');
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'vfo-mem-del';
            del.textContent = '✕';
            del.title = `Delete the QSO with ${e.call}`;
            del.addEventListener('click', () => {
                const idx = entries.indexOf(e);
                if (idx === -1) return;
                entries.splice(idx, 1);
                persist();
                render();
            });
            td.appendChild(del);
            tr.appendChild(td);
            listEl.appendChild(tr);
        }
        if (emptyEl) emptyEl.style.display = entries.length ? 'none' : '';
        if (countEl) countEl.textContent = entries.length === 1 ? '1 QSO' : `${entries.length} QSOs`;
        if (exportBtn) exportBtn.disabled = !entries.length;
        if (clearBtn) clearBtn.disabled = !entries.length;
    }

    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            if (!entries.length) return;
            const text = toAdif(entries, { myCall: ctx.state.myCall });
            saveTextFile(text, adifFileName(new Date()), 'text/plain');
        });
    }
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            if (!entries.length) return;
            if (!window.confirm(`Delete all ${entries.length} logged QSOs?`)) return;
            entries = [];
            persist();
            render();
        });
    }

    render();

    const api = {
        add(entry) {
            const e = sanitizeLogEntry(entry);
            if (!e) return false;
            entries.push(e);
            if (entries.length > LOGBOOK_MAX) entries.splice(0, entries.length - LOGBOOK_MAX);
            persist();
            render();
            return true;
        },
        entries: () => entries.slice(),
    };
    ctx.logbook = api;
    return api;
}

if (typeof globalThis !== 'undefined') {
    globalThis.createLogEntry = createLogEntry;
    globalThis.createLogbook = createLogbook;
}
if (typeof module !== 'undefined') {
    module.exports = {
        LOGBOOK_KEY,
        LOGBOOK_MAX,
        utcDateParts,
        sanitizeRst,
        createLogEntry,
        sanitizeLogEntry,
        sanitizeLogbook,
        loadLogbook,
        adifField,
        hzToAdifMhz,
        toAdif,
        adifFileName,
        createLogbook,
    };
}
