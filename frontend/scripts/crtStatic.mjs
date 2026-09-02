/**
 * The static-C-runtime decision for the Windows binaries, in one place.
 *
 * WHY THE FLAG EXISTS. app.exe, puca-service.exe and puca-agent.exe imported
 * VCRUNTIME140.dll, which is NOT part of Windows: it ships with the VC++
 * Redistributable, and a clean install (Windows Sandbox proved it) fails with
 * 0xC0000135 STATUS_DLL_NOT_FOUND before main. `+crt-static` links it in.
 *
 * WHY WINDOWS ONLY. On Linux the same flag asks for a static glibc, and rustc
 * then drops proc-macro crates ("dropping unsupported crate type 'proc-macro'"),
 * so serde's derive cannot build and the whole agent build fails — which is
 * exactly the build the Linux-enablement work exists to keep green. macOS
 * tolerates the flag but does not need it. The problem being solved is a
 * Windows-only problem, so the flag is a Windows-only flag.
 *
 * WHY THE ENVIRONMENT AND NOT .cargo/config.toml. An environment RUSTFLAGS
 * silently overrides every config-file rustflags, and the release machine
 * has one (`-L <vcpkg lib dir>`), so a config-file setting looked applied and
 * reached nothing. Append, never replace, so an existing -L survives.
 */
export const CRT_STATIC = '-C target-feature=+crt-static';

/** The RUSTFLAGS value to use for `platform` (a `process.platform` string),
 *  given the current environment. Returns the environment's own value — which
 *  may be undefined — on every platform but win32. */
export function rustflagsFor(platform, env = {}) {
    const flags = env.RUSTFLAGS;
    if (platform !== 'win32') return flags;
    if (flags && flags.includes('crt-static')) return flags;
    return [flags, CRT_STATIC].filter(Boolean).join(' ');
}

/** A copy of `env` with RUSTFLAGS set per `rustflagsFor` — and left ABSENT,
 *  not the string "undefined", when there is nothing to set. */
export function envWithCrtStatic(platform, env) {
    const flags = rustflagsFor(platform, env);
    const out = { ...env };
    if (flags === undefined) delete out.RUSTFLAGS;
    else out.RUSTFLAGS = flags;
    return out;
}
