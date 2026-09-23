/**
 * didahSDR - source lifecycle contract.
 *
 * Duck-typed. Each source provides start(), stop(), connected, and the callbacks
 * onRawIQ(Float32 interleaved ±1, nComplex), onReady, onStatus, onCenterApplied.
 * Tuning policy stays per protocol; this table only says who owns the centre.
 */

const SOURCE_POLICY = {
    didah: { movesCenter: false, label: 'didah 0x03 IQ' },
    kiwi: { movesCenter: true, label: 'KiwiSDR SND IQ' },
    soundcard: { movesCenter: false, label: 'Sound card IQ' },
    ic7300: { movesCenter: true, label: 'IC-7300 IF' },
    rtlsdr: { movesCenter: true, label: 'RTL-SDR IQ' }
};

/**
 * A sample batch is accepted only from the active source, and only from the
 * start() generation that is still current.
 */
function acceptIq(activeProtocol, ownerProtocol, connected, gen, feedGen) {
    if (activeProtocol !== ownerProtocol || !connected) return false;
    if (gen == null) return true;
    return gen === feedGen;
}

/** Keep the spectrum ring index inside the buffer. A hidden tab used to let it go negative. */
function capRingAvailable(available, ringSize) {
    const n = available | 0;
    const cap = ringSize | 0;
    if (n > cap) return cap;
    if (n < 0) return 0;
    return n;
}

if (typeof globalThis !== 'undefined') {
    globalThis.SOURCE_POLICY = SOURCE_POLICY;
    globalThis.acceptIq = acceptIq;
    globalThis.capRingAvailable = capRingAvailable;
}
if (typeof module !== 'undefined') {
    module.exports = { SOURCE_POLICY, acceptIq, capRingAvailable };
}
