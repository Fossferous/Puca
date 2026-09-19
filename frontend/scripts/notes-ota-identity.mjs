/**
 * Config invariants for two packaging facts that no type checker or test sees:
 *
 *  1. Púca Notes' Android app updates over the air with its OWN key.
 *     notes-app/capacitor.config.ts must carry a CapacitorUpdater block whose
 *     publicKey DIFFERS from Púca's (that difference is what makes a Púca
 *     bundle unusable inside Notes, and the reverse), with autoUpdate off
 *     (else the plugin polls Capgo's cloud), telemetry off (statsUrl ''), the
 *     URL/app-id override knobs off, and NO allowNavigation — the "install the
 *     new app" prompt relies on a foreign-host navigation leaving the WebView
 *     for the system browser, which an allowNavigation entry would stop.
 *     The plugin's native half (notes-app/package.json) must be pinned to
 *     EXACTLY the version whose JS half frontend/ bundles.
 *
 *  2. The desktop installer embeds dist-desktop/ (dist/ minus Púca Notes),
 *     staged by scripts/stage-desktop-dist.mjs from the full build's
 *     beforeBuildCommand and from build-lite.mjs. Lite must not override
 *     frontendDist (it would point back at dist/, notes and all).
 *
 * Pure functions over file TEXT, so src/tests/notesOtaIdentity.test.ts can
 * feed them broken configs; check-lite-identity.mjs and build-notes-app.mjs
 * run them against the real files.
 */

/** Full-line `//` comments removed: a gate a comment can satisfy is not one. */
function stripLineComments(text) {
    return text.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');
}

/** The body of `CapacitorUpdater: { ... }`, or null. Brace-counted; the
 *  block's strings hold no braces. */
export function updaterBlock(cfgText) {
    const src = stripLineComments(cfgText);
    const start = src.search(/CapacitorUpdater\s*:\s*\{/);
    if (start === -1) return null;
    let i = src.indexOf('{', start);
    let depth = 0;
    for (let j = i; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') {
            depth--;
            if (depth === 0) return src.slice(i + 1, j);
        }
    }
    return null;
}

