/**
 * didahSDR - Local CW keyer (iambic A/B, straight key, Morse typeahead)
 *
 * Sample-accurate at the audio rate. Sidetone is generated inside the AudioWorklet so
 * paddle keys are not delayed by the RX jitter buffer. tick() is the keying envelope;
 * render() turns it into sidetone. No allocations once audioOut has sized itself to the quantum.
 */

const MORSE_TABLE = {
    A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.',
    H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.',
    O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-',
    U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
    0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-',
    5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
    '.': '.-.-.-', ',': '--..--', '?': '..--..', "'": '.----.',
    '!': '-.-.--', '/': '-..-.', '(': '-.--.', ')': '-.--.-',
    '&': '.-...', ':': '---...', ';': '-.-.-.', '=': '-...-',
    '+': '.-.-.', '-': '-....-', '_': '..--.-', '"': '.-..-.',
    '$': '...-..-', '@': '.--.-.', '*': '...-.-'
};

function morseOf(ch) {
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') return ' ';
    return MORSE_TABLE[String(ch).toUpperCase()] || '';
}

/** Fold accents and map to Morse-safe uppercase; unknown glyphs become spaces. */
function sanitizeTxText(raw) {
    let s = String(raw ?? '');
    s = s
        .replace(/ß/g, 'SS')
        .replace(/æ/gi, 'AE')
        .replace(/œ/gi, 'OE')
        .replace(/ø/gi, 'O')
        .replace(/ł/gi, 'L')
        .replace(/đ/gi, 'D')
        .replace(/þ/gi, 'TH')
        .replace(/ð/gi, 'D')
        .replace(/[‘’‛]/g, "'")
        .replace(/[“”„«»]/g, '"')
        .replace(/[–—]/g, '-');
    s = s.normalize('NFD').replace(/\p{M}+/gu, '');
    s = s.toUpperCase();
    let out = '';
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') {
            out += ' ';
        } else {
            out += morseOf(ch) ? ch : ' ';
        }
    }
    return out;
}

class CwKeyer {
    constructor() {
        this.wpm = 20;
        this.iambicMode = 'B';
        this.armed = false;
        this.amp = 0.35;

        this.ditDown = false;
        this.dahDown = false;
        this.straightDown = false;

        this.pullChar = null;

        this.audioRate = 48000;
        this.audioOut = new Float32Array(0);
        this.audioPhase = 0.0;

        this.abort();
    }

    abort() {
        this.inTx = false;
        this.keyed = false;
        this.mark = false;
        this.kind = null;
        this.elapsed = 0;
        this.elementLen = 0;
        this.riseN = 1;
        this.fallN = 1;
        this.straightFalling = false;
        this.fallElapsed = 0;
        this.gapLeft = 0;
        this.gapType = null;
        this.pendingKind = null;
        this.textPattern = '';
        this.lastSent = null;
        this.squeezeLatch = false;
        this.iambicMemory = false;
        this.stopText = false;
        this.keyed = false;
    }

    setWpm(wpm) {
        this.wpm = Math.max(10, Math.min(40, Math.round(Number(wpm) || 20)));
    }

    setIambicMode(mode) {
        this.iambicMode = mode === 'A' ? 'A' : 'B';
    }

    setPaddle(which, down) {
        if (which === 'dit') this.ditDown = !!down;
        else if (which === 'dah') this.dahDown = !!down;
    }

    setStraight(down) {
        this.straightDown = !!down;
        if (down) this.straightFalling = false;
    }

    unitSamples() {
        return Math.max(1, Math.round(this.audioRate * 1.2 / this.wpm));
    }

    riseSamples(unit) {
        const fiveMs = Math.max(1, Math.round(0.005 * this.audioRate));
        const cap = Math.max(1, Math.floor(0.1 * unit));
        return Math.min(fiveMs, cap);
    }

    willTransmit(hasText) {
        return this.inTx || this.mark || this.gapLeft > 0
            || this.ditDown || this.dahDown || this.straightDown
            || this.textPattern.length > 0 || this.pendingKind
            || (this.armed && !this.stopText && !!hasText);
    }

