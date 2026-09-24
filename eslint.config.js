'use strict';
/**
 * ESLint for a no-build app: app/js/*.js are classic <script> files that share one global scope
 * (see app/index.html), so a class declared in fft.js is a global in app.js. Instead of a hand-kept
 * list, the cross-file globals are read from the files' own top-level declarations, and each file
 * is linted with every *other* file's globals (its own stay declarations, so no-redeclare works).
 */
const fs = require('fs');
const path = require('path');
const js = require('@eslint/js');
const globals = require('globals');

const APP = path.join(__dirname, 'app', 'js');
const TOP_LEVEL = /^(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;

const declared = {};
for (const file of fs.readdirSync(APP).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(APP, file), 'utf8');
    declared[file] = new Set(Array.from(src.matchAll(TOP_LEVEL), (m) => m[1]));
}
const othersOf = (file) => {
    const out = {};
    for (const [other, names] of Object.entries(declared)) {
        if (other === file) continue;
        for (const n of names) if (!file || !declared[file].has(n)) out[n] = 'readonly';
    }
    return out;
};

// Browser scope, plus the CommonJS footer every module uses so Node tests can require() it.
const shared = { ...globals.browser, module: 'writable', require: 'readonly' };
const worker = { ...globals.worker, module: 'writable', require: 'readonly' };
const worklet = {
    ...globals.audioWorklet,
    module: 'writable',
    require: 'readonly',
};
const WORKER_FILES = new Set(['cw_decoder_worker.js']);
// Worklet-only files; resampler, audio_ring, cw_keyer, soundcard, demodulator and ic7300_if also load
// in the page, where the browser globals apply.
const WORKLET_FILES = new Set(['audio_worklet.js', 'audio_capture_worklet.js']);

const rules = {
    'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
    'no-empty': ['error', { allowEmptyCatch: true }],
};

module.exports = [
    { ignores: ['app/lib/**', 'app/models/**', 'node_modules/**', 'tmp/**', '.venv/**', 'htmlcov/**'] },
    js.configs.recommended,
    ...Object.keys(declared).map((file) => {
        const env = WORKER_FILES.has(file) ? worker : WORKLET_FILES.has(file) ? worklet : shared;
        return {
            files: [`app/js/${file}`],
            languageOptions: {
                ecmaVersion: 2023,
                sourceType: 'script',
                globals: { ...env, ...othersOf(file) },
            },
            rules: {
                ...rules,
                // A declaration that is only used by other scripts looks unused from inside its file.
                'no-unused-vars': ['error', { ...rules['no-unused-vars'][1], vars: 'local' }],
            },
        };
    }),
    {
        files: ['scripts/**/*.js', 'eslint.config.js'],
        languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } },
        rules,
    },
    {
        // tests/js/load.js installs the app modules as Node globals, as the page does.
        files: ['tests/**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'commonjs',
            globals: { ...globals.node, ...othersOf(null) },
        },
        rules,
    },
];
