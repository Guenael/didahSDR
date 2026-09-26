/**
 * didahSDR - VFO frequency memories
 *
 * A short list the operator can recall onto the dial or overwrite with the current
 * dial frequency. The list starts as the ARRL W1AW Morse practice frequencies and
 * can grow (up to VFO_MEMORY_MAX). Persistence is localStorage, separate from
 * didah_settings, so clearing a row is not undone by the settings restore.
 */

const VFO_MEMORY_MAX = 24;
const VFO_MEMORY_KEY = 'didah_vfo_memories';

/** W1AW CW code-practice frequencies, Hz. 17 m is 18.0975 MHz. */
const VFO_MEMORY_DEFAULTS = Object.freeze([
    1802500,
    3581500,
    7047500,
    14047500,
    18097500,
    21067500,
    28067500,
]);

/** Dial-style grouping: 14047500 → "14.047.500". */
function formatVfoHz(hz) {
    const n = Math.round(Math.abs(Number(hz)));
    if (!Number.isFinite(n)) return '0';
    const s = String(n);
    let out = '';
    for (let i = 0; i < s.length; i++) {
        if (i > 0 && (s.length - i) % 3 === 0) out += '.';
        out += s[i];
    }
    return out;
}

/**
 * A missing or corrupt store restores the defaults. An array (including empty)
 * is the operator's list: invalid entries are dropped and the result is capped.
 */
function sanitizeVfoMemories(raw) {
    if (!Array.isArray(raw)) return VFO_MEMORY_DEFAULTS.slice();
    const out = [];
    for (let i = 0; i < raw.length; i++) {
        const hz = Math.round(Number(raw[i]));
        if (!Number.isFinite(hz) || hz < 0 || hz > 999999999) continue;
        out.push(hz);
        if (out.length >= VFO_MEMORY_MAX) break;
    }
    return out;
}

function loadVfoMemories(storage, key) {
    let raw = null;
    try {
        const text = storage.getItem(key);
        if (text) raw = JSON.parse(text);
    } catch (e) { /* corrupt or unavailable */ }
    return sanitizeVfoMemories(raw);
}

function setupVfoMemories({
    listId, addBtnId, defaultsBtnId, dialId,
    storageKey = VFO_MEMORY_KEY,
    getDialHz, onRecall,
}) {
    const listEl = document.getElementById(listId);
    const addBtn = document.getElementById(addBtnId);
    const defaultsBtn = document.getElementById(defaultsBtnId);
    const dialEl = document.getElementById(dialId);
    if (!listEl || !addBtn) return null;

    // Reading window.localStorage itself throws when site data is blocked; fall back to memory only.
    let storage;
    try { storage = window.localStorage; } catch (e) { storage = null; }
    if (!storage) storage = { getItem: () => null, setItem: () => {} };
    let memories = loadVfoMemories(storage, storageKey);
    let dialHz = 0;

    const persist = () => {
        try { storage.setItem(storageKey, JSON.stringify(memories)); } catch (e) { /* storage unavailable */ }
    };

    const render = () => {
        listEl.textContent = '';
        if (memories.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'vfo-mem-empty';
            empty.textContent = 'No memories. Add stores the dial.';
            listEl.appendChild(empty);
        }
        for (let i = 0; i < memories.length; i++) {
            const hz = memories[i];
            const row = document.createElement('div');
            row.className = 'vfo-mem-row';
            if (hz === dialHz) row.classList.add('is-current');
            row.dataset.hz = String(hz);

            const recall = document.createElement('button');
            recall.type = 'button';
            recall.className = 'vfo-mem-recall';
            recall.title = `Tune the VFO to ${formatVfoHz(hz)} Hz`;

            const freq = document.createElement('span');
            freq.className = 'vfo-mem-hz';
            freq.textContent = formatVfoHz(hz);

            recall.appendChild(freq);
            recall.addEventListener('click', () => { if (onRecall) onRecall(hz); });

            const store = document.createElement('button');
            store.type = 'button';
            store.className = 'vfo-mem-store';
            store.textContent = 'STO';
            store.title = 'Store the dial frequency in this row';
            store.addEventListener('click', () => storeAt(i));

            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'vfo-mem-del';
            del.textContent = '×';
            del.title = 'Remove this memory';
            del.addEventListener('click', () => removeAt(i));

            row.appendChild(recall);
            row.appendChild(store);
            row.appendChild(del);
            listEl.appendChild(row);
        }
        const full = memories.length >= VFO_MEMORY_MAX;
        const duplicate = memories.indexOf(dialHz) !== -1;
        addBtn.disabled = full || duplicate;
        if (full) addBtn.title = `Memory list is full (${VFO_MEMORY_MAX})`;
        else if (duplicate) addBtn.title = 'This frequency is already stored';
        else addBtn.title = 'Store the dial frequency as a new row';
    };

    const storeAt = (index) => {
        const hz = Math.round(Number(getDialHz()));
        if (!Number.isFinite(hz) || hz < 0 || hz > 999999999) return;
        if (memories[index] === hz) return;
        memories[index] = hz;
        dialHz = hz;
        persist();
        render();
    };

    const removeAt = (index) => {
        memories.splice(index, 1);
        persist();
        render();
    };

    addBtn.addEventListener('click', () => {
        if (memories.length >= VFO_MEMORY_MAX) return;
        const hz = Math.round(Number(getDialHz()));
        if (!Number.isFinite(hz) || hz < 0 || hz > 999999999) return;
        if (memories.indexOf(hz) !== -1) return;
        memories.push(hz);
        dialHz = hz;
        persist();
        render();
    });

    if (defaultsBtn) {
        defaultsBtn.addEventListener('click', () => {
            memories = VFO_MEMORY_DEFAULTS.slice();
            persist();
            render();
        });
    }

    render();

    return {
        /** Mark the row that matches the dial, and refresh the dial readout. */
        syncDial(hz) {
            dialHz = Math.round(Number(hz)) || 0;
            if (dialEl) dialEl.textContent = `Dial ${formatVfoHz(dialHz)} Hz`;
            const rows = listEl.children;
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                if (!row.dataset || row.dataset.hz === undefined) continue;
                row.classList.toggle('is-current', Number(row.dataset.hz) === dialHz);
            }
            const full = memories.length >= VFO_MEMORY_MAX;
            const duplicate = memories.indexOf(dialHz) !== -1;
            addBtn.disabled = full || duplicate;
            if (full) addBtn.title = `Memory list is full (${VFO_MEMORY_MAX})`;
            else if (duplicate) addBtn.title = 'This frequency is already stored';
            else addBtn.title = 'Store the dial frequency as a new row';
        },
    };
}

if (typeof module !== 'undefined') {
    module.exports = {
        VFO_MEMORY_MAX,
        VFO_MEMORY_KEY,
        VFO_MEMORY_DEFAULTS,
        formatVfoHz,
        sanitizeVfoMemories,
        loadVfoMemories,
        setupVfoMemories,
    };
}
