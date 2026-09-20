# didahSDR

![didahSDR](art/logo.png)

## Overview

**didahSDR** is a high-performance, web-based Software Defined Radio (Web-SDR) interface specifically engineered for Morse code (CW) operators and radio enthusiasts. Designed with a minimalist, dependency-free vanilla HTML/JS frontend and a lightweight asynchronous Python backend, didahSDR delivers zero-latency spectrum visualization and real-time audio demodulation directly in your modern web browser.

Unlike traditional Web-SDR receivers that render vertical top-to-bottom waterfalls and execute all digital signal processing (DSP) server-side, **didahSDR** features an intuitive **right-to-left horizontal waterfall** paired with a **frequency ruler** and passband highlighting. Heavy DSP workloads—including Fast Fourier Transform (FFT), audio demodulation (CW, USB, LSB), adaptive IIR filtering with spatial sharpening, and two-sided Automatic Gain Control (AGC)—are executed on the client side using Web Audio and Canvas APIs.

## How to use this project

- Clone this repository: `git clone https://github.com/Guenael/didahSDR.git`
- Navigate to the project root: `cd didahSDR`
- Set up a Python 3.10+ virtual environment and install the package with dependencies:
  ```bash
  python3 -m venv .venv
  source .venv/bin/activate
  pip install -e ".[test]"
  ```
- Place your 16-bit stereo IQ recording (WAV format) in the `samples/` directory or use the provided extract.
- Launch the backend server:
  ```bash
  python3 server/test_server.py --port 9000 --wav samples/SAMPLE_20120219_174346Z_14048kHz_RF.wav
  ```
- Open your browser and navigate to `http://localhost:9000`.
- Click the **Power** button (top-left) to start the audio engine and stream reception.
- Toggle between **CW**, **USB**, and **LSB** modes, adjust CW filter bandwidth, tune via mouse wheel or the analog frequency drum, and enable the **CW Filter** to enhance Morse signals.
- To run inside a container, build with Podman or Docker:
  ```bash
  podman build -t didahsdr:latest .
  podman run --rm -it -v ~/samples:/home/app/samples -p 9000:9000 localhost/didahsdr:latest
  ```

## The default application of this project

The default installation includes a complete client-server simulation using a high-fidelity 96 kHz 16-bit complex IQ recording of the 20-meter amateur band (`14048 kHz` center frequency). The Python backend serves the web client assets and continuously streams raw IQ chunks over WebSocket, while client-side DSP algorithms decode spectrum and audio with zero buffering delay.

