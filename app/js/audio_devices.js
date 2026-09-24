/**
 * didahSDR - shared audio-input listing.
 *
 * Devices come from enumerateDevices only. The chosen device is checked when
 * start() opens it. One debounced devicechange listener serves every source.
 */

function listAudioInputs() {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        return Promise.resolve([]);
    }
    return navigator.mediaDevices.enumerateDevices().then((all) => {
        const inputs = all.filter((d) => d.kind === 'audioinput');
        const listed = [];
        for (let i = 0; i < inputs.length; i++) {
            const d = inputs[i];
            listed.push({
                id: d.deviceId,
                label: d.label || ('Audio input ' + (i + 1)),
                ok: !!d.deviceId,
                rate: 0,
                channels: 0,
                native: 0
            });
        }
        return listed;
    });
}

/** owner -> callback. One entry per source, so pressing Enable again does not stack refreshes. */
const audioDeviceWatchers = new Map();
let audioDeviceTimer = null;
let audioDeviceListening = false;

function onAudioDevicesChanged(fn, owner) {
    audioDeviceWatchers.set(owner || fn, fn);
    if (audioDeviceListening) return;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.addEventListener) return;
    audioDeviceListening = true;
    navigator.mediaDevices.addEventListener('devicechange', () => {
        if (audioDeviceTimer) clearTimeout(audioDeviceTimer);
        audioDeviceTimer = setTimeout(() => {
            audioDeviceTimer = null;
            for (const fn of audioDeviceWatchers.values()) fn();
        }, 400);
    });
}

/**
 * Rebuild a <select> from an enumerateDevices list.
 * `prefer(device)` picks a default when the previous id is gone.
 */
function fillDeviceSelect(select, devices, wantId, prefer) {
    if (!select) return '';
    const want = wantId || '';
    select.innerHTML = '';
    if (!devices.length) {
        select.appendChild(new Option('No audio inputs found', ''));
        select.classList.remove('has-unsupported');
        return '';
    }
    for (let i = 0; i < devices.length; i++) {
        const d = devices[i];
        const opt = new Option(d.label, d.id);
        opt.disabled = !d.ok;
        if (!d.ok) opt.className = 'is-unsupported';
        select.appendChild(opt);
    }
    const match = devices.find((d) => d.id === want && d.ok);
    const preferred = !match && prefer ? devices.find((d) => d.ok && prefer(d)) : null;
    const firstOk = devices.find((d) => d.ok);
    const chosen = match || preferred || firstOk;
    select.value = chosen ? chosen.id : '';
    select.classList.toggle('has-unsupported', !!(chosen && !chosen.ok));
    return select.value;
}

if (typeof globalThis !== 'undefined') {
    globalThis.listAudioInputs = listAudioInputs;
    globalThis.onAudioDevicesChanged = onAudioDevicesChanged;
    globalThis.fillDeviceSelect = fillDeviceSelect;
}
if (typeof module !== 'undefined') {
    module.exports = { listAudioInputs, onAudioDevicesChanged, fillDeviceSelect };
}
