/**
 * didahSDR - operator settings, persisted in localStorage under `didah_settings`.
 *
 * Saved: everything the operator sets in the panels and the Source window. Not saved: the tuned
 * frequency and mode (they come from the source) and the power state. Restoring goes through the
 * controls themselves (set the value, dispatch its event), so each setting has one apply path.
 *
 * `createSettingsStore` is the DOM-free core: a list of fields { name, save() -> value|undefined,
 * load(value) }, restored in list order. `appSettingsFields(ctx)` is the page's field table; the
 * names are the stored JSON keys, so renaming one drops that setting for existing users.
 *
 * Not named settings*.js: common reverse-proxy hardening rules drop requests for /settings and
 * settings.js (exploit probes) without a response, which broke a deployment behind nginx.
 */

const SETTINGS_KEY = 'didah_settings';

function createSettingsStore({ storage, key = SETTINGS_KEY, fields }) {
    function read() {
        let saved;
        try { saved = JSON.parse(storage.getItem(key) || 'null'); } catch (e) { saved = null; }
        return saved && typeof saved === 'object' ? saved : null;
    }

    return {
        /** Apply the stored values in field order. Missing keys keep the page defaults. */
        load() {
            const saved = read();
            if (!saved) return false;
            for (const f of fields) {
                if (saved[f.name] === undefined) continue;
                try { f.load(saved[f.name]); } catch (e) { console.warn(`didahSDR: setting ${f.name} not restored`, e); }
            }
            return true;
        },
        save() {
            const out = {};
            for (const f of fields) {
                const v = f.save();
                if (v !== undefined) out[f.name] = v;
            }
            try { storage.setItem(key, JSON.stringify(out)); } catch (e) { /* storage unavailable */ }
            return out;
        }
    };
}

/** The page's settings, in restore order. */
function appSettingsFields(ctx) {
    const { state } = ctx;
    const byId = (id) => document.getElementById(id);

    /** A slider or select whose own input/change handler applies the value. */
    const control = (name, id, evt) => ({
        name,
        save: () => state[name],
        load: (v) => {
            const el = byId(id);
            if (!el) return;
            el.value = String(v);
            if (el.tagName === 'SELECT' && el.value !== String(v)) return;   // option no longer exists
            el.dispatchEvent(new Event(evt, { bubbles: true }));
        }
    });
    /** An ON/OFF button backed by a state flag and its setter. */
    const toggle = (name, set) => ({
        name,
        save: () => state[name],
        load: (v) => { if (v !== state[name]) set(!!v); }
    });
    /** A plain form value read by the source code when it connects (no event). */
    const value = (name, id, { saveIf = () => true, loadIf = (v) => v != null } = {}) => ({
        name,
        save: () => { const el = byId(id); return el && saveIf(el) ? el.value : undefined; },
        load: (v) => { const el = byId(id); if (el && loadIf(v)) el.value = String(v); }
    });
    /** A device <select> filled later by enumerateDevices: keep the id as a placeholder option. */
    const device = (name, id) => ({
        name,
        save: () => { const el = byId(id); return el && el.value ? el.value : undefined; },
        load: (v) => {
            const el = byId(id);
            if (!el || !v) return;
            el.appendChild(new Option('Saved device', v));
            el.value = v;
        }
    });
    const checkbox = (name, id) => ({
        name,
        save: () => { const el = byId(id); return el ? !!el.checked : undefined; },
        load: (v) => { const el = byId(id); if (el && v) el.checked = true; }
    });

    return [
        control('volume', 'vol-slider', 'input'),
        control('minLevel', 'min-lvl-slider', 'input'),
        control('dynamicRange', 'dyn-range-slider', 'input'),
        control('speedMultiplier', 'speed-slider', 'input'),
        control('cwOffset', 'cw-offset-slider', 'input'),
        control('cwBandwidth', 'cw-bw-slider', 'input'),
        control('ssbLow', 'ssb-low-slider', 'input'),
        control('ssbHigh', 'ssb-high-slider', 'input'),
        control('stepSize', 'step-select', 'change'),
        control('fftSize', 'fft-select', 'change'),
        control('primaryTheme', 'theme-select', 'change'),
        control('agcSpeed', 'agc-select', 'change'),
        control('filterKernel', 'kernel-select', 'change'),
        control('wpm', 'wpm-slider', 'input'),
        control('autonotchDepth', 'autonotch-depth-slider', 'input'),
        control('nrStrength', 'nr-strength-slider', 'input'),
        control('squelchMargin', 'squelch-thr-slider', 'input'),
        toggle('filterEnabled', (on) => ctx.setCwFilterEnabled(on)),
        toggle('qrssEnabled', (on) => ctx.setQrssEnabled(on)),
        toggle('autonotchEnabled', (on) => ctx.setAutonotchEnabled(on)),
        toggle('nrEnabled', (on) => ctx.setNrEnabled(on)),
        toggle('squelchEnabled', (on) => ctx.setSquelchEnabled(on)),
        {
            name: 'iambicMode',
            save: () => state.iambicMode,
            load: (v) => {
                if (v !== 'A' && v !== 'B') return;
                const el = document.querySelector(`input[name="iambic-mode"][value="${v}"]`);
                if (!el) return;
                el.checked = true;
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
        },
        {
            // Only pre-selects the radio; app.js starts that source after all settings are in.
            name: 'selectedSourceId',
            save: () => state.selectedSourceId,
            load: (v) => {
                // f4kiy was the Kiwi preset id; va2gka was the replay source id.
                const id = v === 'f4kiy' ? 'oh5ae' : v === 'va2gka' ? 'replay_server' : v;
                const el = id && document.querySelector(`input[name="iq-source"][value="${id}"]`);
                if (el) el.checked = true;
            }
        },
        value('kiwiUrl', 'kiwi-url', { loadIf: (v) => !!v }),
        device('soundDeviceId', 'sound-device'),
        checkbox('iqSwap', 'sound-iq-swap'),
        value('ic7300Baud', 'ic7300-baud', { loadIf: (v) => !!v }),
        value('ic7300Wiring', 'ic7300-wiring', { loadIf: (v) => v === 'ptt-dtr' || v === 'ptt-rts' }),
        device('ic7300DeviceId', 'ic7300-device'),
        value('rtlMode', 'rtlsdr-mode', { loadIf: (v) => !!v }),
        value('rtlGain', 'rtlsdr-gain'),
        value('rtlPpm', 'rtlsdr-ppm'),
        value('rtlUpconverter', 'rtlsdr-upconverter'),
        checkbox('rtlBias', 'rtlsdr-bias'),
    ];
}

/** Restore now, then save (debounced) on any change inside the given panels. */
function setupSettingsPersistence(ctx, rootIds) {
    let storage;
    try { storage = window.localStorage; } catch (e) { storage = null; }
    if (!storage) return null;
    const store = createSettingsStore({ storage, fields: appSettingsFields(ctx) });
    let saveTimer = null;
    const scheduleSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => store.save(), 250); };
    for (const id of rootIds) {
        const root = document.getElementById(id);
        if (!root) continue;
        root.addEventListener('input', scheduleSave);
        root.addEventListener('change', scheduleSave);
        root.addEventListener('click', scheduleSave);
    }
    store.load();
    return store;
}

if (typeof globalThis !== 'undefined') {
    globalThis.createSettingsStore = createSettingsStore;
    globalThis.appSettingsFields = appSettingsFields;
    globalThis.setupSettingsPersistence = setupSettingsPersistence;
}
if (typeof module !== 'undefined') module.exports = { createSettingsStore, appSettingsFields, setupSettingsPersistence, SETTINGS_KEY };
