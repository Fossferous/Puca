// Serve frontend/dist on a free port, for checking the ACTUAL BUILT BUNDLE.
//
// WHY THIS EXISTS RATHER THAN A DEV SERVER. Both checkouts on this machine
// define a `frontend-dev` launch config on port 5173, so starting one from the
// wrong project root silently serves the OTHER tree — a stale one that does not
// even contain the files under test — while every check happily passes. That
// happened here: a render smoke reported green against a tree with none of this
// release in it.
//
// Serving dist/ removes the ambiguity in both directions: the path is explicit,
// and what is tested is the bundle that actually ships rather than a dev-mode
// transpile of it.
//
// Usage:  node e2e/serve-dist.mjs        (prints the URL, serves until killed)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('../dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2',
    '.wasm': 'application/wasm', '.map': 'application/json',
};

const server = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];
    // Contain the path: a built bundle should never be able to read outside
    // dist/, and this server exists only to be pointed at by a test.
    const rel = normalize(decodeURIComponent(url)).replace(/^([/\\])+/, '');
    if (rel.includes('..')) { res.writeHead(403); return res.end('no'); }
    for (const candidate of [join(ROOT, rel), join(ROOT, 'index.html')]) {
        try {
            const body = await readFile(candidate);
            res.writeHead(200, { 'content-type': TYPES[extname(candidate)] || 'application/octet-stream' });
            return res.end(body);
        } catch { /* fall through to the SPA index */ }
    }
    res.writeHead(404); res.end('not found');
});

await new Promise(r => server.listen(Number(process.env.PORT || 0), '127.0.0.1', r));
console.log(`serving ${ROOT} at http://127.0.0.1:${server.address().port}/`);
