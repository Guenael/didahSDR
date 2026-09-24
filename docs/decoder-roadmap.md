# CW decoder: roadmap and open ideas

The neural CW decoder (`app/js/cw_decoder*.js`, model trained in the sibling repo `didahSDR-cw-training-model`, design in its `TRAINING.md`) is a
first version. Observed on real traffic with v2: recognisable contest exchanges, but a CW operator still
decodes more than the model does. Candidate improvements, grouped by where they live.

## Training data (training repo: `didahcw/synth.py`, `text.py`)

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
  recordings in the training repo's `eval/real/` would make the CER tables honest, expose generator gaps (word gap
  length was one), and could later be mixed into training as fine-tuning data.
- **Word gaps.** v3 widens `word_gap_scale` down to 0.5 after seeing contest ops glue words together.
  Compare v2 and v3 on real clips before deciding the range.

## Model and decoding (training repo `didahcw/model.py`, `app/js/cw_decoder_worker.js`)

- **Benchmark against DeepCW.** DeepCW publishes a CER heat map versus SNR and WPM in AWGN
  (DeepCW's project README): 0 % CER down to -4 dB, under 1.5 % at -8 dB, under 8 % at -10 dB,
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

## GUI (`app/js/cw_decoder.js`, `app/index.html`)

- **Suppress low-confidence characters.** Below a threshold, do not display the character at all; a
  blank is less misleading than a wrong letter. Threshold and hysteresis to be tuned on real clips.
- **Grey out medium-confidence characters.** Between the two thresholds, show the character in dark
  grey (`.cwd-uncertain`) so the operator knows not to trust it. The highlighter would need per-character
  spans rather than per-word spans.
- **Show the sending speed.** Display the running WPM estimate in the decoder window status pill
  (e.g. `DECODING · 28 WPM`), and optionally per word when the speed changes inside an exchange.
