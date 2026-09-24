/**
 * didahSDR - Horizontal Right-to-Left Waterfall Engine
 *
 * Features:
 * - WebGL-only hardware-accelerated rendering. Construction throws without a WebGL context.
 * - Right-to-left scrolling (Time on X axis, Frequency on Y axis).
 * - Ring texture with hardware linear interpolation for judder-free sub-pixel scrolling.
 * - Dedicated vertical frequency ruler on the right edge.
 * - Passband highlighting with the reversed primary colormap (CW centred; USB above; LSB below).
 * - Dynamic real-time brightness & contrast adjustment across the entire waterfall history.
 * - Real-time full-history vertical zoom & pan with Ctrl + wheel / Ctrl + left-drag, centred on cursor.
 * - Mouse Wheel tuning by selected step; Shift+wheel / Shift+left-drag pans the frequency window; Ctrl+wheel zooms.
 * - Ctrl+Shift+wheel / Ctrl+Shift+left-drag steps the demod bandwidth (CW BW or SSB high).
 * - Continuous left-click drag on waterfall for real-time tracking.
 * - requestAnimationFrame render loop that only draws when a slice arrived or the view changed
 *   (dirty flag), so an idle or powered-off receiver costs no GPU time. FPS counts real draws.
 */

class HorizontalWaterfall {
    constructor(container, options = {}) {
        this.container = typeof container === 'string' ? document.getElementById(container) : container;

        // Configuration and state
        this.centerFreq = options.centerFreq || 14048000;
        this.sampleRate = options.sampleRate || 96000;
        this.tunedFreq = options.tunedFreq || 14050800;
        this.lowCut = options.lowCut !== undefined ? options.lowCut : -75;
        this.highCut = options.highCut !== undefined ? options.highCut : 75;
        this.modulation = options.modulation || 'cw';
        this.stepSize = options.stepSize || 100;

        // Display Levels (dB)
        this.minLevel = options.minLevel !== undefined ? options.minLevel : -130;
        this.dynamicRange = options.dynamicRange !== undefined ? options.dynamicRange : 60;

        // Colormaps: passband uses the reversed primary theme (synthesized if needed)
        this.primaryTheme = options.primaryTheme || 'viridis';
        this.primaryTable = Colormaps.getTable(this.primaryTheme);
        this.passbandTable = Colormaps.getReversedTable(this.primaryTheme);

        // Zoom and Pan: default zoom factor to display approximately 30-40 kHz
        // sampleRate (96 kHz) / 2.67 ≈ 36 kHz visible bandwidth
        this.zoom = 2.67;
        this.minZoom = 1.0;
        this.maxZoom = 24.0;
        this.panOffset = 0.0; // in Hz from center
        this.viewLock = false; // IC-7300: block click-tune and zoom; Shift-pan still tunes the radio

        // Interaction state
        this.dragMode = null;         // 'tune' | 'zoom' | 'pan' | 'bw'
        this.dragLastY = 0;
        this.dragAnchorY = 0;
        this.dragAnchorFreq = 0;
        this.bwPixelAcc = 0;
        this.lastRulerY = 0;

        // Canvas elements
        this.wfCanvas = document.createElement('canvas');
        this.rulerCanvas = document.createElement('canvas');
        this.rulerCtx = this.rulerCanvas.getContext('2d');

        this.rulerWidth = 64; // Width of the vertical ruler in pixels
        this.wfWidth = 0;
        this.wfHeight = 0;

        // WebGL & Rendering state
        this.gl = null;
        this.dirty = true;        // set by addSlice / any view change; the render loop draws only when true
        this.program = null;
        this.dataTexture = null;
        this.colormapTexture = null;
        this.quadBuffer = null;

        this.freqLen = 2048;     // texture width: one spectrum is a contiguous row
        this.timeRows = 2048;    // texture height: time ring
        this.headRow = 0;
        this.totalSlicesAdded = 0;
        this.scrollPos = 0.0;
        this.stage = null;
        this.pending = 0;
        this.maxPending = 32;
        this.aPos = -1;
        this.contextLost = false;

        // FPS & timing
        this.running = true;
        this.lastRenderTime = 0;
        this.lastFpsTime = performance.now();
        this.renderFrameCount = 0;
        this.onFpsCallback = null;
        this.onTuneCallback = null;
        this.onPanCallback = null;
        this.onBandwidthCallback = null;
        this.showPassband = true;

        this.initDOM();
        this.initRenderer();
        this.attachEvents();
        this.resize();
        this.startRenderLoop();
    }

