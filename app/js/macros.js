/**
 * didahSDR - fldigi-style CW macro bar (F1..F4), three sets: QSO (you call CQ), QSO ANS (you answer
 * a CQ) and TEST (contest, with a serial counter).
 *
 * The top part is DOM-free (templates, expansion, sanitisers; tested in Node). `createMacroBar(ctx)`
 * wires the #macro-row controls: a macro is appended to #tx-text, TX is armed, and `log` / `bump`
 * flags add a logbook entry (logbook.js) or advance the contest counter.
 *
 * The 12 texts and labels are editable (gear button -> #macro-editor-window), stored in localStorage
 * `didah_macros` and exported / imported as JSON ({format: "didahSDR-macros", version: 1, sets}).
 *
 * Tokens: <MY_CALL>, <CALLER>, <MY_EXTRA>, <NR> expand to text. <LOG> (write a logbook entry) and
 * <INC> (+1 to the counter, after the text is expanded) are actions: they send nothing. <NR> is the counter padded to 3 digits and is also
 * expanded inside the Extra value, so Extra = "<NR>" sends the serial.
 */

const MACRO_KEYS = Object.freeze({ F1: 0, F2: 1, F3: 2, F4: 3 });
const CONTEST_NR_MIN = 1;
const CONTEST_NR_MAX = 9999;
const CALLSIGN_MAX = 14;
const EXTRA_MAX = 32;
const MY_CALL_DEFAULT = 'MY/CALL';

/** Flags come from the text: <LOG> writes a logbook entry, <INC> adds 1 to the counter. Filling <CALLER> or logging needs a caller. */
function macroDef(label, text) {
    const log = /<LOG>/.test(text);
    const bump = /<INC>/.test(text);
    return Object.freeze({ label, text, log, bump, needsCaller: log || text.includes('<CALLER>') });
}

const MACRO_SETS = Object.freeze({
    qso: Object.freeze({
        label: 'QSO',
        macros: Object.freeze([
            macroDef('CQ', 'CQ CQ DE <MY_CALL> <MY_CALL> <MY_CALL> K'),
            macroDef('ANS', '<CALLER> DE <MY_CALL> <MY_CALL> KN'),
            macroDef('DE', '<CALLER> DE <MY_CALL>'),
            macroDef('RST', '<CALLER> DE <MY_CALL> THX FER CALL = RST 599 599 = HW CPY? <CALLER> DE <MY_CALL> KN <LOG>'),
        ]),
    }),
    ans: Object.freeze({
        label: 'QSO ANS',
        macros: Object.freeze([
            macroDef('ANS', '<CALLER> DE <MY_CALL> <MY_CALL> K'),
            macroDef('RST', 'R R <CALLER> DE <MY_CALL> TNX FER RPRT = UR RST 599 599 = <CALLER> DE <MY_CALL> KN <LOG>'),
            macroDef('DE', '<CALLER> DE <MY_CALL>'),
            macroDef('73', 'TNX FER QSO 73 <CALLER> DE <MY_CALL> SK'),
        ]),
    }),
    test: Object.freeze({
        label: 'TEST',
        macros: Object.freeze([
            macroDef('CQ', 'TEST <MY_CALL> <MY_CALL>'),
            macroDef('ANS', '<MY_CALL>'),
            macroDef('RPRT', '5NN <MY_EXTRA> <LOG>'),
            macroDef('RRR', 'TU <INC>'),
        ]),
    }),
});

const MACRO_STORE_KEY = 'didah_macros';
const MACRO_FILE_FORMAT = 'didahSDR-macros';
const MACRO_FILE_VERSION = 1;
const MACRO_LABEL_MAX = 6;
const MACRO_TEXT_MAX = 200;

let activeMacroSets = MACRO_SETS;

function macroSet(mode) {
    return activeMacroSets[mode] || activeMacroSets.qso;
}

function setMacroSets(sets) {
    activeMacroSets = sets || MACRO_SETS;
}

