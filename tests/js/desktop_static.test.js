'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listen, resolveAppFile } = require('../../desktop/static_server');

function get(url, method = 'GET') {
    return new Promise((resolve, reject) => {
        const req = http.request(url, { method }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks)
            }));
        });
        req.on('error', reject);
        req.end();
    });
}

test('resolveAppFile stays inside the app directory', () => {
    const root = path.join(os.tmpdir(), 'didah-app');
    assert.equal(resolveAppFile(root, '/'), path.join(root, 'index.html'));
    assert.equal(resolveAppFile(root, '/js/app.js'), path.join(root, 'js', 'app.js'));
    assert.equal(resolveAppFile(root, '/../package.json'), null);
    assert.equal(resolveAppFile(root, '/%2e%2e/package.json'), null);
    assert.equal(resolveAppFile(root, '/%00index.html'), null);
});

test('static server sends cross-origin isolation headers and does not follow escapes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'didah-static-'));
    fs.mkdirSync(path.join(root, 'js'));
    fs.writeFileSync(path.join(root, 'index.html'), '<title>didahSDR</title>');
    fs.writeFileSync(path.join(root, 'js', 'modes.js'), '/* modes */');
    const server = await listen(root);
    const port = server.address().port;
    try {
        const page = await get(`http://127.0.0.1:${port}/`);
        assert.equal(page.status, 200);
        assert.equal(page.headers['cross-origin-opener-policy'], 'same-origin');
        assert.equal(page.headers['cross-origin-embedder-policy'], 'require-corp');
        assert.equal(page.headers['cross-origin-resource-policy'], 'same-origin');
        assert.match(page.body.toString(), /didahSDR/);

        const script = await get(`http://127.0.0.1:${port}/js/modes.js`, 'HEAD');
        assert.equal(script.status, 200);
        assert.equal(script.headers['content-type'], 'text/javascript; charset=utf-8');
        assert.equal(script.body.length, 0);

        const missing = await get(`http://127.0.0.1:${port}/no-such.js`);
        assert.equal(missing.status, 404);

        const escape = await get(`http://127.0.0.1:${port}/../package.json`);
        assert.notEqual(escape.status, 200);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    }
});
