/**
 * didahSDR - Mechanical Analog Drum Frequency Dial
 *
 * Supports:
 * - Hover & mouse wheel on individual digit drums (increments/decrements corresponding power of 10)
 * - Click to focus digit drum & Arrow keys (Up/Down to spin, Left/Right to shift focus)
 * - Number key typing (0-9 updates and advances cursor)
 * - Right-click on a digit drum to zero all lower digits
 */

class SDRValueDial {
    constructor(container, options = {}) {
        this.container = typeof container === 'string' ? document.getElementById(container) : container;
        this.numDigits = options.numDigits || 9; // up to 999.999.999 Hz (999 MHz)
        this.value = options.value || 14048700;
        this.min = options.min || 0;
        this.max = options.max || 999999999;
        this.unit = options.unit || 'Hz';
        this.activeCursorIndex = -1; // -1 means none selected
        this.onChange = options.onChange || null;

        this.drumElements = [];
        this.buildDOM();
        this.attachEvents();
        this.setValue(this.value, false);
    }

    buildDOM() {
        this.container.innerHTML = '';
        this.container.classList.add('sdr-value-dial');
        this.container.tabIndex = 0; // make focusable

        this.wheelsContainer = document.createElement('div');
        this.wheelsContainer.className = 'dial-wheels-container';

        this.drumElements = [];

        // Exponents: for 9 digits, exponents are 8, 7, 6, 5, 4, 3, 2, 1, 0
        // Separators inserted between exponents 6 & 5 (MHz), and 3 & 2 (kHz)
        for (let i = 0; i < this.numDigits; i++) {
            const exp = this.numDigits - 1 - i;

            // Create drum wheel
            const drum = document.createElement('div');
            drum.className = 'dial-drum';
            drum.dataset.index = i;
            drum.dataset.exp = exp;
            drum.textContent = '0';
            this.wheelsContainer.appendChild(drum);
            this.drumElements.push(drum);

            // Group separator dots (e.g. between 100 kHz and 1 MHz, and between 1 kHz and 100 Hz)
            if (exp > 0 && exp % 3 === 0) {
                const sep = document.createElement('div');
                sep.className = 'dial-separator';
                sep.textContent = '.';
                this.wheelsContainer.appendChild(sep);
            }
        }

        this.unitBadge = document.createElement('div');
        this.unitBadge.className = 'dial-unit';
        this.unitBadge.textContent = this.unit;

        this.container.appendChild(this.wheelsContainer);
        this.container.appendChild(this.unitBadge);
    }

    setValue(newValue, triggerCallback = true) {
        this.value = Math.max(this.min, Math.min(this.max, Math.round(newValue)));

        // Pad with leading zeroes to numDigits
        const str = this.value.toString().padStart(this.numDigits, '0');
        let firstNonZero = false;

        for (let i = 0; i < this.numDigits; i++) {
            const char = str[i];
            const drum = this.drumElements[i];
            drum.textContent = char;

            // Dim leading zeroes (except the last digit before the decimal)
            const exp = parseInt(drum.dataset.exp, 10);
            if (char !== '0' || exp === 0 || firstNonZero) {
                firstNonZero = true;
                drum.classList.remove('dimmed');
            } else {
                drum.classList.add('dimmed');
            }
        }

        if (triggerCallback && this.onChange) {
            this.onChange(this.value);
        }
    }

    getValue() {
        return this.value;
    }

    stepDigit(digitIndex, direction) {
        const drum = this.drumElements[digitIndex];
        if (!drum) return;

        const exp = parseInt(drum.dataset.exp, 10);
        const delta = Math.pow(10, exp) * direction;
        this.setValue(this.value + delta, true);
    }

    zeroDigitsRight(digitIndex) {
        const drum = this.drumElements[digitIndex];
        if (!drum) return;

        const exp = parseInt(drum.dataset.exp, 10);
        const divisor = Math.pow(10, exp);
        const rounded = Math.floor(this.value / divisor) * divisor;
        this.setValue(rounded, true);
    }

    setCursor(index) {
        this.activeCursorIndex = index;
        this.drumElements.forEach((el, idx) => {
            if (idx === index) {
                el.classList.add('active-cursor');
            } else {
                el.classList.remove('active-cursor');
            }
        });
    }

    attachEvents() {
        // Individual drum mouse wheel
        this.drumElements.forEach((drum, index) => {
            drum.addEventListener('wheel', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const direction = e.deltaY < 0 ? 1 : -1;
                this.stepDigit(index, direction);
            }, { passive: false });

            // Click to select digit cursor
            drum.addEventListener('mousedown', (e) => {
                if (e.button === 0) { // Left click
                    this.setCursor(index);
                } else if (e.button === 2) { // Right click: zero digits to the right
                    e.preventDefault();
                    this.zeroDigitsRight(index);
                }
            });

            drum.addEventListener('contextmenu', (e) => {
                e.preventDefault(); // suppress browser context menu
            });
        });

        // Keyboard navigation when dial has focus
        this.container.addEventListener('keydown', (e) => {
            if (this.activeCursorIndex < 0) {
                // If no cursor yet, pick the 100 Hz digit (index 6 out of 9)
                this.setCursor(this.numDigits - 3);
            }

            const cur = this.activeCursorIndex;

            if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.stepDigit(cur, 1);
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.stepDigit(cur, -1);
            } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                if (cur > 0) this.setCursor(cur - 1);
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                if (cur < this.numDigits - 1) this.setCursor(cur + 1);
            } else if (e.key >= '0' && e.key <= '9') {
                e.preventDefault();
                // Replace digit at cursor position
                const str = this.value.toString().padStart(this.numDigits, '0');
                const exp = this.numDigits - 1 - cur;
                const oldDigit = parseInt(str[cur], 10);
                const newDigit = parseInt(e.key, 10);
                const delta = (newDigit - oldDigit) * Math.pow(10, exp);
                this.setValue(this.value + delta, true);

                // Advance cursor to the right
                if (cur < this.numDigits - 1) {
                    this.setCursor(cur + 1);
                }
            }
        });

        // Clear active cursor on outside click
        document.addEventListener('mousedown', (e) => {
            if (!this.container.contains(e.target)) {
                this.setCursor(-1);
            }
        });
    }
}

if (typeof module !== 'undefined') module.exports = SDRValueDial;