/** Button label: uppercase, A-Z 0-9 '/' '?', at most 6 characters. */
function sanitizeMacroLabel(raw) {
    return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9/?]/g, '').slice(0, MACRO_LABEL_MAX);
}

/** Macro text: uppercase, one line, at most 200 characters (the TX box drops what CW cannot send). */
function sanitizeMacroText(raw) {
    return String(raw ?? '').toUpperCase().replace(/[\r\n\t]+/g, ' ').slice(0, MACRO_TEXT_MAX);
}

/**
 * Defaults with user {label, text} laid over, slot by slot. A missing or empty label keeps the default;
 * a text is taken as is (empty = the key sends nothing); its <LOG> / <INC> tokens set the flags.
 * @param {object} overrides  { qso: [{label, text}, ...], ans: [...], test: [...] }
 */
function applyMacroOverrides(overrides) {
    const out = {};
    for (const [mode, set] of Object.entries(MACRO_SETS)) {
        const user = overrides && Array.isArray(overrides[mode]) ? overrides[mode] : [];
        out[mode] = Object.freeze({
            label: set.label,
            macros: Object.freeze(set.macros.map((m, i) => {
                const u = user[i] && typeof user[i] === 'object' ? user[i] : {};
                const label = sanitizeMacroLabel(typeof u.label === 'string' ? u.label : '') || m.label;
                const text = typeof u.text === 'string' ? sanitizeMacroText(u.text).trim() : m.text;
                return macroDef(label, text);
            })),
        });
    }
    return Object.freeze(out);
}

/** The JSON document for export and localStorage. */
function macroDocument(sets = activeMacroSets) {
    const doc = { format: MACRO_FILE_FORMAT, version: MACRO_FILE_VERSION, sets: {} };
    for (const mode of Object.keys(MACRO_SETS)) {
        doc.sets[mode] = sets[mode].macros.map((m) => ({ label: m.label, text: m.text }));
    }
    return doc;
}

/** Parse an exported document (object or JSON text) into overrides. Throws with a readable message. */
function parseMacroDocument(input) {
    const doc = typeof input === 'string' ? JSON.parse(input) : input;
    if (!doc || typeof doc !== 'object' || doc.format !== MACRO_FILE_FORMAT || !doc.sets
        || typeof doc.sets !== 'object') {
        throw new Error('not a didahSDR macro file');
    }
    if (doc.version !== MACRO_FILE_VERSION) {
        throw new Error(`unsupported macro file version ${doc.version}`);
    }
    const out = {};
    for (const mode of Object.keys(MACRO_SETS)) {
        if (!Array.isArray(doc.sets[mode])) continue;
        out[mode] = doc.sets[mode].slice(0, 4);
    }
    return out;
}

/** Stored macros, or the defaults when there are none or they do not parse. */
function loadMacroSets(storage) {
    try {
        const raw = storage && storage.getItem(MACRO_STORE_KEY);
        if (raw) return applyMacroOverrides(parseMacroDocument(raw));
    } catch (e) { /* corrupt entry: defaults */ }
    return MACRO_SETS;
}

/** Uppercase, A-Z 0-9 and '/', at most 14 characters. */
function sanitizeCallsign(raw) {
    return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9/]/g, '').slice(0, CALLSIGN_MAX);
}

/** Uppercase, A-Z 0-9 '/' space and the angle brackets of the <NR> token, at most 32 characters. */
function sanitizeExtra(raw) {
    return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9/ <>]/g, '').slice(0, EXTRA_MAX);
}

function clampContestNr(n) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return CONTEST_NR_MIN;
    return Math.max(CONTEST_NR_MIN, Math.min(CONTEST_NR_MAX, v));
}

/** 7 -> "007", 1234 -> "1234". */
function formatContestNr(n) {
    return String(clampContestNr(n)).padStart(3, '0');
}

