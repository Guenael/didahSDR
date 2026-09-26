'use strict';

/**
 * Localhost static server for the Electron window.
 *
 * The page must be http://127.0.0.1 (a secure context) with the same
 * cross-origin isolation headers the Python server sends, so AudioWorklet
 * and SharedArrayBuffer work. It only reads files inside `root`.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
    '.mjs': 'text/javascript',
    '.onnx': 'application/octet-stream',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.map': 'application/json',
    '.txt': 'text/plain; charset=utf-8'
};

const ISOLATION = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin'
};

/** Absolute file inside `root`, or null when the URL escapes the tree or is not a path. */
function resolveAppFile(root, urlPath) {
    let rel;
    try {
        rel = decodeURIComponent(String(urlPath || '/').split('?')[0]);
    } catch (e) {
        return null;
    }
    if (rel.includes('\0')) return null;
    if (rel === '/') rel = '/index.html';
    const rootResolved = path.resolve(root);
    const file = path.resolve(rootResolved, '.' + rel);
    if (file !== rootResolved && !file.startsWith(rootResolved + path.sep)) return null;
    return file;
}

function createStaticServer(root) {
    const rootResolved = path.resolve(root);
    return http.createServer((req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, ISOLATION);
            res.end();
            return;
        }
        const file = resolveAppFile(rootResolved, req.url);
        if (!file) {
            res.writeHead(403, ISOLATION);
            res.end();
            return;
        }
        fs.stat(file, (err, st) => {
            if (err || !st.isFile()) {
                res.writeHead(404, ISOLATION);
                res.end();
                return;
            }
            const headers = Object.assign({
                'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
                'Content-Length': st.size
            }, ISOLATION);
            res.writeHead(200, headers);
            if (req.method === 'HEAD') {
                res.end();
                return;
            }
            fs.createReadStream(file).pipe(res);
        });
    });
}

/** Listen on 127.0.0.1, port chosen by the OS. Resolves the listening server. */
function listen(root) {
    const server = createStaticServer(root);
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

module.exports = { createStaticServer, listen, resolveAppFile, MIME };
