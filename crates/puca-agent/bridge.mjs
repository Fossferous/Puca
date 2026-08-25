/**
 * HTTP <-> named-pipe bridge, for the live browser test ONLY.
 *
 * The agent speaks newline-delimited JSON over a Windows named pipe, which a
 * browser cannot open. In the real product the Tauri app is the bridge
 * (agent_ipc.rs); this is the same conversation over HTTP so a plain page can
 * hold it, which is what makes the media path testable without building and
 * installing the desktop app first.
 *
 * NOT part of the product, and deliberately so: it binds loopback only, and it
 * exists purely to answer "do frames actually reach Chromium".
 *
 *   node bridge.mjs --pipe sovereign-agent-live --token <token> [--port 8790]
 */
import { createServer } from 'node:http';
import { connect } from 'node:net';

const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i > -1 ? process.argv[i + 1] : fallback;
};

const pipeName = arg('--pipe', 'sovereign-agent-live');
const token = arg('--token', '');
const port = Number(arg('--port', '8790'));
if (!token) {
    console.error('--token is required');
    process.exit(2);
}

const pipePath = `\\\\.\\pipe\\${pipeName}`;
const sock = connect(pipePath);

/** One in-flight request at a time — the agent answers one line per line. */
const queue = [];
let buffer = '';

sock.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        const waiter = queue.shift();
        if (waiter) waiter(line);
    }
});
sock.on('error', e => {
    console.error(`pipe error: ${e.message}`);
    process.exit(1);
});

function send(obj) {
    return new Promise(resolve => {
        queue.push(resolve);
        sock.write(JSON.stringify(obj) + '\n');
    });
}

await new Promise(r => sock.on('connect', r));
const hello = await send({ cmd: 'hello', token, version: 1 });
if (!hello.includes('"ok":"hello"')) {
    console.error(`agent refused the token: ${hello}`);
    process.exit(1);
}
console.log('bridge: authenticated to the agent');

createServer((req, res) => {
    // Loopback only, and the page is served from here too, so a permissive
    // header costs nothing and avoids a preflight dance in the test.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    if (req.method === 'OPTIONS') {
        res.end();
        return;
    }
    if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
    }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
        try {
            const parsed = JSON.parse(body);
            // The harness reports its verdict here rather than to a console we
            // cannot read: launching a real browser is the only way to control
            // its mDNS flag, and that browser's devtools are not reachable.
            if (parsed.cmd === 'report') {
                console.log('=== HARNESS RESULT ===');
                for (const r of parsed.results ?? []) {
                    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  --  ' + r.detail : ''}`);
                }
                console.log(`SUMMARY ${parsed.summary}`);
                res.end('{"ok":"ok"}');
                return;
            }
            const reply = await send(parsed);
            res.setHeader('content-type', 'application/json');
            res.end(reply);
        } catch (e) {
            res.writeHead(500).end(JSON.stringify({ ok: 'error', message: String(e) }));
        }
    });
}).listen(port, '127.0.0.1', () => console.log(`bridge: listening on 127.0.0.1:${port}`));