function expandMacro(tpl, vars = {}) {
    const nr = formatContestNr(vars.NR);
    const map = {
        MY_CALL: sanitizeCallsign(vars.MY_CALL),
        CALLER: sanitizeCallsign(vars.CALLER),
        MY_EXTRA: sanitizeExtra(vars.MY_EXTRA).replace(/<NR>/g, nr),
        NR: nr,
    };
    return String(tpl ?? '')
        .replace(/<(LOG|INC)>/g, '')
        .replace(/<(MY_CALL|CALLER|MY_EXTRA|NR)>/g, (_, k) => map[k])
        .replace(/<(LOG|INC)>/g, '')   // also when they came in through Extra
        .replace(/\s+/g, ' ')
        .trim();
}

/** Text box content after a macro: one space between the existing text and the macro. */
function appendMacroText(current, text) {
    const cur = String(current ?? '');
    if (!text) return cur;
    if (!cur.length || cur.endsWith(' ')) return cur + text;
    return `${cur} ${text}`;
}

function createMacroBar(ctx) {
    const { state } = ctx;
    const byId = (id) => document.getElementById(id);
    const row = byId('macro-row');
    const callerEl = byId('macro-caller');
    const modeEl = byId('macro-mode');
    const nrEl = byId('contest-nr');
    const myCallEl = byId('my-call-input');
    const myExtraEl = byId('my-extra-input');
    const buttons = [0, 1, 2, 3].map((i) => byId(`macro-f${i + 1}`));
    let flashTimer = null;

    /** Sanitise a text input in place, keeping the caret where the user typed. */
    const bindSanitized = (el, sanitize, onValue) => {
        if (!el) return;
        const apply = () => {
            const caret = el.selectionStart | 0;
            const cleaned = sanitize(el.value);
            if (cleaned !== el.value) {
                const pos = sanitize(el.value.slice(0, caret)).length;
                el.value = cleaned;
                try { el.selectionStart = el.selectionEnd = pos; } catch (e) { /* not focusable */ }
            }
            if (onValue) onValue(el.value);
        };
        apply();
        el.addEventListener('input', apply);
    };

    function relabel() {
        const set = macroSet(state.macroMode);
        buttons.forEach((btn, i) => {
            if (!btn) return;
            const m = set.macros[i];
            btn.textContent = `F${i + 1} ${m.label}`;
            btn.title = m.text + (m.log ? ' (logs the QSO)' : '') + (m.bump ? ' (+1 to the counter)' : '');
        });
    }

    function setContestNr(n) {
        state.contestNr = clampContestNr(n);
        if (nrEl) nrEl.textContent = formatContestNr(state.contestNr);
    }

    function flashCaller() {
        if (!callerEl) return;
        callerEl.classList.remove('is-flash');
        void callerEl.offsetWidth;   // restart the animation
        callerEl.classList.add('is-flash');
        callerEl.focus();
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => callerEl.classList.remove('is-flash'), 700);
    }

    /** F1..F4 (index 0..3). CW only, like the rest of TX. */
    function fireMacro(index) {
        if (state.modulation !== 'cw') return false;
        const m = macroSet(state.macroMode).macros[index];
        if (!m) return false;
        const caller = sanitizeCallsign(callerEl ? callerEl.value : '');
        if (m.needsCaller && !caller) {
            flashCaller();
            return false;
        }
        const vars = { MY_CALL: state.myCall, CALLER: caller, MY_EXTRA: state.myExtra, NR: state.contestNr };
        const text = expandMacro(m.text, vars);
        const txText = byId('tx-text');
        if (text && txText) {
            txText.value = appendMacroText(txText.value, text);
            txText.dispatchEvent(new Event('input', { bubbles: true }));   // tx_controller sanitises and feeds the keyer
            ctx.setTxArmed(true);
        }
        if (m.log && ctx.logbook) {
            ctx.logbook.add(createLogEntry({
                call: caller,
                date: new Date(),
                freqHz: ctx.currentDialHz(),
                modulation: state.modulation,
                extra: expandMacro('<MY_EXTRA>', vars),
            }));
        }
        if (m.bump) setContestNr(state.contestNr + 1);
        return true;
    }

    function updateMacroUi() {
        const cw = state.modulation === 'cw';
        if (row) row.classList.toggle('is-dimmed', !cw);
        buttons.forEach((btn) => { if (btn) btn.disabled = !cw; });
        if (callerEl) callerEl.disabled = !cw;
    }

    bindSanitized(callerEl, sanitizeCallsign);
    bindSanitized(myCallEl, sanitizeCallsign, (v) => { state.myCall = v; });
    bindSanitized(myExtraEl, sanitizeExtra, (v) => { state.myExtra = v; });
    if (modeEl) {
        modeEl.value = MACRO_SETS[state.macroMode] ? state.macroMode : 'qso';
        modeEl.addEventListener('change', () => {
            state.macroMode = MACRO_SETS[modeEl.value] ? modeEl.value : 'qso';
            relabel();
        });
    }
    buttons.forEach((btn, i) => {
        if (btn) btn.addEventListener('click', () => fireMacro(i));
    });
    const nrDown = byId('contest-nr-down');
    const nrUp = byId('contest-nr-up');
    if (nrDown) nrDown.addEventListener('click', () => setContestNr(state.contestNr - 1));
    if (nrUp) nrUp.addEventListener('click', () => setContestNr(state.contestNr + 1));

    let storage;
    try { storage = window.localStorage; } catch (e) { storage = null; }
    setMacroSets(loadMacroSets(storage));
    createMacroEditor(storage, relabel);

    setContestNr(state.contestNr);
    relabel();
    updateMacroUi();

    Object.assign(ctx, { fireMacro, setContestNr, updateMacroUi });
    return { fireMacro, setContestNr, updateMacroUi };
}

