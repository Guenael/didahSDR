/**
 * didahSDR - CW decoder worker.
 *
 * Receives channel-filtered complex baseband chunks from cw_decoder.js, runs the streaming front end
 * (cw_frontend.js) and the ONNX model (models/didahcw.onnx) with onnxruntime-web, and posts decoded text.
 *
 * Inference is stateless and chunked: every INFER_MS we feed frames [emitted - leftContext, latest)
 * and emit only the frames whose full lookahead exists, so every frame is decoded exactly once.
 *
 * Messages in : { type:'init', rate, modelUrl, metaUrl, wasmPath }
 *               { type:'audio', i:Float32Array, q:Float32Array, n }   (buffers are returned via 'recycle')
 *               { type:'rate', rate }   { type:'reset' }
 * Messages out: { type:'status', state, detail? }   { type:'text', text }   { type:'recycle', i, q }
 */

importScripts('fft.js', 'demodulator.js', 'cw_frontend.js');

const INFER_MS = 250;

let ortRt = null;
let session = null;
let meta = null;
let frontend = null;
let inputName = 'features', outputName = 'log_probs';
let leftContext = 460, lookahead = 50, bins = 33, numClasses = 44, blank = 43, chars = [];
let emitted = 0;          // frames already decoded and posted
let prev = null;          // CTC carry
let inputBuf = null;      // Float32Array reused for the model input
let timer = null;
let busy = false;

function status(state, detail) { postMessage({ type: 'status', state, detail }); }

async function init(msg) {
    try {
        status('loading');
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
        inputBuf = new Float32Array((leftContext + lookahead + 4096) * bins);
        frontend = new CWFrontend(msg.rate, 8192);
        emitted = 0; prev = null;
        if (timer) clearInterval(timer);
        timer = setInterval(infer, INFER_MS);
        status('ready', `${ortRt.env.wasm.numThreads} thread(s)`);
    } catch (e) {
        status('error', String(e && e.message || e));
    }
}

function reset() {
    if (frontend) frontend.reset();
    emitted = 0; prev = null;
}

async function infer() {
    if (busy || !session || !frontend) return;
    const F = frontend.frameCount;
    const lastDecodable = F - lookahead;          // frames [emitted, lastDecodable) have full lookahead
    if (lastDecodable - emitted < 10) return;     // wait for at least 100 ms of new frames
    // Frames older than the ring are gone: clamp so we never read overwritten data
    const oldest = Math.max(0, F - frontend.capacity);
    if (emitted < oldest + leftContext) emitted = Math.min(lastDecodable, oldest + leftContext);
    const start = Math.max(0, emitted - leftContext);
    const T = F - start;
    if (T * bins > inputBuf.length) inputBuf = new Float32Array(T * bins);
    const view = inputBuf.subarray(0, T * bins);
    frontend.copyFrames(start, F, view);
    busy = true;
    try {
        const tensor = new ortRt.Tensor('float32', view, [1, T, bins]);
        const out = await session.run({ [inputName]: tensor });
        const lp = out[outputName].data;
        const from = emitted - start, to = lastDecodable - start;
        const r = ctcGreedy(lp.subarray(from * numClasses, to * numClasses), to - from, numClasses, chars, blank, prev);
        prev = r.prev;
        emitted = lastDecodable;
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
            postMessage({ type: 'recycle', i: m.i, q: m.q }, [m.i.buffer, m.q.buffer]);
            break;
        case 'rate':
            if (frontend) { frontend.setInputRate(m.rate); reset(); }
            break;
        case 'reset': reset(); break;
    }
};