/** The publicKey value: the concatenation of its quoted pieces, `\n` unescaped. */
export function updaterPublicKey(cfgText) {
    const block = updaterBlock(cfgText);
    if (!block) return null;
    const m = /publicKey\s*:\s*((?:'[^']*'\s*\+?\s*)+)/.exec(block);
    if (!m) return null;
    return [...m[1].matchAll(/'([^']*)'/g)].map(x => x[1]).join('').replace(/\\n/g, '\n').trim();
}

/**
 * @param {object} a
 * @param {string} a.notesCfg        notes-app/capacitor.config.ts text
 * @param {string} a.pucaCfg         capacitor.config.ts text
 * @param {object} a.notesPkg        notes-app/package.json, parsed
 * @param {string|null} a.frontendUpdaterVersion  the version frontend/ resolves
 *        (frontend/package-lock.json's node_modules/@capgo/capacitor-updater)
 */
export function checkNotesOta({ notesCfg, pucaCfg, notesPkg, frontendUpdaterVersion }) {
    const ok = [];
    const failures = [];
    const block = updaterBlock(notesCfg);
    if (!block) {
        failures.push('notes-app/capacitor.config.ts has no CapacitorUpdater block — the Notes app would have no signed OTA');
    } else {
        const notesKey = updaterPublicKey(notesCfg);
        const pucaKey = updaterPublicKey(pucaCfg);
        if (!notesKey || !/^-----BEGIN RSA PUBLIC KEY-----\n[\s\S]+\n-----END RSA PUBLIC KEY-----$/.test(notesKey)) {
            failures.push('notes-app CapacitorUpdater.publicKey is missing or not a PKCS#1 RSA public key — every Notes bundle would be refused, or none verified');
        } else if (!pucaKey) {
            failures.push('capacitor.config.ts (Púca) has no readable CapacitorUpdater.publicKey to compare against');
        } else if (notesKey.replace(/\s/g, '') === pucaKey.replace(/\s/g, '')) {
            failures.push('notes-app CapacitorUpdater.publicKey EQUALS Púca\'s — a Púca bundle would then verify inside the Notes app. Notes needs its own key (deploy/mobile/README.md)');
        } else {
            ok.push('Notes OTA: its own signing key (differs from Púca\'s)');
        }
        if (!/\bautoUpdate\s*:\s*false\b/.test(block)) failures.push('notes-app CapacitorUpdater.autoUpdate must be false — true polls Capgo\'s cloud');
        if (!/\bstatsUrl\s*:\s*''/.test(block)) failures.push('notes-app CapacitorUpdater.statsUrl must be \'\' — anything else reports installs to a third party');
        if (!/\bappReadyTimeout\s*:\s*\d+/.test(block)) failures.push('notes-app CapacitorUpdater.appReadyTimeout is not set — the rollback of a bundle that never boots depends on it');
        for (const knob of ['allowModifyUrl', 'allowModifyAppId', 'allowPreview']) {
            if (new RegExp(`\\b${knob}\\s*:\\s*true\\b`).test(block)) failures.push(`notes-app CapacitorUpdater.${knob} must stay false`);
        }
        if (failures.length === 0) ok.push('Notes OTA: autoUpdate off, telemetry off, override knobs off');
    }
    if (/\ballowNavigation\b/.test(stripLineComments(notesCfg))) {
        failures.push('notes-app/capacitor.config.ts sets allowNavigation — the "install the new app" prompt would open the download page INSIDE the app instead of the system browser');
    } else {
        ok.push('Notes app: no allowNavigation (foreign hosts open in the system browser)');
    }
    const pin = notesPkg?.dependencies?.['@capgo/capacitor-updater'];
    if (!pin) {
        failures.push('notes-app/package.json does not depend on @capgo/capacitor-updater — the APK would carry no updater');
    } else if (!frontendUpdaterVersion) {
        failures.push('cannot read the @capgo/capacitor-updater version frontend/ resolves (frontend/package-lock.json)');
    } else if (pin !== frontendUpdaterVersion) {
        failures.push(`notes-app pins @capgo/capacitor-updater "${pin}" but frontend/ bundles ${frontendUpdaterVersion} — the plugin's JS and native halves would differ. Pin it EXACTLY`);
    } else {
        ok.push(`Notes app: @capgo/capacitor-updater pinned to ${pin}, the version frontend/ bundles`);
    }
    return { ok, failures };
}

/**
 * @param {object} base  tauri.conf.json, comment keys stripped
 * @param {object} lite  tauri.lite.conf.json, comment keys stripped
 * @param {object|null} win  tauri.windows.conf.json or null
 */
export function checkDesktopDist(base, lite, win) {
    const ok = [];
    const failures = [];
    if (base?.build?.frontendDist !== '../dist-desktop') {
        failures.push(`tauri.conf.json build.frontendDist is ${JSON.stringify(base?.build?.frontendDist)}, not "../dist-desktop" — the installer would embed Púca Notes (dist/notes/), which the shell never loads`);
    }
    if (!String(base?.build?.beforeBuildCommand ?? '').includes('stage-desktop-dist.mjs')) {
        failures.push('tauri.conf.json build.beforeBuildCommand does not run scripts/stage-desktop-dist.mjs — dist-desktop/ would be missing or STALE');
    }
    for (const [label, cfg] of [['tauri.lite.conf.json', lite], ['tauri.windows.conf.json', win]]) {
        if (cfg?.build && 'frontendDist' in cfg.build) {
            failures.push(`${label} overrides build.frontendDist — it must inherit "../dist-desktop"`);
        }
    }
    if (failures.length === 0) ok.push('desktop installers embed ../dist-desktop (no Púca Notes), staged by beforeBuildCommand / build-lite.mjs');
    return { ok, failures };
}
