/**
 * didahSDR - IQ source catalog
 *
 * Replay uses the local didah WebSocket (0x03 int16 IQ). Sound card uses the
 * browser microphone API (stereo I/Q at 48/96/192 kHz). Kiwi uses a direct SND
 * connection in mod=iq. Presets are applied when the operator picks a source.
 */
const SOURCES = [
    {
        id: 'va2gka',
        label: 'VA2GKA Replay',
        protocol: 'didah',
        minLevel: -127,
        dynamicRange: 60,
        fftSize: 2048,
        startFreq: 14048700,
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
        host: 'f4kiy.ddns.net',
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
    }
];

function findSource(id) {
    return SOURCES.find((s) => s.id === id) || SOURCES[0];
}

if (typeof module !== 'undefined') module.exports = { SOURCES, findSource };