URL: [http://localhost:9000](http://localhost:9000)

The interface provides an interactive toolbar and controls:

| Control / Component | Type | Functionality |
|---------------------|------|---------------|
| Power Button        | Toggle     | Activates Web Audio context, starts stream, and initiates waterfall rendering |
| Analog Drum Dial    | Interactive Dial | Smooth mechanical frequency readout and drag-to-tune control |
| Mode Selectors      | Buttons    | Switches demodulation between `CW`, `USB`, and `LSB` |
| Zoom Controls       | Buttons    | `+`, `-`, `Max`, `Min` horizontal waterfall magnification |
| Tuning Steps        | Dropdown   | Increments of 100 Hz, 500 Hz, or 1 kHz (with mouse wheel snap) |
| Colormap Selector   | Dropdown   | Viridis, Plasma, Blues, Purples, Jet, Rainbow, Turbo, Hot, RdBu (standard & reversed) |
| CW Filter           | Toggle     | Enables adaptive IIR noise-floor estimation and spatial sharpening |
| CW Bandwidth Slider | Range      | Custom passband width adjustment (50 Hz to 350 Hz) |
| Waterfall Sliders   | Range      | Adjustable Minimum Level (-100 to 0 dB) and Dynamic Range (10 to 120 dB) |
| AGC                 | DSP Engine | Optimal two-sided AGC maintaining dynamic range between Morse dots and dashes |

## Features of the application

- **Client-Side DSP & Zero Latency**: In-browser FFT and complex IQ demodulation via Web Audio API and TypedArrays (`Float32Array`), bypassing server round-trips.
- **Horizontal Scrolling Waterfall**: Smooth right-to-left scrolling waterfall canvas matching Morse code reading flow.
- **Frequency Ruler**: High-contrast frequency scale with highlighted active listening passband.
- **CW Adaptive IIR & Spatial Sharpening Filter**: Non-linear IIR smoothing combined with 1D spatial convolution to suppress noise floors and sharpen carrier peaks without oversaturating the display.
- **Two-Sided AGC**: VE3NEA-inspired automatic gain control preserving faint signals between strong Morse pulses without audio clipping.
- **Mechanical Analog Drum Frequency Dial**: Retro analog tumbler dial with tactile tuning feedback.
- **Mouse & Keyboard Shortcuts**:
  - `Scroll`: Adjust tuned frequency by selected step.
  - `Ctrl + Scroll`: Zoom waterfall in/out.
  - `Drag Canvas / Ruler`: Pan across the RF spectrum.
  - `H` or `Help Button`: Open the Quick Guide & Shortcuts modal.

## Architecture

```
Browser (Vanilla JS + HTML5 Canvas + Web Audio)
│
├── DidahConnection (WebSocket client: /ws)
│     ├── Receives raw IQ Float32 / Int16 frames
│     └── Sends tuning, mode, and bandwidth updates
│
├── DidahFFT Engine (Client-side FFT, Hanning window, dB scaling)
├── CW Filter (Adaptive IIR noise estimation + 1D spatial convolution)
├── Horizontal Waterfall Canvas (Right-to-left scrolling, custom colormaps)
├── DidahDemodulator (CW BFO, USB/LSB Weaver/Hilbert phase-shift, IIR filters)
└── AGC & Web Audio Player (Two-sided envelope AGC, low-latency AudioContext)
                               ▲
                               │ WebSocket (/ws) & HTTP (/)
                               ▼
Python Backend (aiohttp + NumPy + SciPy)
├── Static File Server (app/index.html, app/js/*, app/css/*)
├── WavIQLooper (Streams 16-bit complex IQ WAV of any size, ~16 MB read-ahead buffer)
├── Standalone DSP Fallback:
│     ├── SimpleAGC & Software Demodulator (48 kHz mono PCM)
│     └── Server FFT Spectrum Broadcaster (30 FPS)
└── WebSocket Handler (/ws)
```

## Prerequisites, Technologies used & Dependencies

- **Python**: 3.10, 3.11, or 3.12
- **Backend Libraries**: `aiohttp >= 3.9.0`
- **Testing & Tooling**: `pytest >= 8.0.0`, `pytest-asyncio >= 0.23.0`, `pytest-cov >= 4.1.0`, `ruff`, `black`
- **Frontend**: Vanilla JavaScript (ES6+), HTML5 Canvas, Web Audio API, WebSockets (No bulky frameworks or external CDN dependencies)
- **Containerization**: Podman or Docker (multi-stage build with non-root runtime)

## Online service provided

| Endpoint | Protocol | Description |
|----------|----------|-------------|
| `http://localhost:9000/` | HTTP | Main Web-SDR user interface |
| `http://localhost:9000/ws` | WebSocket | Real-time bidirectional stream (IQ samples, spectrum, audio, and control messages) |
| `http://localhost:9000/health` | HTTP | Health check / readiness endpoint |

## Repository Structure

```
.
├── app/                      # Web frontend (vanilla HTML/CSS/JS)
│   ├── css/
│   │   ├── dial.css          # Analog drum dial styling
│   │   └── style.css         # Dark theme UI & layout
│   ├── js/
│   │   ├── app.js            # Main application controller
│   │   ├── audio.js          # Web Audio Context player
│   │   ├── colormaps.js      # Matplotlib colormap definitions
│   │   ├── connection.js     # WebSocket connection & protocol parser
│   │   ├── cw_filter.js      # CW adaptive IIR & spatial sharpening filter
│   │   ├── demodulator.js    # Client-side CW/USB/LSB demodulator
│   │   ├── fft.js            # Client-side Radix-2 FFT engine
│   │   ├── agc.js            # Optimal two-sided AGC
│   │   ├── value_dial.js     # Analog tumbler frequency dial
│   │   └── waterfall.js      # Horizontal waterfall renderer & ruler
│   └── index.html            # Single-page web application entrypoint
├── server/                   # Standalone Python backend
│   └── test_server.py        # aiohttp IQ streamer and WebSocket server
├── tests/                    # Backend unit & integration test suite
│   ├── __init__.py
│   └── test_server.py        # Tests for WavIQLooper, AGC, and aiohttp app
├── docs/                     # Documentation and assets
│   ├── image.png             # UI overview screenshot
│   └── notes.md              # Technical specifications & design notes
├── .github/
│   └── workflows/
│       └── lint.yaml         # CI: Lint, format checks, and test suite
├── pyproject.toml            # Project packaging, dependencies, and tool settings
├── Dockerfile                # Multi-stage container definition
├── .dockerignore             # Excluded files for container builds
└── README.md                 # Project documentation
```

## CI/CD Pipeline

The GitHub Actions workflows run automatically:

| Workflow | Trigger | Description |
|----------|---------|-------------|
| `lint.yaml` | pull_request, push | Ruff linting, Black formatting checks, and pytest test suite execution |
| `build.yaml` | workflow_dispatch, release | Multi-arch container image build and publishing |

## Configuration & Environment Variables

The standalone server supports command-line arguments and optional environment variable overrides:

| Argument | Environment Variable | Default | Description |
|----------|----------------------|---------|-------------|
| `--host` | `HOST` | `0.0.0.0` | Bind IP address for HTTP and WebSocket |
| `--port` | `PORT` | `9000` | Listening port for web server |
| `--wav` | `WAV_PATH` | `samples/SAMPLE_20120219_174346Z_14048kHz_RF.wav` | Path to 16-bit stereo complex IQ WAV file |
| `--center-freq` | `CENTER_FREQ` | `14048000` | Center frequency in Hz (e.g. 14.048 MHz) |
| `--fps` | `FPS` | `30` | Spectrum fallback broadcast frame rate |

Example running on a custom port and frequency:
```bash
python3 server/test_server.py --port 8080 --center-freq 14070000 --wav /path/to/20m_band.wav
```

## Development & Manual testing/debugging

1. Clone the repository and set up a virtual environment:
   ```bash
   git clone https://github.com/Guenael/didahSDR.git
   cd didahSDR
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -e ".[test]"
   ```
2. Start the server with the included IQ sample:
   ```bash
   python3 server/test_server.py
   ```
3. Open your browser to `http://localhost:9000`.
4. Inspect WebSocket messages and client DSP in browser developer tools (F12 > Console / Network > WS).
5. Frontend changes in `app/` are served statically and reload upon browser refresh without restarting the server.

## Testing

Backend tests use [pytest](https://docs.pytest.org/) and `pytest-asyncio` to test server streaming.
Client DSP tests (FFT, demodulator, AGC, CW filter, audio engine, colormaps) run on Node's built-in
test runner with no extra dependency:

```bash
# Client DSP tests
node --test tests/js/

# Run all backend tests
pytest -v

# Run with coverage report
pytest --cov=server --cov-report=term-missing -v

# Run specific test file
pytest tests/test_server.py -v
```

## Lint and Code Quality

```bash
# Check formatting with Black
black --check server/ tests/

# Format in-place
black server/ tests/

# Lint with Ruff
ruff check server/ tests/

# Auto-fix linting issues
ruff check --fix server/ tests/
```

CI runs these checks automatically on pull requests (`.github/workflows/lint.yaml`).

## Building and Testing the Docker Image locally

Build and run using `podman` or `docker`:

```bash
# Build multi-stage container image
podman build -t didahsdr:latest .

# Run container on port 9000
podman run --rm -it -v ~/samples:/home/app/samples -p 9000:9000 localhost/didahsdr:latest

/home/app/

```

The container runs as an unprivileged user (`app`, UID 1000) on a minimal Debian Linux base image (`python:3.12-slim`).

## Security

- **Non-root Container User**: Runs under dedicated unprivileged `app` user.
- **No External CDN Dependencies**: All JS/CSS dependencies and colormap tables are served locally from `app/` to prevent third-party tracking or supply chain tampering.
- **Client-Side DSP Isolation**: Audio and FFT processing occur within the browser sandbox.
- **Input Validation**: Frequency tuning and mode parameters sent via WebSocket are validated and bound to allowed RF ranges.

## CW decoder: possible improvements

The neural CW decoder (`app/js/cw_decoder*.js`, model trained in `training/`, design in `PLAN3.md`) is a
first version. Observed on real traffic with v2: recognisable contest exchanges, but a CW operator still
decodes more than the model does. Candidate improvements, grouped by where they live.

### Training data (`training/didahcw/synth.py`, `text.py`)

- **Speed changes inside a message.** Contest operators send exchanges such as `5NN` or the serial number
  at a different speed than the callsign. The generator keys a whole message at one WPM, so these blocks
  decode poorly. Option: per-word speed changes drawn from a small set of ratios (e.g. 0.7 to 1.3) on a
  fraction of messages, plus explicit "cut numbers" (`5NN`, `ENN`, `TT`). Open question whether
  mid-message speed changes hurt convergence; test on a fine-tuning run from a converged checkpoint
  rather than from scratch.
- **Adjacent-signal robustness (QRM).** The generator already adds 0 to 2 other keyed stations within
  ±350 Hz on 40 % of samples (`p_qrm`, `qrm_offset_hz`, `qrm_rel_db`). What it does not model: QRM on
  the same frequency (a second station tail-ending or zero-beat), very strong neighbours whose key clicks
  leak through the channel filter (heard from a 55 dB station 13 kHz away in the sample WAV), and QRM
  density typical of a contest. Two ways to explore: raise `p_qrm`/`qrm_max` as a curriculum phase after
  convergence, and add a same-frequency QRM mode with a small offset (0 to 30 Hz) and independent text.
- **A real audio corpus.** All training data is synthetic. Even a few minutes of transcribed real
  recordings in `training/eval/real/` would make the CER tables honest, expose generator gaps (word gap
  length was one), and could later be mixed into training as fine-tuning data.
- **Word gaps.** v3 widens `word_gap_scale` down to 0.5 after seeing contest ops glue words together.
  Compare v2 and v3 on real clips before deciding the range.

### Model and decoding (`training/didahcw/model.py`, `app/js/cw_decoder_worker.js`)

- **Benchmark against DeepCW.** DeepCW publishes a CER heat map versus SNR and WPM in AWGN
  (`tmp/web-deep-cw-decoder/README.md`): 0 % CER down to -4 dB, under 1.5 % at -8 dB, under 8 % at -10 dB,
  with SNR referenced to a 2.5 kHz noise bandwidth and 50 % keying duty cycle. Our eval uses a 500 Hz
  reference bandwidth, so the numbers are not comparable as printed: -10 dB in 2.5 kHz is about -3 dB in
  500 Hz. A benchmark script should generate AWGN-only test sets on DeepCW's grid, convert the SNR
  reference, and run both models (DeepCW via its Python example on 3.2 kHz audio) so the heat maps line
  up. Also useful: their two YouTube-sourced clips with reference transcripts as a shared real-audio test.
- **Words, not letters.** Operators read words. The CTC model already carries an implicit letter-level
  language prior from the corpus mix; going further means a second stage. Cheapest first step: a
  context-aware rescoring after the CTC output, where a recognised keyword conditions what follows
  (`CQ`, `DE`, `TEST` are followed by a callsign; `5NN`, `PSE K`, `K`, `KN` end an exchange; `TU`
  precedes a callsign or `73`). Concretely: keep the N-best CTC paths (beam search instead of greedy in
  the worker) and rescore them with a small grammar or n-gram over tokens {callsign, RST, keyword,
  number, word}. A later step is a small transformer over the CTC posteriors trained on QSO text, which
  is what a "reads words" decoder amounts to. Both keep the streaming front end unchanged.
- **Confidence output.** The CTC log-probs already give a per-character confidence (probability of the
  emitted class at its peak frame, or the margin to the runner-up). Exposing it is what the GUI items
  below need; the worker should post `{char, confidence}` instead of raw text.
- **Speed estimate.** The CTC path gives element timing for free: the distance between consecutive
  non-blank emissions and the blank-run lengths bound the dit length. A running estimate of WPM from the
  shortest stable blank runs (dits and intra-character gaps) is cheap and needs no model change; a
  dedicated regression head is the heavier alternative.

### GUI (`app/js/cw_decoder.js`, `app/index.html`)

- **Suppress low-confidence characters.** Below a threshold, do not display the character at all; a
  blank is less misleading than a wrong letter. Threshold and hysteresis to be tuned on real clips.
- **Grey out medium-confidence characters.** Between the two thresholds, show the character in dark
  grey (`.cwd-uncertain`) so the operator knows not to trust it. The highlighter would need per-character
  spans rather than per-word spans.
- **Show the sending speed.** Display the running WPM estimate in the decoder window status pill
  (e.g. `DECODING · 28 WPM`), and optionally per word when the speed changes inside an exchange.

## TODOs

- IQ imbalance correction (amplitude and phase) for sound-card / SoftRock stereo IQ.
- Hardware CW transmit: COM/PTT (and a sidetone) for a standard transceiver; stereo IQ DAC output for a zero-IF radio. Local F8/F9/F4 sidetone does not leave the browser.
- Mono sound-card AF source (commercial radio, ~4 kHz BW): audio-Hz waterfall around 0, mix the beat note to DC for the CW decoder.
- Add WebRTC audio streaming option for ultra-low latency server-demodulated streams.
- Implement automated Morse CW decoder (text output window) using adaptive peak detection.
- Add WebGL acceleration option for high-resolution 4K waterfall displays.
- Integrate RTL-SDR and HackRF direct USB drivers via WebUSB.

## Versioning

The `main` branch holds the latest stable code. Releases follow [Semantic Versioning](https://semver.org/).

## Contributions

Contributions are welcome! Please feel free to open an issue or submit a pull request.

## Authors

- **Guenael** - *Initial Concept & DSP Algorithms*

## License

didahSDR is free software: you can redistribute it and/or modify it under the
terms of the GNU Affero General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later version.

See [LICENSE](LICENSE) for the full text.

