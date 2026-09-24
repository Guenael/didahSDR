# REC: recording CW decoder clips

The **REC** button in the CW decoder window records exactly what the decoder model reads, so clips can
be labelled and used to evaluate or fine-tune the model (training repo: `didahSDR-cw-training-model`,
`REAL-DATA.md`). **NOISE** switches REC to band-noise clips.

## What is recorded

The decoder tap is the demodulator's channel-filter output: narrowband complex baseband centred on the
carrier, before the BFO, AGC, noise reduction and squelch. Speaker audio is not model input (AGC pumping
and NR never reach the model), so it is saved for listening only.

One clip downloads three files named `didah_<UTC yyyymmdd_HHMMSS>_<carrier Hz>` (`noise_` prefix in noise
mode):

| File | Content |
| --- | --- |
| `<name>.wav` | Stereo int16 I/Q at the decoder rate (a multiple of 800 Hz, normally 12000 Hz). Model input. |
| `<name>.audio.wav` | Mono int16 demodulated audio at the channel rate. What you heard; for transcription. |
| `<name>.json` | Sidecar: `kind` (signal/noise), `source`, `source_id`, `center_freq`, `carrier_hz`, `cw_offset`, `bandwidth`, `rate`, `audio_rate`, `gain`, `audio_gain`, `started_utc`, `duration_s`, `stop_reason`, `model`, `hyp`. |

Each WAV is peak-normalised to -1 dBFS; the applied gain is in the sidecar. The model features are
`ln|X|` minus a median floor, so the scale does not change what the model sees. `hyp` is the live decode
during the clip, a draft transcript.

A clip is one station: REC stops on a retune, bandwidth, source or mode change, when the decoder stops,
and after 10 minutes.

## Labelling

Write `<name>.txt` by hand from the `.audio.wav`: only the station on the carrier, in the model alphabet.
Cut the clip at an unreadable stretch rather than guessing.

Existing wideband IQ recordings work too: replay one with
`python3 server/replay_server.py --wav X.wav --center-freq F`, tune a station, open the decoder and REC.