/** Gear button -> floating editor: one section per set, a label and a text per key, live-saved. */
function createMacroEditor(storage, onChange) {
    const byId = (id) => document.getElementById(id);
    const body = byId('macro-editor-sections');
    if (!body) return;
    setupFloatingWindow({
        windowId: 'macro-editor-window', headerId: 'macro-editor-header', closeBtnId: 'macro-editor-close-btn',
        toggleBtnId: 'macro-edit-btn', storageKey: 'didah_macro_editor_win', defaultVisible: false,
        defaultPos: { top: 'auto', bottom: '150px', left: '20px', right: 'auto' }
    });
    const statusEl = byId('macro-editor-status');
    const fields = {};    // mode -> [{ label, text }] inputs
    let statusTimer = null;

    const say = (msg) => {
        if (!statusEl) return;
        statusEl.textContent = msg;
        clearTimeout(statusTimer);
        statusTimer = setTimeout(() => { statusEl.textContent = ''; }, 4000);
    };
    const el = (tag, cls, text) => {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text) e.textContent = text;
        return e;
    };

    for (const [mode, set] of Object.entries(MACRO_SETS)) {
        const section = el('div', 'macro-ed-section');
        section.appendChild(el('div', 'macro-ed-title', set.label));
        fields[mode] = set.macros.map((m, i) => {
            const row = el('div', 'macro-ed-row');
            row.appendChild(el('span', 'macro-ed-key', `F${i + 1}`));
            const label = el('input', 'logbook-edit macro-ed-label');
            label.maxLength = MACRO_LABEL_MAX;
            label.placeholder = m.label;
            label.setAttribute('aria-label', `${set.label} F${i + 1} label`);
            const text = el('input', 'logbook-edit macro-ed-text');
            text.maxLength = MACRO_TEXT_MAX;
            text.spellcheck = false;
            text.setAttribute('aria-label', `${set.label} F${i + 1} text`);
            const flag = el('span', 'macro-ed-flag');
            for (const input of [label, text]) {
                input.type = 'text';
                input.autocomplete = 'off';
                input.addEventListener('input', () => {
                    const clean = (input === label ? sanitizeMacroLabel : sanitizeMacroText)(input.value);
                    if (clean !== input.value) {
                        const pos = input.selectionStart;
                        input.value = clean;
                        try { input.selectionStart = input.selectionEnd = pos; } catch (e) { /* not focused */ }
                    }
                    commit();
                });
            }
            row.appendChild(label);
            row.appendChild(text);
            row.appendChild(flag);
            section.appendChild(row);
            return { label, text, flag };
        });
        body.appendChild(section);
    }

    /** LOG / +NR tags from the tokens of the active macros. */
    function showFlags() {
        for (const mode of Object.keys(fields)) {
            fields[mode].forEach((f, i) => {
                const m = activeMacroSets[mode].macros[i];
                f.flag.textContent = [m.log ? 'LOG' : '', m.bump ? '+NR' : ''].filter(Boolean).join(' ');
                f.flag.title = [m.log ? '<LOG>: writes a logbook entry' : '',
                    m.bump ? '<INC>: adds 1 to the contest serial' : ''].filter(Boolean).join('\n');
            });
        }
    }

    function fill(sets) {
        for (const mode of Object.keys(fields)) {
            fields[mode].forEach((f, i) => {
                f.label.value = sets[mode].macros[i].label;
                f.text.value = sets[mode].macros[i].text;
            });
        }
        showFlags();
    }

    function persist() {
        try {
            if (activeMacroSets === MACRO_SETS) storage.removeItem(MACRO_STORE_KEY);
            else storage.setItem(MACRO_STORE_KEY, JSON.stringify(macroDocument()));
        } catch (e) { /* storage unavailable: this session only */ }
    }

    function commit() {
        const overrides = {};
        for (const mode of Object.keys(fields)) {
            overrides[mode] = fields[mode].map((f) => ({ label: f.label.value, text: f.text.value }));
        }
        setMacroSets(applyMacroOverrides(overrides));
        persist();
        showFlags();
        onChange();
    }

    function load(sets, msg) {
        setMacroSets(sets);
        fill(activeMacroSets);
        persist();
        onChange();
        say(msg);
    }

    const exportBtn = byId('macro-editor-export');
    const importBtn = byId('macro-editor-import');
    const fileEl = byId('macro-editor-file');
    const resetBtn = byId('macro-editor-reset');
    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            const blob = new Blob([JSON.stringify(macroDocument(), null, 2) + '\n'], { type: 'application/json' });
            const d = new Date();
            const z = (x) => String(x).padStart(2, '0');
            downloadBlob(`didahSDR_macros_${d.getUTCFullYear()}${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}.json`, blob);
        });
    }
    if (importBtn && fileEl) {
        importBtn.addEventListener('click', () => fileEl.click());
        fileEl.addEventListener('change', () => {
            const file = fileEl.files && fileEl.files[0];
            fileEl.value = '';
            if (!file) return;
            file.text().then((txt) => {
                load(applyMacroOverrides(parseMacroDocument(txt)), `Imported ${file.name}`);
            }).catch((e) => say(`Import failed: ${e.message}`));
        });
    }
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            if (window.confirm('Restore the default text of all 12 macros?')) load(MACRO_SETS, 'Defaults restored');
        });
    }
    fill(activeMacroSets);
}

if (typeof globalThis !== 'undefined') {
    globalThis.MACRO_KEYS = MACRO_KEYS;
    globalThis.createMacroBar = createMacroBar;
}
if (typeof module !== 'undefined') {
    module.exports = {
        MACRO_KEYS,
        MACRO_SETS,
        CONTEST_NR_MIN,
        CONTEST_NR_MAX,
        MY_CALL_DEFAULT,
        MACRO_STORE_KEY,
        macroSet,
        setMacroSets,
        sanitizeMacroLabel,
        sanitizeMacroText,
        applyMacroOverrides,
        macroDocument,
        parseMacroDocument,
        loadMacroSets,
        sanitizeCallsign,
        sanitizeExtra,
        clampContestNr,
        formatContestNr,
        expandMacro,
        appendMacroText,
        createMacroBar,
    };
}