    initDOM() {
        this.container.innerHTML = '';
        this.container.style.position = 'relative';
        this.container.style.overflow = 'hidden';
        this.container.style.display = 'flex';
        this.container.style.flexDirection = 'row';
        this.container.style.width = '100%';
        this.container.style.height = '100%';
        this.container.style.background = '#0a0b0e';

        this.wfCanvas.style.display = 'block';
        this.wfCanvas.style.flex = '1 1 auto';
        this.wfCanvas.style.height = '100%';
        this.wfCanvas.style.cursor = 'crosshair';

        this.rulerCanvas.style.display = 'block';
        this.rulerCanvas.style.width = `${this.rulerWidth}px`;
        this.rulerCanvas.style.height = '100%';
        this.rulerCanvas.style.background = '#121418';
        this.rulerCanvas.style.borderLeft = '1px solid #232832';
        this.rulerCanvas.style.cursor = 'ns-resize';

        this.container.appendChild(this.wfCanvas);
        this.container.appendChild(this.rulerCanvas);
    }

    initRenderer() {
        // WebGL is strictly required: no fallback, the application must not start without it.
        const gl = this.wfCanvas.getContext('webgl', {
            alpha: false,
            depth: false,
            antialias: false,
            preserveDrawingBuffer: false,
            powerPreference: 'high-performance'
        }) || this.wfCanvas.getContext('experimental-webgl');

        if (!gl) {
            this.container.innerHTML = '<p style="color:#e66;padding:16px;font-family:sans-serif">'
                + 'didahSDR requires WebGL. Enable hardware acceleration or use a WebGL-capable browser.</p>';
            throw new Error('didahSDR requires a WebGL-capable browser.');
        }
        this.gl = gl;
        this.initWebGL();
    }

    initWebGL() {
        const gl = this.gl;
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

        const vsSource = `
            attribute vec2 a_pos;
            varying vec2 v_uv;
            void main() {
                v_uv = (a_pos + 1.0) * 0.5;
                gl_Position = vec4(a_pos, 0.0, 1.0);
            }
        `;

        const fsSource = `
            #ifdef GL_FRAGMENT_PRECISION_HIGH
            precision highp float;
            #else
            precision mediump float;
            #endif

            varying vec2 v_uv;

            uniform sampler2D u_data;
            uniform sampler2D u_colormap;

            uniform float u_scrollPos;
            uniform float u_visibleCols;
            uniform float u_timeRows;
            uniform float u_freqLen;

            uniform float u_freqBottom;
            uniform float u_freqTop;
            uniform float u_pbMin;
            uniform float u_pbMax;
            uniform float u_edgeX;
            uniform float u_viewH;

            uniform float u_minLevel;
            uniform float u_dbFloor;
            uniform float u_dynRange;

            void main() {
                // Frequency is the texture row (X). Time is the texture column ring (Y).
                float texX = mix(u_freqBottom, u_freqTop, v_uv.y);
                if (texX < -0.002 || texX > 1.002) {
                    gl_FragColor = vec4(0.04, 0.04, 0.06, 1.0);
                    return;
                }
                // Sample the centre of the bin. Without the half-bin the carrier sits one bin high.
                float dataX = texX + 0.5 / max(1.0, u_freqLen);

                float row = (u_scrollPos - 0.5) - (1.0 - v_uv.x) * u_visibleCols;
                float texY = fract(fract(row / u_timeRows) + 1.0);
                float texYc = clamp(texY, 0.0005, 0.9995);

                // Max over the texels that fall in this pixel, so a one-bin carrier
                // survives when the view is zoomed out. 16 fetches cover the pixel;
                // extra taps repeat the last texel.
                float bpp = abs(u_freqTop - u_freqBottom) * u_freqLen / max(1.0, u_viewH);
                float taps = min(16.0, max(1.0, ceil(bpp)));
                float texel = (u_freqTop - u_freqBottom) / max(1.0, u_viewH) / taps;
                float x0 = dataX - texel * (taps - 1.0) * 0.5;
                float rawNorm = 0.0;
                for (int i = 0; i < 16; i++) {
                    float fi = min(float(i), taps - 1.0);
                    float x = clamp(x0 + texel * fi, 0.0005, 0.9995);
                    rawNorm = max(rawNorm, texture2D(u_data, vec2(x, texYc)).r);
                }

                float db = u_dbFloor * (1.0 - rawNorm);
                float norm = clamp((db - u_minLevel) / u_dynRange, 0.0, 1.0);

                vec4 colNormal = texture2D(u_colormap, vec2(norm, 0.25));
                vec4 colPassband = texture2D(u_colormap, vec2(norm, 0.75));
                float inPass = smoothstep(u_pbMin - u_edgeX, u_pbMin, texX)
                    * (1.0 - smoothstep(u_pbMax, u_pbMax + u_edgeX, texX));
                gl_FragColor = mix(colNormal, colPassband, inPass);
            }
        `;

        const vs = this.compileShader(gl.VERTEX_SHADER, vsSource);
        const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSource);