    isTx() { return this.inTx; }
    isKeyed() { return this.keyed; }

    nextPaddleElement() {
        const dit = this.ditDown;
        const dah = this.dahDown;
        if (dit && dah) return this.lastSent === 'dit' ? 'dah' : 'dit';
        if (dit) return 'dit';
        if (dah) return 'dah';
        if (this.iambicMode === 'B' && this.iambicMemory) {
            this.iambicMemory = false;
            return this.lastSent === 'dit' ? 'dah' : 'dit';
        }
        return null;
    }

    beginMark(kind) {
        const unit = this.unitSamples();
        this.mark = true;
        this.inTx = true;
        this.kind = kind;
        this.elapsed = 0;
        this.straightFalling = false;
        this.fallElapsed = 0;
        this.riseN = this.fallN = this.riseSamples(unit);
        if (kind === 'straight') {
            this.elementLen = 0;
        } else {
            this.elementLen = kind === 'dah' ? 3 * unit : unit;
            if (this.riseN + this.fallN > this.elementLen) {
                this.riseN = this.fallN = Math.max(1, Math.floor(this.elementLen / 4));
            }
            this.lastSent = kind;
            this.squeezeLatch = this.ditDown && this.dahDown;
            this.iambicMemory = false;
        }
        this.pendingKind = null;
    }

    beginGap(type, units) {
        this.mark = false;
        this.inTx = true;
        this.kind = null;
        this.gapType = type;
        this.gapLeft = Math.max(1, Math.round(units * this.unitSamples()));
    }

    raisedCosine(t, n, falling) {
        if (n <= 1) return falling ? 0 : 1;
        const x = Math.max(0, Math.min(1, t / n));
        return falling ? 0.5 * (1 + Math.cos(Math.PI * x)) : 0.5 * (1 - Math.cos(Math.PI * x));
    }

    currentEnv() {
        if (!this.mark) return 0;
        if (this.kind === 'straight') {
            if (this.straightFalling) return this.raisedCosine(this.fallElapsed, this.fallN, true);
            if (this.elapsed < this.riseN) return this.raisedCosine(this.elapsed, this.riseN, false);
            return 1;
        }
        const t = this.elapsed;
        const L = this.elementLen;
        if (t < this.riseN) return this.raisedCosine(t, this.riseN, false);
        if (t >= L - this.fallN) return this.raisedCosine(t - (L - this.fallN), this.fallN, true);
        return 1;
    }

    takeChar() {
        if (!this.armed || this.stopText || typeof this.pullChar !== 'function') return null;
        return this.pullChar();
    }

    skipUnknownAndTake() {
        for (let n = 0; n < 24; n++) {
            const ch = this.takeChar();
            if (ch == null) return null;
            const code = morseOf(ch);
            if (code) return { ch, code };
        }
        return null;
    }

    startTextCode(code) {
        if (code === ' ') {
            this.beginGap('word', 7);
            return;
        }
        this.textPattern = code.slice(1);
        this.beginMark(code[0] === '-' ? 'dah' : 'dit');
    }

    tryStart() {
        if (this.straightDown) {
            this.beginMark('straight');
            return;
        }
        const paddle = this.nextPaddleElement();
        if (paddle) {
            this.textPattern = '';
            this.beginMark(paddle);
            return;
        }
        if (this.pendingKind) {
            this.beginMark(this.pendingKind);
            return;
        }
        if (this.textPattern.length) {
            const el = this.textPattern[0];
            this.textPattern = this.textPattern.slice(1);
            this.beginMark(el === '-' ? 'dah' : 'dit');
            return;
        }
        const next = this.skipUnknownAndTake();
        if (next) {
            this.startTextCode(next.code);
            return;
        }
        this.inTx = false;
    }

