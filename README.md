# didahSDR

![didahSDR](art/logo.png)

didahSDR is a web SDR for Morse (CW) operators. The browser does all the signal processing: FFT, waterfall, CW/USB/LSB demodulation, AGC, noise reduction, an S-meter and a neural CW decoder. The waterfall scrolls right to left with frequency on the vertical axis, so a CW signal reads like text.

The client is plain HTML, CSS, and JavaScript, with no framework and no build step. The repository also includes the Python replay server, plus Linux and Windows binaries built with Electron.

The neural CW decoder is in active development. Feel free to test it and send feedback.

## Download

Linux & Windows binaries: https://github.com/Guenael/didahSDR/releases

## Input Sources

| Source | What it is |
| --- | --- |
| Sound card | Stereo I/Q (SoftRock style) at 48 / 96 / 192 kHz |
| KiwiSDR | Direct connection to a public KiwiSDR server, 12 kHz wide |
| RTL-SDR | RTL2832U + R820T/R820T2 over WebUSB, decimated to 192 kHz |
| IC-7300 | The radio's 12 kHz USB IF, CI-V (Web Serial) for the VFO & CW keying |
| Replay | A remote or local Python server that loops a WAV file over a WebSocket |

The browser needs WebGL and AudioWorklet. The sound-card and IC-7300 sources need a secure context (`https://`, `localhost`, or the Electron application). Web Serial and WebUSB are Chromium-only (Chrome and Edge).


## Local server deployment (Linux)

```bash
git clone https://github.com/Guenael/didahSDR.git
cd didahSDR
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
python3 server/replay_server.py --wav /path/to/recording.wav --center-freq 14048000
```

Open <http://localhost:9000> and press **Power** (the browser needs a click before it plays audio).
The Kiwi, sound-card, IC-7300 and RTL-SDR sources work without a recording: pick them in the **Source** window.

### IQ recordings

No recording is shipped with the repository. The replay source needs a **16-bit stereo PCM WAV** with I on the left channel and Q on the right, at any sample rate (96 or 192 kHz is typical). Example:

```bash
python3 server/replay_server.py --wav samples/my_recording.wav --center-freq 7048000 --port 9000
```

| Argument | Default | Description |
| --- | --- | --- |
| `--wav` | `./samples/REPLAY_SAMPLE.wav` if present | 16-bit stereo IQ WAV, looped |
| `--center-freq` | `14048000` | Centre frequency of the recording, Hz |
| `--host` | `0.0.0.0` | Bind address |
| `--port` | `9000` | HTTP and WebSocket port |

### CW decoder assets

The decoder runs a small ONNX model with onnxruntime-web in a worker.

- **The model**: `app/models/didahcw_v1_rc1.onnx` and `didahcw_v1_rc1.onnx.json` are in the repository.
- **onnxruntime-web**: `scripts/fetch_ort.sh` downloads the pinned version from the npm registry, checks its sha512, and installs it in `app/lib/`. The container build and the desktop package scripts do this. `app/lib/` is not committed.

Without the runtime the rest of the radio still works, and the decoder window shows **NO MODEL** with the reason.

## Container usage

```bash
podman build -t didahsdr .
podman run --rm -p 9000:9000 -v ./samples:/home/app/samples:ro,Z localhost/didahsdr \
    --wav /home/app/samples/my_recording.wav --center-freq 14048000
```

Arguments after the image name go to the server. The image runs as an unprivileged user and includes onnxruntime-web; `app/models/` is copied in when it exists in the build context. Docker works the same way.

## Desktop application (Linux and Windows)

The desktop package is an Electron window around the same client. Build it with `npm run dist:linux` or `npm run dist:win`.

```bash
cd desktop
npm install          # downloads Electron; nothing to fetch by hand
npm start            # window onto ../app
npm run dist:linux   # AppImage in desktop/dist/ (about 150–200 MB; it includes Chromium)
npm run dist:win     # Windows zip in desktop/dist/
```