        this.program = gl.createProgram();
        gl.attachShader(this.program, vs);
        gl.attachShader(this.program, fs);
        gl.linkProgram(this.program);

        if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
            console.error('didahSDR: WebGL program linking error:', gl.getProgramInfoLog(this.program));
            return;
        }

        // Cache uniform locations
        this.uniforms = {
            u_data: gl.getUniformLocation(this.program, 'u_data'),
            u_colormap: gl.getUniformLocation(this.program, 'u_colormap'),
            u_scrollPos: gl.getUniformLocation(this.program, 'u_scrollPos'),
            u_visibleCols: gl.getUniformLocation(this.program, 'u_visibleCols'),
            u_timeRows: gl.getUniformLocation(this.program, 'u_timeRows'),
            u_freqLen: gl.getUniformLocation(this.program, 'u_freqLen'),
            u_freqBottom: gl.getUniformLocation(this.program, 'u_freqBottom'),
            u_freqTop: gl.getUniformLocation(this.program, 'u_freqTop'),
            u_pbMin: gl.getUniformLocation(this.program, 'u_pbMin'),
            u_pbMax: gl.getUniformLocation(this.program, 'u_pbMax'),
            u_edgeX: gl.getUniformLocation(this.program, 'u_edgeX'),
            u_viewH: gl.getUniformLocation(this.program, 'u_viewH'),
            u_minLevel: gl.getUniformLocation(this.program, 'u_minLevel'),
            u_dbFloor: gl.getUniformLocation(this.program, 'u_dbFloor'),
            u_dynRange: gl.getUniformLocation(this.program, 'u_dynRange')
        };

        // Full-screen quad
        this.quadBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
        const quadVertices = new Float32Array([
            -1.0, -1.0,
             1.0, -1.0,
            -1.0,  1.0,
             1.0,  1.0
        ]);
        gl.bufferData(gl.ARRAY_BUFFER, quadVertices, gl.STATIC_DRAW);
        this.aPos = gl.getAttribLocation(this.program, 'a_pos');

        // Data texture: frequency along X (one slice = one row), time along Y.
        this.dataTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.dataTexture);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(
            gl.TEXTURE_2D, 0, gl.LUMINANCE, this.freqLen, this.timeRows, 0,
            gl.LUMINANCE, gl.UNSIGNED_BYTE, null
        );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

        // Colormap texture (256x2 RGBA)
        this.colormapTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.colormapTexture);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

        this.updateColormapTexture();
    }

    compileShader(type, source) {
        const gl = this.gl;
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            console.error('didahSDR: Shader compile error:', gl.getShaderInfoLog(shader));
        }
        return shader;
    }

    updateColormapTexture() {
        if (!this.gl || !this.colormapTexture) return;
        const gl = this.gl;

        const rgbaBytes = new Uint8Array(256 * 2 * 4);
        const primBytes = new Uint8Array(this.primaryTable.buffer, this.primaryTable.byteOffset, this.primaryTable.byteLength);
        const passBytes = new Uint8Array(this.passbandTable.buffer, this.passbandTable.byteOffset, this.passbandTable.byteLength);

        rgbaBytes.set(primBytes, 0);
        rgbaBytes.set(passBytes, 256 * 4);

        gl.bindTexture(gl.TEXTURE_2D, this.colormapTexture);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgbaBytes);
    }

    resizeDataTexture(freqLen, timeRows) {
        if (!this.gl || !this.dataTexture || this.contextLost) return;
        const gl = this.gl;
        this.freqLen = freqLen || this.freqLen;
        this.timeRows = timeRows || this.timeRows;
        gl.bindTexture(gl.TEXTURE_2D, this.dataTexture);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(
            gl.TEXTURE_2D, 0, gl.LUMINANCE, this.freqLen, this.timeRows, 0,
            gl.LUMINANCE, gl.UNSIGNED_BYTE, null
        );
        this.headRow = 0;
        this.pending = 0;
        this.scrollPos = 0.0;
        this.totalSlicesAdded = 0;
        this.dirty = true;
    }

    startRenderLoop() {
        const loop = (timestamp) => {
            if (!this.running) return;
            requestAnimationFrame(loop);

            if (!this.lastRenderTime) this.lastRenderTime = timestamp;
            const dt = Math.min(0.1, (timestamp - this.lastRenderTime) / 1000.0);
            this.lastRenderTime = timestamp;
            this.flushSlices();

            // Fluid sub-pixel scroll tracking
            const diff = this.totalSlicesAdded - this.scrollPos;
            if (diff > 0) {
                // High-fidelity spring catch-up to absorb network packet jitter seamlessly
                const step = Math.max(diff * 14.0, diff / 0.04) * dt;
                this.scrollPos = Math.min(this.totalSlicesAdded, this.scrollPos + step);
                this.dirty = true;
            }

            if (this.dirty) {
                this.dirty = false;
                this.renderWebGL();
                this.renderFrameCount++;
            }

            // FPS counter: real draws per second (0 when idle)
            if (timestamp - this.lastFpsTime >= 1000) {
                const fps = Math.round((this.renderFrameCount * 1000) / (timestamp - this.lastFpsTime));
                if (this.onFpsCallback) {
                    this.onFpsCallback(fps);
                }
                this.renderFrameCount = 0;
                this.lastFpsTime = timestamp;
            }
        };

        requestAnimationFrame(loop);
    }

    renderWebGL() {
        const gl = this.gl;
        if (!gl || !this.program || !this.uniforms || this.contextLost) return;

        gl.viewport(0, 0, this.wfWidth, this.wfHeight);
        gl.useProgram(this.program);

        // Bind attributes
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
        gl.enableVertexAttribArray(this.aPos);
        gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);

        // Bind textures
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.dataTexture);
        gl.uniform1i(this.uniforms.u_data, 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.colormapTexture);
        gl.uniform1i(this.uniforms.u_colormap, 1);

        // Uniforms
        const scrollPos = this.scrollPos % this.timeRows;
        gl.uniform1f(this.uniforms.u_scrollPos, scrollPos);
        gl.uniform1f(this.uniforms.u_visibleCols, this.wfWidth);
        gl.uniform1f(this.uniforms.u_timeRows, this.timeRows);
        gl.uniform1f(this.uniforms.u_freqLen, this.freqLen);
        gl.uniform1f(this.uniforms.u_viewH, this.wfHeight);

        const { start, end } = this.getVisibleFreqRange();
        const fullMinFreq = this.centerFreq - this.sampleRate / 2;
        const freqBottom = (start - fullMinFreq) / this.sampleRate;
        const freqTop = (end - fullMinFreq) / this.sampleRate;

        gl.uniform1f(this.uniforms.u_freqBottom, freqBottom);
        gl.uniform1f(this.uniforms.u_freqTop, freqTop);

        let pbMin = 2.0, pbMax = 2.0;
        if (this.showPassband) {
            const { lo, hi } = this.getPassbandEdges();
            pbMin = (lo - fullMinFreq) / this.sampleRate;
            pbMax = (hi - fullMinFreq) / this.sampleRate;
        }
        gl.uniform1f(this.uniforms.u_pbMin, pbMin);
        gl.uniform1f(this.uniforms.u_pbMax, pbMax);

        const edgeX = (freqTop - freqBottom) / Math.max(1.0, this.wfHeight) * 1.5;
        gl.uniform1f(this.uniforms.u_edgeX, edgeX);

        gl.uniform1f(this.uniforms.u_minLevel, this.minLevel);
        gl.uniform1f(this.uniforms.u_dbFloor, WATERFALL_DB_FLOOR);
        gl.uniform1f(this.uniforms.u_dynRange, Math.max(1.0, this.dynamicRange));

        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    resize() {
        const rect = this.container.getBoundingClientRect();
        const totalW = Math.max(300, Math.floor(rect.width));
        const totalH = Math.max(150, Math.floor(rect.height));

        this.wfWidth = totalW - this.rulerWidth;
        this.wfHeight = totalH;

        if (this.wfCanvas.width !== this.wfWidth || this.wfCanvas.height !== this.wfHeight) {
            this.wfCanvas.width = this.wfWidth;
            this.wfCanvas.height = this.wfHeight;

            if (this.wfWidth > this.timeRows) {
                const rows = Math.max(2048, Math.pow(2, Math.ceil(Math.log2(this.wfWidth + 256))));
                this.resizeDataTexture(this.freqLen, rows);
            }
        }

        this.rulerCanvas.width = this.rulerWidth;
        this.rulerCanvas.height = this.wfHeight;

        this.refreshChrome();
    }

    /** Redraw the ruler and mark the WebGL view dirty after any view / tuning change. */
    refreshChrome() {
        this.drawRuler();
        this.dirty = true;
    }

    setPrimaryTheme(theme) {
        this.primaryTheme = theme;
        this.primaryTable = Colormaps.getTable(theme);
        this.passbandTable = Colormaps.getReversedTable(theme);
        this.updateColormapTexture();
        this.dirty = true;
    }

    setLevels(minLevel, dynamicRange) {
        if (minLevel !== undefined) this.minLevel = minLevel;
        if (dynamicRange !== undefined) this.dynamicRange = Math.max(5, dynamicRange);
        this.dirty = true;
    }

    setStepSize(step) {
        this.stepSize = Math.max(1, step);
    }

    setTunedFreq(freq, lowCut, highCut, modulation) {
        this.tunedFreq = freq;
        if (lowCut !== undefined) this.lowCut = lowCut;
        if (highCut !== undefined) this.highCut = highCut;
        if (modulation !== undefined) this.modulation = modulation;
        this.refreshChrome();
    }

    setCenterFreq(cf, sr) {
        this.centerFreq = cf;
        if (sr) this.sampleRate = sr;
        this.refreshChrome();
    }

    getVisibleFreqRange() {
        const visibleSpan = this.sampleRate / this.zoom;
        const viewCenter = this.centerFreq + this.panOffset;
        const start = viewCenter - visibleSpan / 2; // Low frequency (bottom)
        const end = viewCenter + visibleSpan / 2;   // High frequency (top)
        return { start, end, span: visibleSpan };
    }

    freqToY(freq) {
        const { end, span } = this.getVisibleFreqRange();
        const frac = (end - freq) / span;
        return frac * this.wfHeight;
    }

    yToFreq(y) {
        const { end, span } = this.getVisibleFreqRange();
        const frac = y / this.wfHeight;
        return end - frac * span;
    }

    /**
     * Clicked Y → VFO. The click is always the dial/carrier frequency:
     *   CW  : centre of the Morse line (demod BFO supplies the audio pitch)
     *   USB : baseband / suppressed carrier (passband sits above)
     *   LSB : baseband / suppressed carrier (passband sits below)
     */
    calcTunedFreqFromY(y) {
        const step = this.stepSize;
        return Math.round(this.yToFreq(y) / step) * step;
    }

    /**
     * Absolute passband edges for the inverted bar / ruler bracket.
     * CW: ±cwBandwidth/2 around the Morse carrier (the VFO / arrow).
     * USB: low..high above the dial; LSB: the mirrored interval below.
     */
    getPassbandEdges() {
        return {
            lo: this.tunedFreq + this.lowCut,
            hi: this.tunedFreq + this.highCut
        };
    }

    setShowPassband(on) {
        const next = !!on;
        if (next === this.showPassband) return;
        this.showPassband = next;
        this.refreshChrome();
    }

    /**
     * Add a spectrum slice and update waterfall
     * @param {Float32Array} rawFft - Array of FFT power values (dB)
     */
    addSlice(rawFft) {
        if (!rawFft || rawFft.length === 0 || !this.gl || !this.dataTexture) return;
        const fftLen = rawFft.length;

        if (!this.stage || this.freqLen !== fftLen) {
            this.stage = new Uint8Array(this.maxPending * fftLen);
            this.pending = 0;
            const rows = Math.max(this.timeRows, 2048);
            this.resizeDataTexture(fftLen, rows);
        }
        if (this.pending >= this.maxPending) this.flushSlices();

        const row = this.pending * fftLen;
        const bytes = this.stage;
        const floor = WATERFALL_DB_FLOOR;
        const invSpan = 255.0 / -floor;
        for (let i = 0; i < fftLen; i++) {
            let b = Math.floor((rawFft[i] - floor) * invSpan);
            if (b < 0) b = 0;
            else if (b > 255) b = 255;
            bytes[row + i] = b;
        }
        this.pending++;
        this.dirty = true;
    }

    /** Upload every staged row in one or two texSubImage2D calls (the ring may wrap). */
    flushSlices() {
        if (!this.pending || !this.gl || !this.dataTexture || this.contextLost) return;
        const gl = this.gl;
        const w = this.freqLen;
        const rows = this.timeRows;
        const n = this.pending;
        const stage = this.stage;
        gl.bindTexture(gl.TEXTURE_2D, this.dataTexture);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        const first = this.headRow;
        const untilEnd = rows - first;
        if (n <= untilEnd) {
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, first, w, n, gl.LUMINANCE, gl.UNSIGNED_BYTE, stage.subarray(0, n * w));
        } else {
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, first, w, untilEnd, gl.LUMINANCE, gl.UNSIGNED_BYTE, stage.subarray(0, untilEnd * w));
            const rest = n - untilEnd;
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, rest, gl.LUMINANCE, gl.UNSIGNED_BYTE, stage.subarray(untilEnd * w, n * w));
        }
        this.headRow = (first + n) % rows;
        this.totalSlicesAdded += n;
        this.pending = 0;
        this.dirty = true;
    }

    /**
     * Draw vertical frequency ruler on the right
     */
    drawRuler() {
        const ctx = this.rulerCtx;
        const w = this.rulerWidth;
        const h = this.wfHeight;
        if (!w || !h) return;

        ctx.fillStyle = '#121418';
        ctx.fillRect(0, 0, w, h);

        const { start, end, span } = this.getVisibleFreqRange();

        const targetTickCount = Math.max(4, Math.floor(h / 42));
        const rawStep = span / targetTickCount;
        const niceSteps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
        let step = niceSteps[niceSteps.length - 1];
        for (let i = 0; i < niceSteps.length; i++) {
            if (niceSteps[i] >= rawStep) {
                step = niceSteps[i];
                break;
            }
        }

        const firstTick = Math.ceil(start / step) * step;
        ctx.font = '10px "Roboto Mono", Consolas, monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';

        for (let freq = firstTick; freq <= end; freq += step) {
            const y = this.freqToY(freq);
            if (y < 0 || y > h) continue;

            const isMajor = (freq % (step * 2) === 0);

            ctx.strokeStyle = isMajor ? '#61afef' : '#3e4451';
            ctx.lineWidth = isMajor ? 1.5 : 1;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(isMajor ? 11 : 6, y);
            ctx.stroke();

            ctx.fillStyle = isMajor ? '#abb2bf' : '#5c6370';
            const digits = step < 10 ? 3 : step < 100 ? 2 : step < 1000 ? 1 : 0;
            const khz = (freq / 1000).toFixed(digits);
            ctx.fillText(khz, w - 8, y);
        }

        // Tuned passband marker on ruler: centered directly on cursor
        const tunedY = this.freqToY(this.tunedFreq);
        if (tunedY >= 0 && tunedY <= h) {
            ctx.fillStyle = '#e5c07b';
            ctx.beginPath();
            ctx.moveTo(0, tunedY);
            ctx.lineTo(8, tunedY - 5);
            ctx.lineTo(8, tunedY + 5);
            ctx.closePath();
            ctx.fill();

            if (this.showPassband) {
                const { lo, hi } = this.getPassbandEdges();
                const yTop = this.freqToY(hi);
                const yBottom = this.freqToY(lo);
                ctx.strokeStyle = '#e5c07b';
                ctx.lineWidth = 2.5;
                ctx.beginPath();
                ctx.moveTo(4, yTop);
                ctx.lineTo(0, yTop);
                ctx.lineTo(0, yBottom);
                ctx.lineTo(4, yBottom);
                ctx.stroke();
            }
        }
    }

    setZoom(level) {
        this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, level));
        this.clampPan();
        this.refreshChrome();
    }

    zoomIn() {
        if (this.viewLock) return;
        this.setZoom(this.zoom * 1.5);
    }

    zoomOut() {
        if (this.viewLock) return;
        this.setZoom(this.zoom / 1.5);
    }

    zoomMin() {
        if (this.viewLock) return;
        this.zoom = 1.0;
        this.panOffset = 0.0;
        this.refreshChrome();
    }

    zoomMax() {
        if (this.viewLock) return;
        this.zoom = this.maxZoom;
        this.panOffset = this.tunedFreq - this.centerFreq;
        this.clampPan();
        this.refreshChrome();
    }

    clampPan() {
        const visibleSpan = this.sampleRate / this.zoom;
        const maxOffset = (this.sampleRate - visibleSpan) / 2;
        if (maxOffset <= 0) {
            this.panOffset = 0;
        } else {
            this.panOffset = Math.max(-maxOffset, Math.min(maxOffset, this.panOffset));
        }
    }

    /** Pan the visible frequency window by a vertical pixel delta (ruler-drag convention). */
    panByPixels(dy) {
        if (!this.wfHeight) return;
        const span = this.sampleRate / this.zoom;
        const deltaHz = (dy / this.wfHeight) * span;
        if (this.onPanCallback) {
            this.onPanCallback(deltaHz);
            return;
        }
        if (this.viewLock) return;
        this.panOffset += deltaHz;
        this.clampPan();
        this.refreshChrome();
    }

    /**
     * Zoom by `factor` while keeping `cursorFreq` on the same canvas Y.
     * Factor > 1 zooms in (same convention as Ctrl+wheel: 1.25 / 0.8).
     */
    applyZoomAt(mouseY, cursorFreq, factor) {
        if (this.viewLock) return;
        const oldZoom = this.zoom;
        const newZoom = Math.max(this.minZoom, Math.min(this.maxZoom, oldZoom * factor));
        if (newZoom === oldZoom || !this.wfHeight) return;
        this.zoom = newZoom;
        const newSpan = this.sampleRate / newZoom;
        const frac = mouseY / this.wfHeight;
        this.panOffset = cursorFreq - this.centerFreq - newSpan * (0.5 - frac);
        this.clampPan();
        this.refreshChrome();
    }

    notifyBandwidth(direction) {
        if (this.onBandwidthCallback && direction) this.onBandwidthCallback(direction);
    }

    attachEvents() {
        if (typeof ResizeObserver !== 'undefined') {
            new ResizeObserver(() => this.resize()).observe(this.container);
        }
        this.wfCanvas.addEventListener('webglcontextlost', (e) => {
            e.preventDefault();
            this.contextLost = true;
        });
        this.wfCanvas.addEventListener('webglcontextrestored', () => {
            this.contextLost = false;
            this.initWebGL();
            this.dirty = true;
        });

        // Mouse Y in CSS pixels -> canvas buffer pixels. The two differ whenever the container has
        // changed height without a resize() (fonts loading, bottom panel reflow); dividing CSS pixels
        // by the buffer height gave a tuning error that grew from the top of the waterfall downward.
        const canvasY = (e) => {
            const rect = this.wfCanvas.getBoundingClientRect();
            return (e.clientY - rect.top) * (this.wfHeight / Math.max(1, rect.height));
        };

        const handleTuneFromEvent = (e) => {
            const newFreq = this.calcTunedFreqFromY(canvasY(e));

            if (this.onTuneCallback) {
                this.onTuneCallback(newFreq);
            } else {
                this.setTunedFreq(newFreq);
            }
        };

        const dragModeFromEvent = (e, onRuler) => {
            if (e.ctrlKey && e.shiftKey) return 'bw';
            if (e.ctrlKey) return 'zoom';
            if (e.shiftKey) return 'pan';
            return onRuler ? 'pan' : 'tune';
        };

        const beginDrag = (e, onRuler) => {
            if (e.button !== 0) return;
            e.preventDefault();
            const mode = dragModeFromEvent(e, onRuler);
            if (this.viewLock && mode !== 'bw' && mode !== 'pan') return;
            this.dragMode = mode;
            this.dragLastY = e.clientY;
            this.dragAnchorY = Math.max(0, Math.min(this.wfHeight, canvasY(e)));
            this.dragAnchorFreq = this.yToFreq(this.dragAnchorY);
            this.bwPixelAcc = 0;
            this.lastRulerY = e.clientY;
            if (this.dragMode === 'tune') handleTuneFromEvent(e);
        };

        this.wfCanvas.addEventListener('mousedown', (e) => beginDrag(e, false));
        this.rulerCanvas.addEventListener('mousedown', (e) => beginDrag(e, true));

        window.addEventListener('mousemove', (e) => {
            if (!this.dragMode) return;
            const dy = e.clientY - this.dragLastY;
            this.dragLastY = e.clientY;
            if (this.dragMode === 'tune') {
                handleTuneFromEvent(e);
            } else if (this.dragMode === 'pan') {
                this.panByPixels(dy);
            } else if (this.dragMode === 'zoom') {
                // ~48 px ≈ one wheel notch (1.25 / 0.8). Drag up zooms in.
                const factor = Math.exp(-dy * Math.log(1.25) / 48);
                this.applyZoomAt(this.dragAnchorY, this.dragAnchorFreq, factor);
            } else if (this.dragMode === 'bw') {
                this.bwPixelAcc += -dy;
                while (this.bwPixelAcc >= 32) {
                    this.notifyBandwidth(1);
                    this.bwPixelAcc -= 32;
                }
                while (this.bwPixelAcc <= -32) {
                    this.notifyBandwidth(-1);
                    this.bwPixelAcc += 32;
                }
            }
        });

        window.addEventListener('mouseup', () => {
            this.dragMode = null;
            this.bwPixelAcc = 0;
        });

        // Wheel: Ctrl+Shift = bandwidth, Ctrl = zoom, Shift = pan, else VFO step
        const handleWheel = (e) => {
            e.preventDefault();

            if (e.ctrlKey && e.shiftKey) {
                const direction = e.deltaY < 0 ? 1 : -1;
                this.notifyBandwidth(direction);
            } else if (e.shiftKey && !e.ctrlKey) {
                let dy = e.deltaY;
                if (e.deltaMode === 1) dy *= 16;
                else if (e.deltaMode === 2) dy *= this.wfHeight;
                this.panByPixels(dy);
            } else if (this.viewLock) {
                return;
            } else if (e.ctrlKey) {
                const mouseY = Math.max(0, Math.min(this.wfHeight, canvasY(e)));
                const cursorFreq = this.yToFreq(mouseY);
                const factor = e.deltaY < 0 ? 1.25 : 0.8;
                this.applyZoomAt(mouseY, cursorFreq, factor);
            } else {
                const direction = e.deltaY < 0 ? 1 : -1;
                const delta = direction * this.stepSize;
                const newFreq = Math.round((this.tunedFreq + delta) / this.stepSize) * this.stepSize;

                if (this.onTuneCallback) {
                    this.onTuneCallback(newFreq);
                } else {
                    this.setTunedFreq(newFreq);
                }
            }
        };

        this.wfCanvas.addEventListener('wheel', handleWheel, { passive: false });
        this.rulerCanvas.addEventListener('wheel', handleWheel, { passive: false });
    }

    clear() {
        this.resizeDataTexture();
    }
}

if (typeof module !== 'undefined') module.exports = HorizontalWaterfall;
