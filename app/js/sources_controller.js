/**
 * didahSDR - source lifecycle contract.
 *
 * Duck-typed. Each source provides start(), stop(), connected, and the callbacks
 * onRawIQ(Float32 interleaved ±1, nComplex), onReady, onStatusChange and, when the
 * radio moves, onCenterApplied.
 *
 * `followsDial`: the app retunes the source's centre when the dial leaves the IQ window
 * (Kiwi DDC, RTL LO). The IC-7300 also moves, but its VFO is owned by the radio (CI-V),
 * so it is handled separately.
 */

const SOURCE_POLICY = {
    didah: { followsDial: false, label: 'didah 0x03 IQ' },
    kiwi: { followsDial: true, label: 'KiwiSDR SND IQ' },
    soundcard: { followsDial: false, label: 'Sound card IQ' },
    ic7300: { followsDial: false, label: 'IC-7300 IF' },
    rtlsdr: { followsDial: true, label: 'RTL-SDR IQ' }
};

/** Policy for a protocol; unknown protocols behave like the local replay. */
function sourcePolicy(protocol) {
    return SOURCE_POLICY[protocol] || SOURCE_POLICY.didah;
}

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
    globalThis.sourcePolicy = sourcePolicy;
    globalThis.acceptIq = acceptIq;
    globalThis.capRingAvailable = capRingAvailable;
}
if (typeof module !== 'undefined') {
    module.exports = { SOURCE_POLICY, sourcePolicy, acceptIq, capRingAvailable };
}
