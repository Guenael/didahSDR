/**
 * didahSDR - CW decoder worker.
 *
 * Receives channel-filtered complex baseband chunks from cw_decoder.js, runs the streaming front end
 * (cw_frontend.js) and the ONNX model (models/didahcw.onnx) with onnxruntime-web, and posts decoded text.
 *
 * Inference is stateless and fixed-length: every time 50 new frames exist, the model sees
 * T = leftContext + 50 + lookahead frames and emits only those 50. Each frame is decoded once.
 * During the first ~4.6 s after a start/reset T is shorter (only real frames, never zero frames),
 * so the runtime re-plans about ten times; after that the shape is fixed.
 *
 * Messages in : { type:'init', rate, modelUrl, metaUrl, wasmPath }
 *               { type:'audio', i:Float32Array, q:Float32Array, n }   (buffers are returned via 'recycle')
 *               { type:'rate', rate }   { type:'reset' }
 * Messages out: { type:'status', state, detail? }   { type:'text', text }   { type:'recycle', i, q }
 */

importScripts('fft.js', 'demodulator.js', 'cw_frontend.js');

const NEW_FRAMES = 50;     // one decode step; 50 × 10 ms ≈ 500 ms of new audio
const INFER_POLL_MS = 100;

let ortRt = null;
let session = null;
let meta = null;
let frontend = null;
let inputName = 'features', outputName = 'log_probs';
let leftContext = 460, lookahead = 50, bins = 33, numClasses = 44, blank = 43, chars = [];
let inputT = 0;           // leftContext + NEW_FRAMES + lookahead
let emitted = 0;          // next frame index to decode
let prev = null;          // CTC carry
let inputBuf = null;      // Float32Array of exactly inputT * bins
let timer = null;
let busy = false;
let running = true;
let curRate = 12000;      // last requested rate, including one that arrived while the model loads
let inferGen = 0;         // bumped by reset(); an in-flight session.run must not write stale state

function status(state, detail) { postMessage({ type: 'status', state, detail }); }

function setRunning(on) {
    running = !!on;
    if (timer) { clearInterval(timer); timer = null; }
    if (running && session) timer = setInterval(infer, INFER_POLL_MS);
}

async function init(msg) {
    try {
        status('loading');
        if (msg.rate) curRate = msg.rate;
        importScripts(msg.ortUrl);
        ortRt = self.ort;
        ortRt.env.wasm.wasmPaths = msg.wasmPath;
        ortRt.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
        ortRt.env.wasm.simd = true;
        const [metaResp, sess] = await Promise.all([
            fetch(msg.metaUrl).then((r) => { if (!r.ok) throw new Error(`meta ${r.status}`); return r.json(); }),
            ortRt.InferenceSession.create(msg.modelUrl, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }),
        ]);
        meta = metaResp;
        session = sess;
        inputName = meta.onnx_input_name; outputName = meta.onnx_output_name;
        leftContext = meta.left_context_frames; lookahead = meta.lookahead_frames;
        bins = meta.frontend.bins; numClasses = meta.num_classes; blank = meta.blank_index; chars = meta.chars;
        inputT = leftContext + NEW_FRAMES + lookahead;
        inputBuf = new Float32Array(inputT * bins);
        frontend = new CWFrontend(curRate, 8192);
        inferGen++;
        emitted = 0; prev = null;
        setRunning(running);
        status('ready', `${ortRt.env.wasm.numThreads} thread(s)`);
    } catch (e) {
        status('error', String(e && e.message || e));
    }
}

function reset() {
    inferGen++;
    if (frontend) frontend.reset();
    emitted = 0; prev = null;
}

async function infer() {
    if (busy || !running || !session || !frontend || !inputBuf) return;
    const F = frontend.frameCount;
    // Jump forward only when frames were really lost to the ring.
    const oldest = Math.max(0, F - frontend.capacity);
    if (emitted < oldest) {
        emitted = oldest;
        prev = null;
    }
    // Need 50 new frames whose lookahead is already in the ring.
    if (F - lookahead - emitted < NEW_FRAMES) return;
    // After a start/reset the left context is shorter than leftContext. Feed only the frames
    // that exist so the model's own causal padding sees what training saw; zero input frames
    // are not equivalent (v6 CER 14.0 % -> 19.7 %). The shape varies only during warm-up.
    const end = emitted + NEW_FRAMES + lookahead;
    const start = Math.max(emitted - leftContext, oldest);
    const T = end - start;
    const ctx = emitted - start;
    frontend.copyFrames(start, end, inputBuf);
    const gen = inferGen;
    busy = true;
    try {
        const data = T === inputT ? inputBuf : inputBuf.subarray(0, T * bins);
        const tensor = new ortRt.Tensor('float32', data, [1, T, bins]);
        const out = await session.run({ [inputName]: tensor });
        if (gen !== inferGen) return;
        const lp = out[outputName].data;
        const from = ctx * numClasses;
        const r = ctcGreedy(lp.subarray(from, from + NEW_FRAMES * numClasses), NEW_FRAMES, numClasses, chars, blank, prev);
        prev = r.prev;
        emitted += NEW_FRAMES;
        if (r.text) postMessage({ type: 'text', text: r.text });
    } catch (e) {
        status('error', String(e && e.message || e));
        clearInterval(timer); timer = null;
    } finally {
        busy = false;
    }
}

onmessage = (ev) => {
    const m = ev.data;
    switch (m.type) {
        case 'init': init(m); break;
        case 'audio':
            if (frontend) frontend.process(m.i, m.q, m.n);
            postMessage({ type: 'recycle', i: m.i, q: m.q, epoch: m.epoch }, [m.i.buffer, m.q.buffer]);
            break;
        case 'rate':
            curRate = m.rate;
            if (frontend) { frontend.setInputRate(curRate); reset(); }
            break;
        case 'reset': reset(); break;
        case 'run': setRunning(m.on); break;
    }
};
