/**
 * didahSDR - Two-Sided AGC
 *
 * Per sample:
 *   1. Envelope: instant attack, exponential release (release time = AGC speed).
 *   2. Noise floor: sliding minimum (~2 s) of a fast 20 ms-release envelope. Between Morse elements
 *      that envelope *is* the noise, so this is the noise level on which our knee is based.
 *   3. Knee: Out = MaxOut * (1 - exp(-In / Beta)), Beta = noiseKnee * noiseFloor.
 *      Weak signals just above the noise get more gain than strong ones (the "two-sided" part),
 *      while the noise itself sits at a fixed, modest output level.
 *   4. Gain smoothing (computed every `dec` samples): sliding minimum of length L followed by a
 *      Blackman FIR of the same length L. Audio is delayed by (L+1)*dec samples. Because both filters
 *      share the same length and the delay matches, the smoothed gain applied to a sample is
 *      never greater than that sample's own instantaneous gain: the output cannot exceed MaxOut,
 *      so no limiter is needed.
 *
 * Processes in place. No allocations after construction.
 */

class AGC {
    constructor(sampleRate = 48000) {
        this.sampleRate = sampleRate;
        this.maxOut = 0.95;         // Output envelope target (peak), 95% of full scale
        this.maxGain = 3000.0;      // +70 dB cap. Real IQ signals sit at -50..-90 dBFS after the channel
                                    // filter, so +35 dB left the AGC pinned and the audio quiet. The knee,
                                    // not this cap, keeps dead-band noise at a modest level.
        this.noiseKnee = 4.0;       // Beta = noiseKnee * noiseFloor; larger => noise sits lower

        // Gain is updated at sampleRate / dec; smoothing window fixed at 8 ms (L odd)
        this.dec = 8;
        const subRate = sampleRate / this.dec;
        let L = Math.floor(subRate * 0.008);
        if (L % 2 === 0) L++;
        this.L = L;

        this.weights = new Float32Array(L);
        let sum = 0.0;
        for (let i = 0; i < L; i++) {
            const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (L - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (L - 1));
            this.weights[i] = w;
            sum += w;
        }
        for (let i = 0; i < L; i++) this.weights[i] /= sum;

        this.minBuf = new Float32Array(L).fill(1.0);
        this.firBuf = new Float32Array(L).fill(1.0);
        this.bufIdx = 0;

        // One extra tap covers the linear ramp toward the next gain update
        this.delayLen = (L + 1) * this.dec;
        this.delayBuf = new Float32Array(this.delayLen);
        this.delayIdx = 0;

        // Noise floor = minimum over ~2 s of 100 ms block *means* of a fast envelope (20 ms release).
        // Inter-character gaps (>= 3 dits) always contain a noise-only block, so the minimum is the
        // noise even during a transmission. Means, not minima: the envelope of narrowband noise is
        // Rayleigh, and a raw minimum over 2 s lands ~20 dB under the rms. The old estimator used the
        // slow AGC envelope, which never reaches the noise inside a character, so the floor drifted with
        // the signal and the volume swelled and faded over seconds.
        // The floor drops to a new minimum immediately and rises toward it with a 200 ms time constant.
        this.fastDecay = Math.exp(-1.0 / (sampleRate * 0.02));
        this.floorBlockTicks = Math.floor(subRate * 0.1);
        this.floorBlocks = new Float32Array(20).fill(1.0);
        this.floorBlockIdx = 0;
        this.floorBlockTick = 0;
        this.floorBlockSum = 0.0;
        this.floorUp = 1.0 / (subRate * 0.2);

        this.env = 0.0;
        this.fastEnv = 0.0;
        this.blockPeak = 0.0;     // max |s| since the last gain update
        this.noiseFloor = 1e-3;
        this.gPrev = 1.0;
        this.gNext = 1.0;
        this.phase = 0;           // position within the current `dec` interval, persists across calls

        this.setSpeed('medium');
    }

    /** Drop envelope, gain and the delay line. Used when the tune jumps to a new station. */
    reset() {
        this.minBuf.fill(1.0);
        this.firBuf.fill(1.0);
        this.delayBuf.fill(0.0);
        this.bufIdx = 0;
        this.delayIdx = 0;
        this.floorBlocks.fill(1.0);
        this.floorBlockIdx = 0;
        this.floorBlockTick = 0;
        this.floorBlockSum = 0.0;
        this.env = 0.0;
        this.fastEnv = 0.0;
        this.blockPeak = 0.0;
        this.noiseFloor = 1e-3;
        this.gPrev = 1.0;
        this.gNext = 1.0;
        this.phase = 0;
    }

