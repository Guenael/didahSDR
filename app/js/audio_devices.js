/**
 * didahSDR - shared audio-input listing and capture lifecycle (sound card and IC-7300 sources).
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

/** Echo cancellation, AGC and noise suppression would destroy an IQ or IF signal. */
const RAW_AUDIO_CONSTRAINTS = Object.freeze({
    echoCancellation: false,
    autoGainControl: false,
    noiseSuppression: false
});

/**
 * Ask for microphone permission once (device labels stay empty until then), then list the inputs
 * and keep the list fresh. `owner` is a capture source: _status(), refreshDevices().
 * @returns {Promise<boolean>}
 */
async function enableAudioInputs(owner, constraints, labels) {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        owner._status(`${labels.name} needs a secure context (https or localhost).`, false);
        return false;
    }
    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: Object.assign({}, RAW_AUDIO_CONSTRAINTS, constraints) });
    } catch (e) {
        owner._status('Microphone permission denied.', false);
        return false;
    }
    stream.getTracks().forEach((t) => t.stop());
    owner._status(labels.listing, false);
    await owner.refreshDevices();
    onAudioDevicesChanged(() => { owner.refreshDevices(); }, owner);
    return true;
}

/** Stop a capture that this start() still owns. A newer start keeps its own stream. */
async function abandonCapture(owner, stream, ctx) {
    if (stream) {
        if (owner.stream === stream) owner.stream = null;
        stream.getTracks().forEach((t) => t.stop());
    }
    if (ctx) {
        if (owner.ctx === ctx) owner.ctx = null;
        try { await ctx.close(); } catch (e) { /* already closed */ }
    }
}

/** Tear down a capture graph: worklet node, source node, mute gain, stream tracks, context. */
async function shutdownCapture(owner) {
    for (const key of ['node', 'sourceNode', 'mute']) {
        if (!owner[key]) continue;
        try { owner[key].disconnect(); } catch (e) { /* already gone */ }
        owner[key] = null;
    }
    if (owner.stream) {
        owner.stream.getTracks().forEach((t) => t.stop());
        owner.stream = null;
    }
    if (owner.ctx) {
        const ctx = owner.ctx;
        owner.ctx = null;
        try { await ctx.close(); } catch (e) { /* already closed */ }
    }
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
    globalThis.RAW_AUDIO_CONSTRAINTS = RAW_AUDIO_CONSTRAINTS;
    globalThis.enableAudioInputs = enableAudioInputs;
    globalThis.abandonCapture = abandonCapture;
    globalThis.shutdownCapture = shutdownCapture;
}
if (typeof module !== 'undefined') {
    module.exports = {
        listAudioInputs, onAudioDevicesChanged, fillDeviceSelect,
        RAW_AUDIO_CONSTRAINTS, enableAudioInputs, abandonCapture, shutdownCapture
    };
}
