/**
 * didahSDR - IQ source catalog
 *
 * Replay uses the local didah WebSocket (0x03 int16 IQ). Sound card uses the
 * browser microphone API (stereo I/Q at 48/96/192 kHz). The IC-7300 source is the
 * radio's real 12 kHz USB IF plus CI-V. RTL-SDR is a local WebUSB stick decimated
 * to 192 kHz. Kiwi uses a direct SND connection in mod=iq. Presets are applied
 * when the operator picks a source.
 */
const SOURCES = [
    {
        id: 'va2gka',
        label: 'VA2GKA Replay',
        protocol: 'didah',
        minLevel: -130,
        dynamicRange: 60,
        fftSize: 2048,
        startFreq: 14050800,
        startMod: 'cw',
        note: 'Local 96 kHz IQ recording, looped.'
    },
    {
        id: 'soundcard',
        label: 'Sound card',
        protocol: 'soundcard',
        minLevel: -90,
        dynamicRange: 50,
        fftSize: 2048,
        startFreq: 0,
        startMod: 'cw',
        note: 'Local stereo IQ at 48 / 96 / 192 kHz. Center is 0 Hz (offset).'
    },
    {
        id: 'f4kiy',
        label: 'KiwiSDR Live',
        protocol: 'kiwi',
        host: 'oh5ae.dyndns.org',
        port: 8073,
        secure: false,
        password: '',
        minLevel: -90,
        dynamicRange: 50,
        fftSize: 2048,
        startFreq: 7100000,
        startMod: 'cw',
        iqLowCut: -5980,
        iqHighCut: 5980,
        note: '12 kHz IQ zoom. Paste a KiwiSDR http(s) URL (host and port).'
    },
    {
        id: 'ic7300',
        label: 'IC-7300',
        protocol: 'ic7300',
        minLevel: -90,
        dynamicRange: 50,
        fftSize: 2048,
        startFreq: -650,
        startMod: 'cw',
        note: 'Icom IC-7300 USB IF, mixed to complex baseband at 12 kHz. The dial and Shift+drag set the VFO; USB/LSB listen, CW transmits.'
    },
    {
        id: 'rtlsdr',
        label: 'RTL-SDR',
        protocol: 'rtlsdr',
        minLevel: -90,
        dynamicRange: 50,
        fftSize: 2048,
        startFreq: 14048000,
        startMod: 'cw',
        note: 'RTL2832U over WebUSB, decimated to 192 kHz. Direct sampling Q is the HF path on a Blog V3.'
    }
];

function findSource(id) {
    return SOURCES.find((s) => s.id === id) || SOURCES[0];
}

if (typeof module !== 'undefined') module.exports = { SOURCES, findSource };
