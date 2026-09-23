'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const WORKER = fs.readFileSync(path.resolve(__dirname, '../../app/js/cw_decoder_worker.js'), 'utf8');

function bootWorker() {
    const box = {
        messages: [],
        frontends: [],
        copies: [],
        tensors: [],
        session: null,
        timerFn: null,
        console,
        Promise,
        Float32Array,
        Object,
        Error,
        setImmediate
    };
    box.global = box;
    box.self = box;
    box.navigator = { hardwareConcurrency: 2 };
    box.crossOriginIsolated = false;
    box.postMessage = (m) => { box.messages.push(m); };
    box.setInterval = (fn) => { box.timerFn = fn; return 1; };
    box.clearInterval = () => { box.timerFn = null; };
    box.importScripts = (url) => {
        if (url && String(url).indexOf('ort') >= 0) {
            box.ort = {
                env: { wasm: {} },
                InferenceSession: {
                    create: async () => {
                        box.session = {
                            run: async () => ({ log_probs: { data: new Float32Array(50 * 4) } })
                        };
                        return box.session;
                    }
                },
                Tensor: class Tensor { constructor(_t, data, dims) { this.data = data; this.dims = dims; box.tensors.push(this); } }
            };
        }
    };
    box.CWFrontend = class CWFrontend {
        constructor(rate) {
            this.rate = rate;
            this.frameCount = 0;
            this.capacity = 8192;
            box.frontends.push(this);
        }
        reset() { this.frameCount = 0; }
        setInputRate(rate) { this.rate = rate; }
        process() {}
        copyFrames(from, to, dst, dstFrame = 0) { box.copies.push({ from, to, dstFrame }); }
    };
    box.ctcGreedy = (_data, _frames, _classes, _chars, _blank, prev) => ({
        prev: (prev || 0) + 1,
        text: 'E'
    });
    box.fetch = async () => ({
        ok: true,
        json: async () => ({
            onnx_input_name: 'features',
            onnx_output_name: 'log_probs',
            left_context_frames: box.leftContext || 2,
            lookahead_frames: 1,
            frontend: { bins: 4 },
            num_classes: 4,
            blank_index: 0,
            chars: ['', 'E', 'T', 'A']
        })
    });
    vm.createContext(box);
    vm.runInContext(WORKER, box);
    return box;
}

function tick() { return new Promise((resolve) => setImmediate(resolve)); }

async function until(pred) {
    for (let i = 0; i < 20 && !pred(); i++) await tick();
}

test('a rate sent while the model loads is the rate the frontend is built at', async () => {
    const box = bootWorker();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const realFetch = box.fetch;
    box.fetch = () => gate.then(() => realFetch());
    box.onmessage({ data: { type: 'init', rate: 12000, ortUrl: 'ort.js', metaUrl: 'm', modelUrl: 'm', wasmPath: 'w' } });
    await tick();
    box.onmessage({ data: { type: 'rate', rate: 8000 } });
    release();
    await until(() => box.frontends.length > 0);
    assert.equal(box.frontends[0].rate, 8000);
});

test('a reset during session.run discards the stale decode', async () => {
    const box = bootWorker();
    box.onmessage({ data: { type: 'init', rate: 12000, ortUrl: 'ort.js', metaUrl: 'm', modelUrl: 'm', wasmPath: 'w' } });
    await until(() => box.session && box.timerFn && box.frontends.length > 0);
    assert.ok(box.session, 'model session was created');
    let release;
    box.session.run = () => new Promise((resolve) => { release = resolve; });
    box.frontends[0].frameCount = 200;
    const pending = box.timerFn();
    box.onmessage({ data: { type: 'reset' } });
    release({ log_probs: { data: new Float32Array(50 * 4) } });
    await pending;
    assert.equal(box.messages.some((m) => m.type === 'text'), false);
});

async function bootReady(leftContext) {
    const box = bootWorker();
    box.leftContext = leftContext;
    box.onmessage({ data: { type: 'init', rate: 12000, ortUrl: 'ort.js', metaUrl: 'm', modelUrl: 'm', wasmPath: 'w' } });
    await until(() => box.session && box.timerFn && box.frontends.length > 0);
    return box;
}

test('text arrives once 50 frames + lookahead exist, without waiting for the left context', async () => {
    const box = await bootReady(460);
    box.frontends[0].frameCount = 50 + 1;          // 510 ms of audio at 10 ms/frame
    await box.timerFn();
    assert.equal(box.messages.some((m) => m.type === 'text'), true);
    // No left context yet: the model gets only the 51 real frames, not 460 zero frames.
    assert.deepEqual(box.copies[0], { from: 0, to: 51, dstFrame: 0 });
    assert.equal(box.tensors[0].dims[1], 51);
});

test('after a reset the decoder restarts within one step', async () => {
    const box = await bootReady(460);
    box.frontends[0].frameCount = 200;
    await box.timerFn();
    box.onmessage({ data: { type: 'reset' } });
    box.messages.length = 0;
    box.frontends[0].frameCount = 51;
    await box.timerFn();
    assert.equal(box.messages.some((m) => m.type === 'text'), true);
});

test('only frames lost to the ring move emitted forward', async () => {
    const box = await bootReady(460);
    const fe = box.frontends[0];
    fe.frameCount = fe.capacity + 1000;             // emitted = 0 is 1000 frames behind the ring
    await box.timerFn();
    const c = box.copies[0];
    assert.equal(c.from, 1000);                     // oldest frame still in the ring
    assert.equal(box.tensors[0].dims[1], 51);       // no frames before it are invented
});