    /** 'fast' | 'medium' | 'slow' : envelope release time 40 / 100 / 300 ms */
    setSpeed(speed) {
        const ms = speed === 'fast' ? 40.0 : speed === 'slow' ? 300.0 : 100.0;
        this.decay = Math.exp(-1.0 / (this.sampleRate * ms / 1000.0));
    }

    /**
     * Apply AGC in place.
     * @param {Float32Array} samples - mono audio, modified in place
     * @returns {Float32Array} the same array
     */
    process(samples) {
        const N = samples.length;
        const L = this.L;
        const dec = this.dec;
        const weights = this.weights;
        const minBuf = this.minBuf;
        const firBuf = this.firBuf;
        const delayBuf = this.delayBuf;
        const delayLen = this.delayLen;
        const maxOut = this.maxOut;
        const maxGain = this.maxGain;
        const knee = this.noiseKnee;
        const decay = this.decay;
        const fastDecay = this.fastDecay;
        const floorUp = this.floorUp;
        const floorBlocks = this.floorBlocks;
        const floorBlockTicks = this.floorBlockTicks;

        let env = this.env;
        let fastEnv = this.fastEnv;
        let floorBlockSum = this.floorBlockSum;
        let floorBlockIdx = this.floorBlockIdx;
        let floorBlockTick = this.floorBlockTick;
        let blockPeak = this.blockPeak;
        let floor = this.noiseFloor;
        let bufIdx = this.bufIdx;
        let gPrev = this.gPrev;
        let gNext = this.gNext;
        let phase = this.phase;
        let delayIdx = this.delayIdx;

        for (let i = 0; i < N; i++) {
            const s = samples[i];
            const absS = s < 0 ? -s : s;
            env = absS > env ? absS : env * decay;
            fastEnv = absS > fastEnv ? absS : fastEnv * fastDecay;
            if (absS > blockPeak) blockPeak = absS;

            if (phase === 0) {
                floorBlockSum += fastEnv;
                if (++floorBlockTick >= floorBlockTicks) {
                    floorBlockTick = 0;
                    floorBlocks[floorBlockIdx] = floorBlockSum / floorBlockTicks;
                    floorBlockIdx = floorBlockIdx === floorBlocks.length - 1 ? 0 : floorBlockIdx + 1;
                    floorBlockSum = 0.0;
                }
                let minHold = floorBlocks[0];
                for (let k = 1; k < floorBlocks.length; k++) if (floorBlocks[k] < minHold) minHold = floorBlocks[k];
                floor = minHold < floor ? minHold : floor + (minHold - floor) * floorUp;
                if (floor < 1e-7) floor = 1e-7;

                // Block peak (not the decayed envelope) so the gain covers every sample in the block
                let inMag = env > blockPeak ? env : blockPeak;
                if (inMag < 1e-6) inMag = 1e-6;
                blockPeak = 0.0;
                const gInst = Math.min(maxGain, (maxOut * (1.0 - Math.exp(-inMag / (knee * floor)))) / inMag);

                minBuf[bufIdx] = gInst;
                let gMin = minBuf[0];
                for (let k = 1; k < L; k++) if (minBuf[k] < gMin) gMin = minBuf[k];
                firBuf[bufIdx] = gMin;

                let gFilt = 0.0;
                let r = bufIdx;
                for (let k = 0; k < L; k++) {
                    gFilt += firBuf[r] * weights[k];
                    r = r === 0 ? L - 1 : r - 1;
                }

                gPrev = gNext;
                gNext = gFilt;
                bufIdx = bufIdx === L - 1 ? 0 : bufIdx + 1;
            }

            // Linear ramp between consecutive gain updates
            const g = gPrev + (gNext - gPrev) * ((phase + 1) / dec);
            phase = phase === dec - 1 ? 0 : phase + 1;

            const delayed = delayBuf[delayIdx];
            delayBuf[delayIdx] = s;
            delayIdx = delayIdx === delayLen - 1 ? 0 : delayIdx + 1;

            samples[i] = delayed * g;
        }

        this.env = env;
        this.fastEnv = fastEnv;
        this.floorBlockSum = floorBlockSum;
        this.floorBlockIdx = floorBlockIdx;
        this.floorBlockTick = floorBlockTick;
        this.blockPeak = blockPeak;
        this.noiseFloor = floor;
        this.bufIdx = bufIdx;
        this.gPrev = gPrev;
        this.gNext = gNext;
        this.phase = phase;
        this.delayIdx = delayIdx;
        return samples;
    }
}

if (typeof module !== 'undefined') module.exports = AGC;
