/**
 * Does the server ACCEPT a bearer subprotocol and echo the marker back?
 *
 * WHY THIS IS WORTH A REAL HANDSHAKE. A browser that offers a subprotocol and
 * receives no selection FAILS the connection outright. So an implementation
 * that authenticates correctly but forgets to echo looks perfect in unit tests
 * and breaks every web and desktop client the moment it ships. Only a real
 * handshake shows the response header.
 *
 * Raw HTTP so we can read `Sec-WebSocket-Protocol` off the 101 — a WebSocket
 * client library would swallow it.
 *
 *   node ws-handshake-check.mjs <port> <jwt-secret>
 */
import { createHmac, randomBytes } from 'node:crypto';
import net from 'node:net';

const PORT = Number(process.argv[2] || 3002);
const SECRET = process.argv[3];
if (!SECRET) { console.error('usage: ws-handshake-check.mjs <port> <secret>'); process.exit(2); }

const b64u = (b) => Buffer.from(b).toString('base64url');
function jwt(payload, secret) {
    const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const p = b64u(JSON.stringify(payload));
    const sig = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
    return `${h}.${p}.${sig}`;
}

/** One raw upgrade attempt; resolves with the status line and headers. */
function handshake({ useSubprotocol, token }) {
    return new Promise((resolve) => {
        const sock = net.connect(PORT, '127.0.0.1');
        let buf = '';
        const done = (r) => { try { sock.destroy(); } catch {} resolve(r); };
        sock.setTimeout(8000, () => done({ error: 'timeout' }));
        sock.on('error', (e) => done({ error: String(e.message || e) }));
        sock.on('connect', () => {
            const path = useSubprotocol ? '/ws' : `/ws?token=${encodeURIComponent(token)}`;
            const lines = [
                `GET ${path} HTTP/1.1`,
                `Host: 127.0.0.1:${PORT}`,
                'Upgrade: websocket',
                'Connection: Upgrade',
                `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
                'Sec-WebSocket-Version: 13',
            ];
            if (useSubprotocol) lines.push(`Sec-WebSocket-Protocol: bearer, ${token}`);
            sock.write(lines.join('\r\n') + '\r\n\r\n');
        });
        sock.on('data', (d) => {
            buf += d.toString('latin1');
            if (!buf.includes('\r\n\r\n')) return;
            const head = buf.split('\r\n\r\n')[0];
            const [status, ...rest] = head.split('\r\n');
            const headers = {};
            for (const line of rest) {
                const i = line.indexOf(':');
                if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
            }
            done({ status, headers });
        });
    });
}

const now = Math.floor(Date.now() / 1000);
const good = jwt({ sub: 1, username: 'wstester', exp: now + 3600, tv: 0, sst: now }, SECRET);

let pass = 0, fail = 0;
const ck = (c, label, extra = '') => { c ? (pass++, console.log('PASS', label, extra)) : (fail++, console.log('FAIL', label, extra)); };

console.log('--- subprotocol path (the new client) ---');
const a = await handshake({ useSubprotocol: true, token: good });
ck(/101/.test(a.status || ''), 'upgrade accepted with a bearer subprotocol', a.status || a.error);
ck(
    a.headers?.['sec-websocket-protocol'] === 'bearer',
    'server echoed the MARKER back (a browser fails the connection without this)',
    `-> ${JSON.stringify(a.headers?.['sec-websocket-protocol'])}`,
);
ck(
    !(a.headers?.['sec-websocket-protocol'] || '').includes('.'),
    'the echo does NOT contain the token (that would put it in a response header)',
);

console.log('--- query path (RETIRED in 0.9.1: a token in the URL lands in every access log) ---');
const b = await handshake({ useSubprotocol: false, token: good });
ck(!/101/.test(b.status || ''), 'a VALID token in the query string is refused (nothing but the subprotocol is accepted)', b.status || b.error);

console.log('--- negative control ---');
const c = await handshake({ useSubprotocol: true, token: 'not.a.valid.jwt' });
ck(!/101/.test(c.status || ''), 'a bogus token is refused even with a good subprotocol', c.status || c.error);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
