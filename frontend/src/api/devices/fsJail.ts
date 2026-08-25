/**
 * Path jail for the PHONE-side file server — the JS port of the rules in
 * `crates/puca-agent/src/file_transfer.rs` (`normalize_lexical` +
 * `is_within`), adjusted for POSIX paths on Android.
 *
 * EVERY REQUEST IS CONFINED BY A ROOT THE PHONE'S USER PICKED. The wire
 * protocol carries peer-chosen paths, and the phone grants one folder from a
 * fixed list — so the jail is what stands between "browse my Downloads" and
 * "read the whole phone". Two gates, both of which must pass, mirroring the
 * agent:
 *
 * 1. LEXICAL (this module, pure): `.` collapsed, `..` REFUSED when it would
 *    pop past the granted root (refuse-not-clamp — silently rewriting an
 *    escape to the root would let a traversal read the root and look like it
 *    worked), NUL bytes refused, and a component-wise prefix check — never a
 *    string prefix, because `/granted-evil` starts with `/granted` as a
 *    STRING but is not under it.
 * 2. REAL PATH (the caller, via the native plugin's canonicalize): the
 *    lexical result resolved through the filesystem must STILL be inside the
 *    canonical root. Shared-storage FUSE does not let apps create symlinks,
 *    so on Android this is belt-and-braces — but it is five lines of Java and
 *    it closes the class.
 *
 * CASE: the jail comparison is CASE-SENSITIVE even though Android's shared
 * storage (FUSE) is case-insensitive since 11. A case-sensitive check on a
 * case-insensitive filesystem can only refuse a path the OS would have
 * allowed — the safe direction. Folding case here would instead OPEN a hole
 * on any case-sensitive mount. The deny-shape check below folds case the
 * other way for the same reason: denying more is safe.
 */

import type { FsEntry } from './fileTransfer';

/** Mirror of the agent's `MAX_READ_LEN` / `MAX_WRITE_LEN`. */
export const FS_MAX_IO = 64 * 1024;

/** Component pairs refused wherever they appear: other apps' sandboxes,
 *  which the OS blocks even with all-files access on 11+ — refusing them here
 *  gives a clean refusal instead of a confusing EACCES, and keeps them out
 *  of listings a peer could get ideas from. Compared case-insensitively:
 *  shared-storage FUSE is case-insensitive, and over-denying is safe. */
const DENIED_SHAPES: string[][] = [
    ['android', 'data'],
    ['android', 'obb'],
];

/** Split a POSIX path into components, validating shape. Null = refused. */
function components(p: string): string[] | null {
    if (p.includes('\0')) return null;
    if (!p.startsWith('/')) return null;
    const out: string[] = [];
    for (const part of p.split('/')) {
        if (part === '' || part === '.') continue;
        if (part === '..') {
            // Refuse rather than clamp — see the module header.
            if (out.length === 0) return null;
            out.pop();
            continue;
        }
        out.push(part);
    }
    return out;
}

/** Is `child` at or underneath `parent`? Component-wise, case-sensitive. */
export function isWithin(child: string, parent: string): boolean {
    const c = components(child);
    const p = components(parent);
    if (!c || !p) return false;
    if (p.length > c.length) return false;
    for (let i = 0; i < p.length; i++) {
        if (c[i] !== p[i]) return false;
    }
    return true;
}

/**
 * Resolve `requested` against the granted `root`, lexically.
 *
 * A relative path resolves against the root; an absolute one must land inside
 * it. Returns the normalised absolute path, or null for anything refused —
 * and the caller must then run the CANONICAL check (gate 2) before touching
 * the filesystem.
 */
export function resolveLexical(root: string, requested: string): string | null {
    const rootC = components(root);
    if (!rootC) return null;
    const joined = requested.startsWith('/')
        ? requested
        : root.replace(/\/+$/, '') + '/' + requested;
    const c = components(joined);
    if (!c) return null;
    const resolved = '/' + c.join('/');
    if (!isWithin(resolved, root)) return null;

    // The deny shapes are ABSOLUTE — matched anywhere in the resolved path,
    // not relative to the grant. A grant-relative check had a hole: a root of
    // …/Android (however it got granted) would serve its data/ children,
    // which is exactly the OS-guarded sandbox tree. Matching the component
    // PAIR anywhere over-denies a user's own folder literally named
    // Android/data somewhere deep — rare, harmless, and the safe direction.
    const lower = c.map(x => x.toLowerCase());
    for (const denied of DENIED_SHAPES) {
        for (let i = 0; i + denied.length <= lower.length; i++) {
            if (denied.every((d, j) => lower[i + j] === d)) return null;
        }
    }
    return resolved;
}

/** What a provider must answer about a path before serving it. */
export interface FsStat {
    exists: boolean;
    is_dir: boolean;
    size: number;
}

/**
 * The filesystem the server runs against — injected, so the protocol logic is
 * testable in jsdom without Capacitor. `read` returns BASE64 (which is the
 * wire format — the Capacitor plugin hands base64 back natively, so there is
 * no decode/re-encode anywhere on the phone). `canonicalize` is gate 2.
 */
export interface FsProvider {
    stat(path: string): Promise<FsStat>;
    readdir(path: string): Promise<FsEntry[]>;
    read(path: string, offset: number, length: number): Promise<string>;
    /** Replace the whole file with this content (offset-0 writes). */
    writeReplace(path: string, dataB64: string): Promise<void>;
    /** Append to the end (offset === current size writes). */
    append(path: string, dataB64: string): Promise<void>;
    canonicalize(path: string): Promise<string>;
}

/**
 * Both gates. Returns the path to hand the provider, or null for refused.
 * `canonRoot` is the root already canonicalised AT GRANT TIME — computing it
 * per request would let a root that is itself a moved symlink drift.
 */
export async function resolveJailed(
    provider: FsProvider,
    root: string,
    canonRoot: string,
    requested: string,
): Promise<string | null> {
    const lexical = resolveLexical(root, requested);
    if (lexical === null) return null;
    try {
        const real = await provider.canonicalize(lexical);
        return isWithin(real, canonRoot) ? real : null;
    } catch {
        // A path the OS cannot even resolve is refused, not guessed at.
        return null;
    }
}