Note: The AppImage needs FUSE to run (`fuse2` on Arch: `sudo pacman -S fuse2`). If it quits with a message about the Chrome sandbox or user namespaces, start it again with `--no-sandbox`.


## Usage & tips

The application is primarily designed to be used with a mouse.

### Mouse, on the waterfall

| Action | Effect |
| --- | --- |
| Click, or click and drag | Tune to that frequency |
| Wheel | Step the VFO by the selected step |
| Ctrl + wheel, Ctrl + drag | Zoom, centred on the cursor |
| Shift + wheel, Shift + drag, drag on the ruler | Pan (Kiwi and RTL-SDR retune their centre; the IC-7300 retunes its VFO) |
| Ctrl + Shift + wheel or drag | CW bandwidth, or the SSB high edge |

### Keyboard

| Key | Effect |
| --- | --- |
| Space | Power on/off |
| M | Cycle CW → USB → LSB |
| ↑ / ↓ | Step the VFO |
| ← / → , Home / End | Zoom out / in, zoom min / max |
| + / − | Change the tuning step (10 Hz to 5 kHz) |
| Enter | Arm/disarm PTT (CW) |
| F8 / F9 / F4 | Dit paddle / dah paddle (iambic A or B) / straight key |
| Esc | Close the help |

### Transmit (CW)

CW transmit works with the IC-7300 only, for now.

Press the PTT button (bottom left) and type in the text area. Enter toggles PTT.

Iambic keying uses F8 (dit), F9 (dah), and F4 (straight key). The keying delay is still too long.

### Recording decoder clips

**REC** in the decoder window saves the decoder input with a sidecar, for labelling and model evaluation.


## Architecture

```
Browser (vanilla JS, WebGL, Web Audio, Workers)
│
├── IQ source → onRawIQ(Float32 interleaved ±1)
│    ├── audio: NCO → halfbands → ~12 kHz → Kaiser channel filter → BFO → [notch/NR] → AGC → AudioWorklet
│    │            └── tap after the channel filter → CW decoder worker (front end + stateless ONNX call)
│    └── video: ring → window → FFT → dB → [CW filter] → WebGL waterfall, S-meter
│
▼ WebSocket /ws: text handshake + config JSON, then 0x03 + int16 interleaved IQ every 25 ms
Python server (aiohttp, standard library only otherwise)
└── WavIQLooper: any-size WAV, looped with a bounded (~16 MB) threaded read-ahead
```

- Demodulation runs at one channel rate near 12 kHz (`demodulator.js`), so the selectivity does not depend on the source rate. USB/LSB passbands are in `modes.js`.
- Performance: `node scripts/bench.js` prints the CPU cost of the hot paths. They all stay within a few percent of one core, which is why the DSP is plain JavaScript and not WebAssembly.

The server's `/ws` protocol follows the OpenWebRX handshake (`SERVER DE CLIENT` / `CLIENT DE SERVER`). The client also sends `dspcontrol` JSON for a future live backend; the replay server ignores it.


## Development

```bash
source .venv/bin/activate
pytest                                   # server tests (synthetic WAVs, no recording needed)
ruff check server tests && black -l 120 --check server tests

npm ci                                   # dev tooling only: app/ has no npm dependencies
npm run lint                             # ESLint
node --test tests/js/*.test.js           # client DSP, sources, keyer, decoder tests
node scripts/bench.js                    # hot-path CPU cost
```

Client changes need only a browser refresh. Add `?audiodebug` to the URL for a per-second console line of audio pipeline counters (underruns and overflows are cumulative since the page loaded).


## Repository layout

```
app/                 Application client (served statically)
desktop/             Electron shell (self-contained app)
server/              Replay server (Python)
tests/               Test suite, pytest (server) / tests/js (node --test)
scripts/             fetch_ort.sh, convert_palette.py, bench.js
```

## Roadmap & Next features

- IQ amplitude/phase imbalance correction for sound-card IQ.
- Mono sound-card source (a transceiver's audio output, about 4 kHz wide).

## Author

- **Guenael** - *Initial Concept & DSP Algorithms*

## License

didahSDR is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. See [LICENSE](LICENSE).
