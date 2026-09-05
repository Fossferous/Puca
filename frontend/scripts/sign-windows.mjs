#!/usr/bin/env node
/**
 * Authenticode signing for the Windows artefacts, in the ONE place it can go.
 *
 * Tauri invokes `bundle.windows.signCommand` on the application binary and on
 * the installer BEFORE it produces the updater signature (the minisign .sig),
 * which is why it is a config hook and not a post-build step: signing an
 * installer after Tauri has already signed it for the updater changes the
 * bytes the .sig covers, and every auto-update then fails verification. The
 * sidecars (puca-agent, puca-service) are not covered by the hook; they are
 * signed where they are staged, in build-agent.mjs, before Tauri bundles them.
 *
 * Nothing here is configured today: the project has no certificate (see
 * docs/FAQ.md, "Why does Windows warn me"). Unconfigured, this prints one line
 * and exits 0, and the build is unsigned exactly as before. Configure with
 * environment variables, never with anything committed:
 *
 *   A certificate file (PFX):
 *     AUTHENTICODE_PFX_PATH=C:\path\to\cert.pfx      or  AUTHENTICODE_PFX_BASE64=<base64 of the file>
 *     AUTHENTICODE_PFX_PASSWORD=...                   (passed to signtool via /p; never printed)
 *   Azure Trusted Signing (signtool with the Azure dlib; needs the Azure CLI
 *   or an environment credential signtool can pick up):
 *     AZURE_TRUSTED_SIGNING_ENDPOINT=https://<region>.codesigning.azure.net
 *     AZURE_TRUSTED_SIGNING_ACCOUNT=<account>  AZURE_TRUSTED_SIGNING_PROFILE=<profile>
 *     AZURE_CODESIGNING_DLIB=C:\path\to\Azure.CodeSigning.Dlib.dll
 *   Either way:
 *     AUTHENTICODE_TIMESTAMP_URL   (default http://timestamp.digicert.com)
 *     SIGNTOOL_PATH                (else a signtool.exe on PATH, else the newest Windows Kits one)
 *
 * Usage (what Tauri runs):  node scripts/sign-windows.mjs <file>   (no quotes: Tauri splits on spaces, no shell)
 * Also importable: signFile(path) -> true if signed, false if not configured.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMESTAMP_URL = process.env.AUTHENTICODE_TIMESTAMP_URL || 'http://timestamp.digicert.com';

function findSigntool() {
    if (process.env.SIGNTOOL_PATH && existsSync(process.env.SIGNTOOL_PATH)) return process.env.SIGNTOOL_PATH;
    try {
        execFileSync('where', ['signtool.exe'], { stdio: 'ignore' });
        return 'signtool.exe';
    } catch { /* not on PATH */ }
    const kits = join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
    if (!existsSync(kits)) return null;
    // Newest SDK version, x64 host.
    const versions = readdirSync(kits).filter(v => /^\d+\.\d+/.test(v)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) {
        const p = join(kits, v, 'x64', 'signtool.exe');
        if (existsSync(p)) return p;
    }
    return null;
}

/** What the environment asks for, or null when nothing is configured. */
export function signingConfig(env = process.env) {
    if (env.AUTHENTICODE_PFX_PATH || env.AUTHENTICODE_PFX_BASE64) {
        return { kind: 'pfx', path: env.AUTHENTICODE_PFX_PATH || null, base64: env.AUTHENTICODE_PFX_BASE64 || null, password: env.AUTHENTICODE_PFX_PASSWORD || '' };
    }
    if (env.AZURE_TRUSTED_SIGNING_ENDPOINT && env.AZURE_TRUSTED_SIGNING_ACCOUNT && env.AZURE_TRUSTED_SIGNING_PROFILE && env.AZURE_CODESIGNING_DLIB) {
        return { kind: 'azure', endpoint: env.AZURE_TRUSTED_SIGNING_ENDPOINT, account: env.AZURE_TRUSTED_SIGNING_ACCOUNT, profile: env.AZURE_TRUSTED_SIGNING_PROFILE, dlib: env.AZURE_CODESIGNING_DLIB };
    }
    return null;
}

/**
 * Sign one file in place. Returns true when a signature was applied, false
 * when nothing is configured (the artefact stays unsigned, as today). Throws
 * when signing was configured and FAILED — a configured-but-broken signer
 * must stop the build, never ship an unsigned artefact that everyone believes
 * is signed.
 */
export function signFile(filePath, env = process.env) {
    const cfg = signingConfig(env);
    if (!cfg) {
        // Nothing configured: the unsigned build of today, and nothing about
        // the path may make this branch fail — it runs on every Windows build.
        console.log(`[sign-windows] no signing configured; ${filePath} stays unsigned`);
        return false;
    }
    if (!existsSync(filePath)) throw new Error(`[sign-windows] no such file: ${filePath}`);
    if (process.platform !== 'win32') throw new Error('[sign-windows] Authenticode signing runs on Windows (signtool); cross-signing is not set up');
    const signtool = findSigntool();
    if (!signtool) throw new Error('[sign-windows] signing is configured but signtool.exe was not found (install the Windows SDK or set SIGNTOOL_PATH)');

    let tempDir = null;
    try {
        const args = ['sign', '/fd', 'SHA256', '/tr', TIMESTAMP_URL, '/td', 'SHA256'];
        if (cfg.kind === 'pfx') {
            let pfx = cfg.path;
            if (!pfx) {
                tempDir = mkdtempSync(join(tmpdir(), 'puca-sign-'));
                pfx = join(tempDir, 'cert.pfx');
                writeFileSync(pfx, Buffer.from(cfg.base64, 'base64'));
            }
            args.push('/f', pfx);
            if (cfg.password) args.push('/p', cfg.password);
        } else {
            tempDir = mkdtempSync(join(tmpdir(), 'puca-sign-'));
            const meta = join(tempDir, 'metadata.json');
            writeFileSync(meta, JSON.stringify({ Endpoint: cfg.endpoint, CodeSigningAccountName: cfg.account, CertificateProfileName: cfg.profile }));
            args.push('/dlib', cfg.dlib, '/dmdf', meta);
        }
        args.push(filePath);
        // The password is an argument, not printed: log the command with it masked.
        console.log(`[sign-windows] signing ${filePath} (${cfg.kind}, timestamp ${TIMESTAMP_URL})`);
        const r = spawnSync(signtool, args, { stdio: ['ignore', 'inherit', 'inherit'] });
        if (r.status !== 0) throw new Error(`[sign-windows] signtool exited ${r.status} for ${filePath}`);
        return true;
    } finally {
        if (tempDir) { try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ } }
    }
}

// CLI: what Tauri's signCommand runs. Tauri splits the string form of
// signCommand on spaces and passes each token as a raw argv element — no
// shell, so quotes in the config arrive as literal characters. The config
// carries none, and a matched pair is stripped here anyway so a quoted path
// can never turn into "no such file".
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const files = process.argv.slice(2).map(f => f.replace(/^"(.*)"$/, '$1'));
    if (files.length === 0) {
        console.error('usage: node scripts/sign-windows.mjs <file> [<file>...]');
        process.exit(2);
    }
    try {
        for (const f of files) signFile(f);
    } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
    }
}