    endMark() {
        if (this.kind === 'dit' || this.kind === 'dah') {
            if (this.iambicMode === 'B' && this.squeezeLatch && !this.ditDown && !this.dahDown) {
                this.iambicMemory = true;
            }
        }
        this.mark = false;
        this.straightFalling = false;

        if (this.straightDown) {
            this.beginMark('straight');
            return;
        }
        const paddle = this.nextPaddleElement();
        if (paddle) {
            this.textPattern = '';
            this.pendingKind = paddle;
            this.beginGap('intra', 1);
            return;
        }
        if (this.textPattern.length) {
            const el = this.textPattern[0];
            this.textPattern = this.textPattern.slice(1);
            this.pendingKind = el === '-' ? 'dah' : 'dit';
            this.beginGap('intra', 1);
            return;
        }
        if (this.armed && !this.stopText && typeof this.pullChar === 'function') {
            const next = this.skipUnknownAndTake();
            if (next) {
                if (next.code === ' ') this.beginGap('word', 7);
                else {
                    this.textPattern = next.code.slice(1);
                    this.pendingKind = next.code[0] === '-' ? 'dah' : 'dit';
                    this.beginGap('letter', 3);
                }
                return;
            }
        }
        this.beginGap('hang', 3);
    }

    afterGap() {
        this.gapType = null;
        this.gapLeft = 0;
        this.tryStart();
    }

    emitMarkSample() {
        if (this.ditDown && this.dahDown) this.squeezeLatch = true;
        if (this.kind === 'straight') {
            if (!this.straightDown && !this.straightFalling) {
                this.straightFalling = true;
                this.fallElapsed = 0;
            }
            if (this.straightFalling) {
                const fallEnv = this.raisedCosine(this.fallElapsed, this.fallN, true);
                this.fallElapsed++;
                this.elapsed++;
                if (this.fallElapsed >= this.fallN) this.endMark();
                return fallEnv;
            }
            const env = this.currentEnv();
            this.elapsed++;
            return env;
        }
        const env = this.currentEnv();
        this.elapsed++;
        if (this.elapsed >= this.elementLen) this.endMark();
        return env;
    }

    tick() {
        if (this.mark) return this.emitMarkSample();
        if (this.gapLeft > 0) {
            // Paddles may break into hang / letter / word space, but never skip the
            // intra-element unit (otherwise F8/F9 sounds like a continuous tone).
            if (this.gapType !== 'intra' && (this.straightDown || this.ditDown || this.dahDown)) {
                this.gapLeft = 0;
                this.gapType = null;
                this.pendingKind = null;
                this.tryStart();
                if (this.mark) return this.emitMarkSample();
            } else {
                this.inTx = true;
                this.gapLeft--;
                if (this.gapLeft === 0) this.afterGap();
                if (this.mark) return this.emitMarkSample();
                return 0;
            }
        }
        this.tryStart();
        if (this.mark) return this.emitMarkSample();
        this.inTx = false;
        return 0;
    }

    /**
     * Advance `nAudio` samples of sidetone at `bfoHz` into `audioOut`. The keying envelope itself
     * is tick(). Returns nothing: this runs every AudioWorklet quantum, so it must not allocate.
     */
    render(nAudio, audioRate, bfoHz) {
        this.audioRate = audioRate;
        if (this.audioOut.length !== nAudio) this.audioOut = new Float32Array(nAudio);
        const audio = this.audioOut;
        const TWO_PI = 2.0 * Math.PI;
        const step = (TWO_PI * bfoHz) / audioRate;
        let phase = this.audioPhase;
        let keyed = false;
        for (let n = 0; n < nAudio; n++) {
            const a = this.tick() * this.amp;
            if (a > 1e-6) keyed = true;
            audio[n] = a * Math.sin(phase);
            phase += step;
            if (phase > TWO_PI) phase -= TWO_PI;
        }
        this.audioPhase = phase;
        this.keyed = keyed;
    }
}

if (typeof globalThis !== 'undefined') {
    globalThis.CwKeyer = CwKeyer;
    globalThis.MORSE_TABLE = MORSE_TABLE;
    globalThis.morseOf = morseOf;
    globalThis.sanitizeTxText = sanitizeTxText;
}
if (typeof module !== 'undefined') module.exports = { CwKeyer, MORSE_TABLE, morseOf, sanitizeTxText };
