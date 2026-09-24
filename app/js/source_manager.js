/**
 * didahSDR - IQ sources: creating them, switching between them, and their Source-window controls.
 *
 * One registry entry per protocol (sources_controller.js has the shared policy table):
 *   owner()        the transport object, or null before it was first needed
 *   connect(usb)   open it (`usb`: a user gesture, so the WebUSB picker may open)
 *   stop()         close it
 *   enter(src, hz) set centre and rate when the operator switches to it
 *   retune(hz)     move the IQ centre (only sources whose policy follows the dial)
 * Every source feeds processRawIQ through acceptIq(), so a late packet from a source that is no
 * longer selected (or from an older start() generation) is dropped.
 */

function createSourceManager(ctx) {
    const { state, waterfall, valueDial } = ctx;
    const T = ctx.transports = { conn: null, kiwi: null, sound: null, ic7300: null, rtl: null };
    const src = () => ctx.source;
    const feed = (protocol, owner) => (iq, n) => {
        if (!owner() || !acceptIq(src().protocol, protocol, owner().connected, owner()._gen, owner()._feedGen)) return;
        ctx.pipeline.processRawIQ(iq, n);
    };

    function setStatus(statusText, isConnected) {
        const dot = document.getElementById('status-dot');
        const text = document.getElementById('status-text');
        if (dot) dot.className = `status-dot ${isConnected ? 'connected' : ''}`;
        if (text) text.textContent = statusText;
        const rxBtn = document.getElementById('rx-btn');
        if (rxBtn) rxBtn.classList.toggle('active', isConnected && state.running && !ctx.isLocalTx());
        ctx.updateTrxLeds();
    }

    /** A source that reports ready: adopt its rate and centre, keep the operator's VFO. */
    function adopt(sampleRate, centerFreq) {
        ctx.applyIqRate(sampleRate);
        state.centerFreq = centerFreq;
        waterfall.setCenterFreq(state.centerFreq, state.sampleRate);
    }

    function finishReady() {
        ctx.setTunedFrequency(state.tunedFreq, true, false);
        ctx.updateTopBarInfo();
        ctx.updateSourceStatus();
    }

    T.conn = new DidahConnection({
        onStatusChange: (statusText, isConnected) => {
            if (src().protocol !== 'didah') return;
            setStatus(statusText, isConnected);
        },
        onConfig: (cfg) => {
            if (src().protocol !== 'didah') return;
            if (cfg.center_freq) state.centerFreq = cfg.center_freq;
            if (cfg.samp_rate) ctx.applyIqRate(cfg.samp_rate);
            if (cfg.start_freq && !state.userHasTuned) {
                state.tunedFreq = cfg.start_freq;
                valueDial.setValue(state.tunedFreq, false);
            }
            if (cfg.start_mod) ctx.setModulation(cfg.start_mod);
            waterfall.setCenterFreq(state.centerFreq, state.sampleRate);
            finishReady();
        },
        onRawIQ: (iq, n) => {
            if (!acceptIq(src().protocol, 'didah', T.conn.connected, null, null)) return;
            ctx.pipeline.processRawIQ(iq, n);
        }
    });

    function ensureKiwi() {
        if (T.kiwi) return T.kiwi;
        T.kiwi = new KiwiConnection({
            onRawIQ: feed('kiwi', () => T.kiwi),
            onCenterApplied: (hz) => {
                if (src().protocol === 'kiwi') ctx.applyCenter(hz);
            },
            onReady: (info) => {
                if (src().protocol !== 'kiwi') return;
                adopt(info.sampleRate, info.centerFreq);
                waterfall.zoomMin();
                finishReady();
            },
            onStatusChange: (statusText, isConnected) => {
                if (src().protocol !== 'kiwi') return;
                setStatus(statusText, isConnected);
            }
        });
        return T.kiwi;
    }

    function fillSoundDeviceSelect(devices) {
        const sel = document.getElementById('sound-device');
        fillDeviceSelect(sel, devices, sel && (sel.value || (T.sound && T.sound.deviceId)) || '');
    }

    function ensureSound() {
        if (T.sound) return T.sound;
        T.sound = new SoundcardSource({
            onRawIQ: feed('soundcard', () => T.sound),
            onReady: (info) => {
                if (src().protocol !== 'soundcard') return;
                adopt(info.sampleRate, 0);
                finishReady();
            },
            onStatusChange: (statusText, isConnected) => {
                if (src().protocol !== 'soundcard') return;
                setStatus(statusText, isConnected);
            },
            onDevices: fillSoundDeviceSelect
        });
        const swapEl = document.getElementById('sound-iq-swap');
        if (swapEl) T.sound.setSwap(swapEl.checked);
        return T.sound;
    }

    function fillIc7300DeviceSelect(devices) {
        const sel = document.getElementById('ic7300-device');
        const want = sel && (sel.value || (T.ic7300 && T.ic7300.deviceId)) || '';
        fillDeviceSelect(sel, devices, want, (d) => /pcm2901/i.test(d.label));
    }

    function ensureIc7300() {
        if (T.ic7300) return T.ic7300;
        T.ic7300 = new Ic7300Source({
            onRawIQ: feed('ic7300', () => T.ic7300),
            onReady: (info) => {
                state.ic7300TrackRate = info.trackRate || 0;
                state.ic7300Channels = info.channels || 0;
                if (src().protocol !== 'ic7300') return;
                ctx.applyIqRate(info.sampleRate);
                ctx.applyIc7300Tuning();
                ctx.updateTopBarInfo();
                ctx.updateSourceStatus();
            },
            onStatusChange: (statusText) => {
                const btn = document.getElementById('ic7300-serial-btn');
                if (btn && T.ic7300) btn.textContent = T.ic7300.cat.connected ? 'Disconnect' : 'Connect';
                if (src().protocol !== 'ic7300') return;
                setStatus(statusText, !!(T.ic7300 && T.ic7300.connected));
                ctx.updateSourceStatus();
            },
            onDevices: fillIc7300DeviceSelect,
            onFrequency: (hz) => ctx.onIc7300Frequency(hz),
            onMode: (mode, filter) => ctx.onIc7300Mode(mode, filter)
        });
        const baudEl = document.getElementById('ic7300-baud');
        if (baudEl) T.ic7300.cat.baud = parseInt(baudEl.value, 10) || CIV_BAUD_DEFAULT;
        return T.ic7300;
    }

    function applyRtlControls(rig) {
        const modeEl = document.getElementById('rtlsdr-mode');
        const gainEl = document.getElementById('rtlsdr-gain');
        const ppmEl = document.getElementById('rtlsdr-ppm');
        const upEl = document.getElementById('rtlsdr-upconverter');
        const biasEl = document.getElementById('rtlsdr-bias');
        if (modeEl) rig.setMode(modeEl.value);
        if (gainEl) rig.setGainDb(gainEl.value === 'auto' ? null : Number(gainEl.value));
        if (ppmEl) rig.setPpm(ppmEl.value);
        if (upEl) rig.setUpconverterHz(upEl.value);
        if (biasEl) rig.setBiasTee(biasEl.checked);
    }

    function ensureRtl() {
        if (T.rtl) return T.rtl;
        T.rtl = new RtlSdrSource({
            onRawIQ: feed('rtlsdr', () => T.rtl),
            onCenterApplied: (hz) => {
                if (src().protocol === 'rtlsdr') ctx.applyCenter(hz);
            },
            onReady: (info) => {
                if (src().protocol !== 'rtlsdr') return;
                adopt(info.sampleRate || RTL_IQ_RATE, info.centerFreq || state.centerFreq);
                if (waterfall.zoom <= 1.01) waterfall.setZoom(2.67);
                finishReady();
            },
            onStatusChange: (statusText, isConnected) => {
                const btn = document.getElementById('rtlsdr-connect-btn');
                if (btn && T.rtl) btn.textContent = T.rtl.connected ? 'Disconnect' : 'Connect';
                if (src().protocol !== 'rtlsdr') return;
                setStatus(statusText, !!isConnected);
                ctx.updateSourceStatus();
            }
        });
        applyRtlControls(T.rtl);
        T.rtl.setDisplayHz(state.centerFreq || 14048000);
        return T.rtl;
    }

    /** Media sources need a device id; without one, ask for permission and list the inputs first. */
    function startMediaSource(protocol, rig, selectId) {
        const sel = document.getElementById(selectId);
        const id = (sel && sel.value) || rig.deviceId;
        if (id) {
            rig.start(id);
            return;
        }
        rig.enable().then((ok) => {
            if (!ok || src().protocol !== protocol || !state.running) return;
            const sel2 = document.getElementById(selectId);
            if (sel2 && sel2.value) rig.start(sel2.value);
        });
    }

    const registry = {
        didah: {
            owner: () => T.conn,
            connect: () => T.conn.connect(),
            stop: () => T.conn.disconnect(),
            enter: () => {
                state.centerFreq = 14048000;
                ctx.applyIqRate(96000);
            }
        },
        kiwi: {
            owner: () => T.kiwi,
            connect: () => {
                const s = src();
                const k = ensureKiwi();
                k.host = s.host;
                k.port = s.port;
                k.secure = !!s.secure;
                k.password = s.password || '';
                k.lowCut = s.iqLowCut;
                k.highCut = s.iqHighCut;
                k.startFreqHz = s.startFreq;
                k.ddcHz = state.centerFreq;
                k.connect();
            },
            stop: () => { if (T.kiwi) T.kiwi.disconnect(); },
            enter: (s, entryHz) => {
                state.centerFreq = entryHz;
                ctx.applyIqRate(12000);
                if (T.kiwi) T.kiwi.ddcHz = entryHz;
            },
            retune: (hz) => { if (T.kiwi && T.kiwi.connected) T.kiwi.tune(hz); }
        },
        soundcard: {
            owner: () => T.sound,
            connect: () => startMediaSource('soundcard', ensureSound(), 'sound-device'),
            stop: () => { if (T.sound) T.sound.stop(); },
            enter: () => {
                state.centerFreq = 0;
                ctx.applyIqRate((T.sound && T.sound.sampleRate) || 96000);
            }
        },
        ic7300: {
            owner: () => T.ic7300,
            connect: () => startMediaSource('ic7300', ensureIc7300(), 'ic7300-device'),
            stop: () => { if (T.ic7300) T.ic7300.stop(); },
            enter: () => {
                ctx.applyIqRate((T.ic7300 && T.ic7300.sampleRate) || 12000);
                ctx.applyIc7300Tuning();
            }
        },
        rtlsdr: {
            owner: () => T.rtl,
            connect: (allowUsbPicker) => {
                const rig = ensureRtl();
                applyRtlControls(rig);
                rig.setDisplayHz(state.centerFreq);
                if (rig.connected || allowUsbPicker) rig.start();
                else setStatus('Press Connect to open the RTL-SDR', false);
            },
            stop: () => { if (T.rtl) T.rtl.close(); },
            enter: (s) => {
                state.centerFreq = s.startFreq;
                ctx.applyIqRate(RTL_IQ_RATE);
                if (T.rtl) {
                    applyRtlControls(T.rtl);
                    T.rtl.setDisplayHz(state.centerFreq);
                }
            },
            retune: (hz) => { if (T.rtl && T.rtl.connected) T.rtl.setDisplayHz(hz); }
        }
    };
    const entry = (protocol) => registry[protocol] || registry.didah;

    function isActiveConnected() {
        const owner = entry(src().protocol).owner();
        return !!(owner && owner.connected);
    }

    function connectActive(allowUsbPicker) {
        entry(src().protocol).connect(allowUsbPicker);
    }

    function disconnectTransports() {
        for (const p of ['kiwi', 'soundcard', 'ic7300', 'rtlsdr', 'didah']) registry[p].stop();
    }

    function retuneSourceCenter(hz) {
        const e = entry(src().protocol);
        if (e.retune) e.retune(hz);
    }

    function applyKiwiEndpointFromInput() {
        const urlEl = document.getElementById('kiwi-url');
        const parsed = normalizeKiwiUrl(urlEl ? urlEl.value : '');
        if (!parsed.ok) {
            if (urlEl) {
                urlEl.classList.add('invalid');
                urlEl.title = parsed.error;
            }
            return false;
        }
        if (urlEl) {
            urlEl.classList.remove('invalid');
            urlEl.title = parsed.href;
            urlEl.value = parsed.href;
        }
        const kiwiSrc = findSource('oh5ae');
        kiwiSrc.host = parsed.host;
        kiwiSrc.port = parsed.port;
        kiwiSrc.secure = parsed.secure;
        return true;
    }

    /** Apply the URL box and open (or reopen) the Kiwi SND socket. */
    function connectKiwiFromInput() {
        if (!applyKiwiEndpointFromInput()) {
            setStatus('Invalid KiwiSDR URL', false);
            return;
        }
        const radio = document.querySelector('input[name="iq-source"][value="oh5ae"]');
        if (radio && !radio.checked) {
            radio.checked = true;
            selectSource('oh5ae', true);
            return;
        }
        ctx.updateSourceStatus();
        if (!state.running) return;
        const kiwiSrc = findSource('oh5ae');
        setStatus(`Connecting to ${kiwiSrc.host}:${kiwiSrc.port}…`, false);
        connectActive();
    }

    /** Level / range / FFT presets, applied the first time the operator picks a source (or on demand). */
    function applySourcePresets(s, force) {
        let seen;
        try { seen = JSON.parse(localStorage.getItem('didah_presets_seen') || '{}') || {}; } catch (e) { seen = {}; }
        if (s.id === 'oh5ae' && seen.f4kiy && !seen.oh5ae) seen.oh5ae = 1;   // the Kiwi preset used to be F4KIY
        if (!force && seen[s.id]) return;
        seen[s.id] = 1;
        try { localStorage.setItem('didah_presets_seen', JSON.stringify(seen)); } catch (e) { /* storage unavailable */ }
        const minEl = document.getElementById('min-lvl-slider');
        const dynEl = document.getElementById('dyn-range-slider');
        const fftEl = document.getElementById('fft-select');
        if (minEl) {
            minEl.value = String(s.minLevel);
            minEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (dynEl) {
            dynEl.value = String(s.dynamicRange);
            dynEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (fftEl && fftEl.value !== String(s.fftSize)) {
            fftEl.value = String(s.fftSize);
            fftEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    function selectSource(id, fromUser) {
        const next = findSource(id);
        const prev = src();
        const switching = next.id !== prev.id;
        const prevTuned = state.tunedFreq;
        const prevRadio = state.ic7300RadioHz;
        ctx.source = next;
        state.selectedSourceId = next.id;
        document.querySelectorAll('input[name="iq-source"]').forEach((el) => {
            el.checked = el.value === next.id;
        });
        if (next.protocol === 'kiwi') applyKiwiEndpointFromInput();
        if (fromUser) applySourcePresets(next);
        if (!switching) {
            ctx.updateSourceStatus();
            return;
        }
        if (prev.protocol === 'ic7300') {
            ctx.releaseIc7300View();
            if (T.ic7300 && T.ic7300.cat.connected) T.ic7300.disconnectSerial();
        }
        ctx.syncIc7300Key();
        disconnectTransports();
        ctx.pipeline.resetIqPipeline();
        ctx.resetDspControl();
        state.userHasTuned = false;
        const entryHz = next.protocol === 'kiwi'
            ? kiwiEntryFrequency({
                protocol: prev.protocol,
                tunedFreq: prevTuned,
                radioHz: prevRadio,
                fromUser: !!fromUser
            })
            : next.startFreq;
        state.tunedFreq = entryHz;
        entry(next.protocol).enter(next, entryHz);
        if (next.protocol !== 'ic7300') {
            valueDial.setValue(state.tunedFreq, false);
            ctx.setModulation(next.startMod);
        }
        state.userHasTuned = false;
        ctx.updateTopBarInfo();
        ctx.updateSourceStatus();
        if (!state.running) return;
        if (next.protocol === 'kiwi') {
            const urlEl = document.getElementById('kiwi-url');
            if (urlEl && urlEl.classList.contains('invalid')) {
                setStatus('Invalid KiwiSDR URL', false);
                return;
            }
        }
        connectActive(fromUser);
    }

    /** Check a source radio as if the operator clicked it (fires the change handler). */
    function pickSourceRadio(value) {
        const radio = document.querySelector(`input[name="iq-source"][value="${value}"]`);
        if (radio && !radio.checked) {
            radio.checked = true;
            radio.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }
        return false;
    }

    /** A click anywhere on a source card selects it, except on the card's own controls. */
    function bindSourceCard(selector, value, controls) {
        const card = document.querySelector(selector);
        if (!card) return;
        card.addEventListener('click', (e) => {
            for (const el of controls) if (el && (e.target === el || el.contains(e.target))) return;
            pickSourceRadio(value);
        });
    }

    /** A card button: select the card's source first, then run `fn`. */
    function bindCardButton(btn, value, fn) {
        if (!btn) return;
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            fn(pickSourceRadio(value));
        });
    }

    function bindSourceControls() {
        document.querySelectorAll('input[name="iq-source"]').forEach((el) => {
            el.addEventListener('change', () => {
                if (el.checked) selectSource(el.value, true);
            });
        });

        // KiwiSDR
        const kiwiUrlEl = document.getElementById('kiwi-url');
        const kiwiConnectBtn = document.getElementById('kiwi-connect-btn');
        if (kiwiUrlEl) {
            kiwiUrlEl.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                connectKiwiFromInput();
                kiwiUrlEl.blur();
            });
        }
        bindSourceCard('.source-option-kiwi', 'oh5ae', [kiwiUrlEl, kiwiConnectBtn]);
        if (kiwiConnectBtn) {
            kiwiConnectBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                connectKiwiFromInput();
            });
        }

        // Sound card
        const soundEnableBtn = document.getElementById('sound-enable-btn');
        const soundDeviceSel = document.getElementById('sound-device');
        const soundIqSwap = document.getElementById('sound-iq-swap');
        bindSourceCard('.source-option-soundcard', 'soundcard', [soundEnableBtn, soundDeviceSel, soundIqSwap]);
        bindCardButton(soundEnableBtn, 'soundcard', () => {
            ensureSound().enable().then((ok) => {
                if (!ok || src().protocol !== 'soundcard' || !state.running) return;
                const sel = document.getElementById('sound-device');
                if (sel && sel.value) ensureSound().start(sel.value);
            });
        });
        if (soundDeviceSel) {
            soundDeviceSel.addEventListener('change', () => {
                const opt = soundDeviceSel.selectedOptions[0];
                soundDeviceSel.classList.toggle('has-unsupported', !!(opt && opt.disabled));
                if (src().protocol !== 'soundcard' || !state.running) return;
                if (!soundDeviceSel.value) return;
                ensureSound().start(soundDeviceSel.value);
            });
        }
        if (soundIqSwap) soundIqSwap.addEventListener('change', () => ensureSound().setSwap(soundIqSwap.checked));

        // IC-7300
        const ic7300EnableBtn = document.getElementById('ic7300-enable-btn');
        const ic7300DeviceSel = document.getElementById('ic7300-device');
        const ic7300BaudSel = document.getElementById('ic7300-baud');
        const ic7300WiringSel = document.getElementById('ic7300-wiring');
        const ic7300SerialBtn = document.getElementById('ic7300-serial-btn');
        bindSourceCard('.source-option-ic7300', 'ic7300',
            [ic7300EnableBtn, ic7300SerialBtn, ic7300DeviceSel, ic7300BaudSel, ic7300WiringSel]);
        bindCardButton(ic7300EnableBtn, 'ic7300', () => {
            ensureIc7300().enable().then((ok) => {
                if (!ok || src().protocol !== 'ic7300' || !state.running) return;
                const sel = document.getElementById('ic7300-device');
                if (sel && sel.value) ensureIc7300().start(sel.value);
            });
        });
        if (ic7300DeviceSel) {
            ic7300DeviceSel.addEventListener('change', () => {
                const opt = ic7300DeviceSel.selectedOptions[0];
                ic7300DeviceSel.classList.toggle('has-unsupported', !!(opt && opt.disabled));
                if (src().protocol !== 'ic7300' || !state.running) return;
                if (!ic7300DeviceSel.value) return;
                ensureIc7300().start(ic7300DeviceSel.value);
            });
        }
        if (ic7300BaudSel) ic7300BaudSel.addEventListener('change', () => ensureIc7300().setBaud(parseInt(ic7300BaudSel.value, 10)));
        if (ic7300WiringSel) ic7300WiringSel.addEventListener('change', () => ctx.syncIc7300Key());
        if (ic7300SerialBtn) {
            ic7300SerialBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const rig = ensureIc7300();
                if (ic7300BaudSel) rig.cat.baud = parseInt(ic7300BaudSel.value, 10) || CIV_BAUD_DEFAULT;
                if (rig.cat.connected) {
                    rig.disconnectSerial();
                    return;
                }
                rig.connectSerial();
            });
        }

        // RTL-SDR
        const rtlConnectBtn = document.getElementById('rtlsdr-connect-btn');
        const rtlInputs = ['rtlsdr-mode', 'rtlsdr-gain', 'rtlsdr-ppm', 'rtlsdr-upconverter', 'rtlsdr-bias']
            .map((id) => document.getElementById(id));
        if (rtlConnectBtn && typeof navigator !== 'undefined' && navigator.usb) {
            rtlConnectBtn.disabled = false;
            rtlConnectBtn.title = 'Open the RTL-SDR over WebUSB';
        }
        bindSourceCard('.source-option-rtlsdr', 'rtlsdr', [rtlConnectBtn, ...rtlInputs]);
        bindCardButton(rtlConnectBtn, 'rtlsdr', (switching) => {
            const rig = ensureRtl();
            applyRtlControls(rig);
            if (rig.connected) {
                rig.close();
                return;
            }
            if (switching && state.running) return;   // selectSource() already started it
            if (state.running) rig.start();
            else rig.prepare();
        });
        const pushRtlControls = () => {
            if (!T.rtl) return;
            applyRtlControls(T.rtl);
            if (src().protocol === 'rtlsdr') ctx.updateSourceStatus();
        };
        for (const el of rtlInputs) if (el) el.addEventListener('change', pushRtlControls);
    }

    Object.assign(ctx, {
        setStatus, isActiveConnected, connectActive, disconnectTransports, retuneSourceCenter,
        selectSource, applyKiwiEndpointFromInput
    });
    return { bindSourceControls, restartRtlIfIdle: () => { if (src().protocol === 'rtlsdr' && T.rtl) T.rtl.start(); } };
}

if (typeof globalThis !== 'undefined') globalThis.createSourceManager = createSourceManager;
if (typeof module !== 'undefined') module.exports = { createSourceManager };
