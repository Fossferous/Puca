/**
 * Spike S1 result collector.
 *
 * The previous S1 attempt failed for a reason that had nothing to do with
 * WebView2: it had no way to tell "the promise is still pending" from "the whole
 * page is wedged". Both look like silence. So this run reports every step over
 * HTTP as it happens, and the page emits a heartbeat — if the heartbeats keep
 * arriving while the capture promise stays quiet, the page is alive and the
 * promise really is pending. If the heartbeats stop, something else broke.
 *
 * A plain HTTP sink rather than a Tauri command on purpose: no app changes, so
 * the thing under test is the shipped webview and not a modified one.
 *
 *   node collector.mjs            # listens on 127.0.0.1:8791
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.S1_PORT ?? 8791);
const started = Date.now();
const t = () => `${String((Date.now() - started) / 1000).padStart(6, ' ')}s`;

let heartbeats = 0;
let lastHeartbeat = 0;

const server = createServer((req, res) => {
    // The page is served from the same origin so fetch() needs no CORS dance,
    // but allow it anyway in case the app loads it cross-origin.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
    }

    if (req.method === 'POST' && req.url === '/log') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            try {
                const ev = JSON.parse(body);
                if (ev.kind === 'heartbeat') {
                    heartbeats++;
                    lastHeartbeat = Date.now();
                    // Heartbeats are noise until something is waiting on them;
                    // print one in five so the log stays readable but a stall is
                    // still visible.
                    if (heartbeats % 5 === 0) {
                        console.log(`${t()} .. still alive (${heartbeats} beats, ${ev.note ?? ''})`);
                    }
                } else {
                    console.log(`${t()} ${ev.kind.toUpperCase()}: ${ev.msg}`);
                }
            } catch {
                console.log(`${t()} RAW: ${body.slice(0, 300)}`);
            }
            res.writeHead(204).end();
        });
        return;
    }

    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/index'))) {
        // Serve the harness itself, so the whole spike is one command.
        import('node:fs').then((fs) => {
            const html = fs.readFileSync(new URL('./harness.html', import.meta.url), 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
        });
        return;
    }

    res.writeHead(404).end();
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`S1 collector on http://127.0.0.1:${PORT}/`);
    console.log('Point the Tauri shell at that URL. Ctrl-C to stop.\n');
});

// If heartbeats stop while we are still waiting, say so — silence must not be
// mistaken for a result.
setInterval(() => {
    if (heartbeats > 0 && Date.now() - lastHeartbeat > 8000) {
        console.log(`${t()} !! heartbeats STOPPED — the page is wedged, not merely pending`);
        lastHeartbeat = Date.now();
    }
}, 4000);
