'use strict';
/**
 * Parity of the JS CW decoder front end with the Python reference (didahcw/frontend.py in the
 * didahSDR-cw-training-model repo). The fixture tests/fixtures/frontend_fixture.json is generated there by
 * tests/make_frontend_fixture.py --sdr <path-to-this-repo>; regenerate it whenever the front-end spec changes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
require('./load.js');

const FIXTURE = path.resolve(__dirname, '../fixtures/frontend_fixture.json');

function run(frontend, i, q, chunk) {
    let produced = 0;
    for (let p = 0; p < i.length; p += chunk) {
        const n = Math.min(chunk, i.length - p);
        produced += frontend.process(i.subarray(p, p + n), q.subarray(p, p + n), n);
    }
    return produced;
}

test('fixture exists (see header for how to regenerate)', () => {
    assert.ok(fs.existsSync(FIXTURE), FIXTURE);
});

if (fs.existsSync(FIXTURE)) {
    const { cases } = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    for (const c of cases) {
        test(`front end matches Python at ${c.rate} Hz (${c.frames} frames)`, () => {
            const fe = new CWFrontend(c.rate);
            const i = Float32Array.from(c.i), q = Float32Array.from(c.q);
            const produced = run(fe, i, q, 1200);
            assert.equal(produced, c.frames);
            assert.equal(fe.frameCount, c.frames);
            const got = new Float32Array(c.frames * fe.bins);
            fe.copyFrames(0, c.frames, got);
            let maxErr = 0;
            for (let k = 0; k < got.length; k++) maxErr = Math.max(maxErr, Math.abs(got[k] - c.features[k]));
            assert.ok(maxErr < 2e-3, `max abs error ${maxErr}`);
        });
    }

    test('chunking does not change the output', () => {
        const c = cases[0];
        const a = new CWFrontend(c.rate), b = new CWFrontend(c.rate);
        const i = Float32Array.from(c.i), q = Float32Array.from(c.q);
        run(a, i, q, 2400); run(b, i, q, 7);
        assert.equal(a.frameCount, b.frameCount);
        const fa = new Float32Array(a.frameCount * a.bins), fb = new Float32Array(fa.length);
        a.copyFrames(0, a.frameCount, fa); b.copyFrames(0, b.frameCount, fb);
        assert.deepEqual(Array.from(fa), Array.from(fb));
    });
}

test('rejects a rate that is not a multiple of 800', () => {
    assert.throws(() => new CWFrontend(44100));
});
