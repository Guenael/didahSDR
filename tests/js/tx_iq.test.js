'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { req } = require('./load.js');
const { TxIqModulator, TxIqPump } = req('tx_iq.js');

function envelope(buf, n) {
    const e = new Float64Array(n);
    for (let k = 0; k < n; k++) e[k] = Math.hypot(buf[2 * k], buf[2 * k + 1]) / 32767;
    return e;
}

test('modulator keys at the edge sample with a 5 ms raised-cosine ramp', () => {
    const m = new TxIqModulator(96000);
    const out = new Int16Array(2 * 2400);
    m.keyEdge(100, true);
    m.keyEdge(1500, false);
    m.render(out, 2400, 0);
    const e = envelope(out, 2400);
    assert.equal(e[99], 0);
    assert.ok(e[101] > 0 && e[101] < 0.01);
    assert.ok(Math.abs(e[100 + 480] - 1) < 1e-4);             // full after 480 samples (5 ms)
    assert.ok(Math.abs(e[1000] - 1) < 1e-4);
    assert.ok(e[1500 + 240] > 0.45 && e[1500 + 240] < 0.55);  // mid-ramp on the way down
    assert.equal(e[1500 + 480], 0);
    assert.equal(m.busy, false);
});

test('modulator carrier sits at the offset and stays on the unit circle across blocks', () => {
    const m = new TxIqModulator(96000);
    m.setOffset(700);
    m.keyEdge(0, true);
    const out = new Int16Array(2 * 2400);
    let phaseStep = 0;
    for (let b = 0; b < 40; b++) m.render(out, 2400, b * 2400);   // 1 s
    for (let k = 1; k < 2400; k++) {
        const a0 = Math.atan2(out[2 * k - 1], out[2 * k - 2]);
        const a1 = Math.atan2(out[2 * k + 1], out[2 * k]);
        phaseStep += ((a1 - a0 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
    }
    assert.ok(Math.abs((phaseStep / 2399) * 96000 / (2 * Math.PI) - 700) < 0.5);
    const e = envelope(out, 2400);
    assert.ok(e.every((v) => Math.abs(v - 1) < 2e-4));
});

function makePump(rate = 96000) {
    const clock = { t: 0 };
    const log = [];
    const buf = new Int16Array(2 * Math.round(rate * 0.025));
    const pump = new TxIqPump({
        setPtt: (on) => log.push(['ptt', on]),
        buffer: () => buf,
        send: (b, n, index) => log.push(['iq', n, index, Math.hypot(b[2 * n - 2], b[2 * n - 1]) / 32767]),
        now: () => clock.t,
        timer: false,
        sampleRate: rate
    });
    const run = (ms) => {
        for (const end = clock.t + ms; clock.t < end; clock.t += 5) pump.tick();
    };
    return { pump, clock, log, run };
}

test('pump raises PTT first, paces 25 ms frames behind the clock and drops PTT after the tail', () => {
    const { pump, log, run } = makePump();
    pump.update(true, true, 5000);
    assert.deepEqual(log[0], ['ptt', true]);
    run(60);
    assert.equal(log.length, 1);                               // 60 ms of lead: nothing sent yet
    run(1000);
    const frames = log.filter((x) => x[0] === 'iq');
    assert.ok(frames.length >= 39 && frames.length <= 41);     // ~1 s of 25 ms frames
    frames.forEach((f, k) => assert.deepEqual(f.slice(1, 3), [2400, 5000 + 2400 * k]));
    assert.ok(Math.abs(frames[frames.length - 1][3] - 1) < 1e-3);
    pump.update(false, false);
    run(200);
    const last = log[log.length - 1];
    assert.deepEqual(last, ['ptt', false]);
    const tail = log[log.length - 2];
    assert.equal(tail[0], 'iq');
    assert.equal(tail[3], 0);                                  // ramped to zero before PTT off
    assert.equal(pump.ptt, false);
});

test('pump places a late key edge at its own time and skips ahead after a timer stall', () => {
    const { pump, clock, log, run } = makePump();
    pump.update(true, false, 0);
    run(30);
    pump.update(true, true);                                   // key down at t = 30 ms
    run(200);
    pump.update(false, false);
    run(200);
    const env = log.filter((x) => x[0] === 'iq');
    assert.equal(env[0][3], 0);                                // first frame (0–25 ms) is silent
    assert.ok(env[2][3] > 0.99);                               // 50–75 ms is keyed

    pump.update(true, true, 0);
    clock.t += 3000;                                           // tab throttled for 3 s
    const before = log.length;
    pump.tick();
    assert.ok(log.length - before <= 4);                       // no 3 s burst
    assert.ok(pump.skipped > 0);
    pump.abort();
    assert.deepEqual(log[log.length - 1], ['ptt', false]);
});

test('pump sample-rate change aborts and resizes the chunk', () => {
    const { pump, log } = makePump();
    pump.update(true, true, 0);
    pump.setSampleRate(48000);
    assert.deepEqual(log[log.length - 1], ['ptt', false]);
    assert.equal(pump.chunk, 1200);
});
