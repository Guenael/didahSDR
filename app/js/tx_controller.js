/**
 * didahSDR - local CW transmit: paddles (F8/F9/F4), PTT arm, typeahead text, WPM / iambic mode,
 * the RX/TX LEDs, and the IC-7300 key lines (DTR/RTS via CI-V).
 *
 * The keyer itself runs in the AudioWorklet (cw_keyer.js); this side forwards paddle edges and text,
 * and mirrors the worklet's { tx, keyed } state. Losing window focus releases everything: the
 * paddle keyup never arrives after an alt-tab, and a real radio must never stay keyed.
 */

const PADDLE_KEYS = Object.freeze({ F8: 'dit', F9: 'dah', F4: 'straight' });

function createTxController(ctx) {
    const { state, audioPlayer } = ctx;
    const txPaddle = { dit: false, dah: false, straight: false, armed: false };
    let workletTx = false;
    let workletKeyed = false;
    let txTextGen = 0;
    let civCwTimer = null;
    let trxLedKey = '';

    const ic7300 = () => ctx.transports.ic7300;

    function paddleDown() {
        return txPaddle.dit || txPaddle.dah || txPaddle.straight;
    }

    function releasePaddles() {
        txPaddle.dit = false;
        txPaddle.dah = false;
        txPaddle.straight = false;
        audioPlayer.setKeyerPaddle('dit', false);
        audioPlayer.setKeyerPaddle('dah', false);
        audioPlayer.setKeyerStraight(false);
        updateTrxLeds();
    }

    function isLocalTx() {
        return state.modulation === 'cw' && (paddleDown() || workletTx);
    }

    function updateTrxLeds() {
        const onAir = isLocalTx();
        const connected = ctx.isActiveConnected();
        const key = (state.running ? '1' : '0')
            + (connected ? '1' : '0')
            + (onAir ? '1' : '0')
            + (workletKeyed ? '1' : '0')
            + (paddleDown() ? '1' : '0');
        if (key === trxLedKey) return;
        trxLedKey = key;
        const rxBtn = document.getElementById('rx-btn');
        const txBtn = document.getElementById('tx-btn');
        if (rxBtn) rxBtn.classList.toggle('active', state.running && connected && !onAir);
        if (txBtn) txBtn.classList.toggle('active', workletKeyed || paddleDown());
    }

    function syncIc7300Key() {
        const rig = ic7300();
        if (!rig) return;
        const live = ctx.source.protocol === 'ic7300'
            && state.modulation === 'cw'
            && txPaddle.armed
            && document.visibilityState !== 'hidden';
        const wiring = document.getElementById('ic7300-wiring');
        rig.setWiring(wiring && wiring.value === 'ptt-dtr' ? 'ptt-dtr' : 'ptt-rts');
        rig.setLines(live && workletKeyed, live && workletTx);
    }

    function consumeTxChar() {
        const el = document.getElementById('tx-text');
        if (!el) return null;
        const cleaned = sanitizeTxText(el.value);
        if (cleaned !== el.value) el.value = cleaned;
        if (!el.value.length) return null;
        const ch = el.value[0];
        const start = el.selectionStart | 0;
        const end = el.selectionEnd | 0;
        el.value = el.value.slice(1);
        el.selectionStart = Math.max(0, start - 1);
        el.selectionEnd = Math.max(0, end - 1);
        return ch;
    }

    /** Typed text goes to the worklet keyer, or to the radio's own keyer (CI-V 0x17) when CAT is up. */
    function syncKeyerText() {
        const el = document.getElementById('tx-text');
        const text = el ? el.value : '';
        const rig = ic7300();
        const catCw = ctx.source.protocol === 'ic7300' && rig && rig.cat.connected;
        if (catCw && !paddleDown()) {
            audioPlayer.setKeyerText('', ++txTextGen);
            if (civCwTimer) clearTimeout(civCwTimer);
            civCwTimer = setTimeout(() => {
                civCwTimer = null;
                if (paddleDown()) return;
                const r = ic7300();
                if (r) r.sendCw(text);
            }, 400);
            return;
        }
        if (civCwTimer) {
            clearTimeout(civCwTimer);
            civCwTimer = null;
        }
        txTextGen++;
        audioPlayer.setKeyerText(text, txTextGen);
    }

    function applyKeyerConsumed(consumed, gen) {
        if (!consumed || (gen | 0) !== txTextGen) return;
        const el = document.getElementById('tx-text');
        if (!el) return;
        if (el.value.startsWith(consumed)) {
            const start = el.selectionStart | 0;
            const end = el.selectionEnd | 0;
            el.value = el.value.slice(consumed.length);
            el.selectionStart = Math.max(0, start - consumed.length);
            el.selectionEnd = Math.max(0, end - consumed.length);
        }
    }

    audioPlayer.onKeyerState = (m) => {
        workletTx = !!m.tx;
        workletKeyed = !!m.keyed;
        if (m.consumed) applyKeyerConsumed(m.consumed, m.gen);
        if (m.wantChar) {
            const ch = consumeTxChar();
            if (ch != null) audioPlayer.sendKeyerChar(ch);
            else {
                const el = document.getElementById('tx-text');
                audioPlayer.setKeyerHasText(!!(el && el.value.length));
            }
        }
        syncIc7300Key();
        updateTrxLeds();
    };

    function updateTxUi() {
        const cw = state.modulation === 'cw';
        const armBtn = document.getElementById('tx-arm-btn');
        const txText = document.getElementById('tx-text');
        const wpmSlider = document.getElementById('wpm-slider');
        const txRow = document.getElementById('tx-row');
        if (armBtn) {
            armBtn.disabled = !cw;
            const armed = cw && txPaddle.armed;
            armBtn.classList.toggle('armed', armed);
            armBtn.textContent = armed ? 'PTT On' : 'PTT Off';
        }
        if (txText) txText.disabled = !cw;
        if (wpmSlider) wpmSlider.disabled = !cw;
        if (txRow) txRow.classList.toggle('is-dimmed', !cw);
    }

    function setTxArmed(on) {
        const cw = state.modulation === 'cw';
        txPaddle.armed = cw && !!on;
        audioPlayer.setKeyerArmed(txPaddle.armed);
        if (txPaddle.armed) syncKeyerText();
        else {
            audioPlayer.setKeyerHasText(false);
            releasePaddles();
        }
        syncIc7300Key();
        updateTxUi();
    }

    /** Leaving CW: nothing may keep transmitting. */
    function onModulationChanged() {
        if (state.modulation !== 'cw') {
            txPaddle.armed = false;
            releasePaddles();
            audioPlayer.abortKeyer();
            workletTx = false;
            workletKeyed = false;
            ctx.pipeline.forgetTx();
        }
        updateTxUi();
        syncIc7300Key();
        updateTrxLeds();
    }

    function onPowerOff() {
        txPaddle.armed = false;
        audioPlayer.abortKeyer();
        workletTx = false;
        workletKeyed = false;
        ctx.pipeline.forgetTx();
    }

    // Losing focus (alt-tab, a dialog, another window) means the paddle keyup never arrives.
    // Drop the paddles and disarm, so a real radio is never left keyed.
    function releaseTxOnFocusLoss() {
        if (!paddleDown() && !txPaddle.armed) return;
        releasePaddles();
        if (txPaddle.armed) setTxArmed(false);
        const rig = ic7300();
        if (rig) rig.releaseKey();
    }

    function setPaddle(paddle, down) {
        if (paddle === 'straight') {
            txPaddle.straight = down;
            audioPlayer.setKeyerStraight(down);
        } else if (paddle === 'dit') {
            txPaddle.dit = down;
            audioPlayer.setKeyerPaddle('dit', down);
        } else {
            txPaddle.dah = down;
            audioPlayer.setKeyerPaddle('dah', down);
        }
        updateTrxLeds();
    }

    function bind() {
        const txArmBtn = document.getElementById('tx-arm-btn');
        if (txArmBtn) {
            txArmBtn.addEventListener('click', () => {
                if (state.modulation !== 'cw') return;
                setTxArmed(!txPaddle.armed);
            });
        }

        const txTextInput = document.getElementById('tx-text');
        if (txTextInput) {
            const applyTxSanitize = () => {
                const caret = txTextInput.selectionStart | 0;
                const before = txTextInput.value.slice(0, caret);
                const cleaned = sanitizeTxText(txTextInput.value);
                if (cleaned === txTextInput.value) return;
                txTextInput.value = cleaned;
                const pos = sanitizeTxText(before).length;
                txTextInput.selectionStart = txTextInput.selectionEnd = pos;
            };
            applyTxSanitize();
            txTextInput.addEventListener('input', () => {
                applyTxSanitize();
                if (txPaddle.armed) syncKeyerText();
            });
        }

        const wpmSlider = document.getElementById('wpm-slider');
        const wpmVal = document.getElementById('wpm-val');
        if (wpmSlider) {
            wpmSlider.addEventListener('input', (e) => {
                state.wpm = parseInt(e.target.value, 10);
                audioPlayer.setKeyerWpm(state.wpm);
                const rig = ic7300();
                if (rig && rig.cat.connected) rig.setCwSpeed(state.wpm);
                if (wpmVal) wpmVal.textContent = String(state.wpm);
            });
        }

        document.querySelectorAll('input[name="iambic-mode"]').forEach((el) => {
            el.addEventListener('change', () => {
                if (!el.checked) return;
                state.iambicMode = el.value === 'A' ? 'A' : 'B';
                audioPlayer.setKeyerIambic(state.iambicMode);
            });
        });

        updateTxUi();

        // Enter (PTT) and the paddle keys. ui_bindings.js handles every other shortcut.
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const tag = e.target && e.target.tagName;
                const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
                const inCwText = e.target && e.target.id === 'tx-text';
                if (inField && !inCwText) return;
                if (state.modulation !== 'cw') return;
                e.preventDefault();
                setTxArmed(!txPaddle.armed);
                return;
            }
            const paddle = PADDLE_KEYS[e.key];
            if (!paddle) return;
            e.preventDefault();
            if (e.repeat) return;
            if (state.modulation !== 'cw' || !txPaddle.armed) return;
            audioPlayer.resume();
            setPaddle(paddle, true);
        });

        window.addEventListener('keyup', (e) => {
            const paddle = PADDLE_KEYS[e.key];
            if (!paddle) return;
            e.preventDefault();
            setPaddle(paddle, false);
        });

        window.addEventListener('blur', releaseTxOnFocusLoss);
        document.addEventListener('visibilitychange', () => syncIc7300Key());
        window.addEventListener('pagehide', () => {
            releaseTxOnFocusLoss();
            const rig = ic7300();
            if (rig) rig.releaseKey();
        });
    }

    Object.assign(ctx, {
        isLocalTx, updateTrxLeds, syncIc7300Key, setTxArmed, updateTxUi,
        onTxModulationChanged: onModulationChanged, onTxPowerOff: onPowerOff
    });
    return { bind, isArmed: () => txPaddle.armed };
}

if (typeof globalThis !== 'undefined') {
    globalThis.createTxController = createTxController;
    globalThis.PADDLE_KEYS = PADDLE_KEYS;
}
if (typeof module !== 'undefined') module.exports = { createTxController, PADDLE_KEYS };
