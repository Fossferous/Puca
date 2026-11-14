#!/usr/bin/env node
/**
 * Every browser a script in e2e/ starts makes no sound. Part of `npm run lint`.
 *
 * WHY. These scripts run on the owner's own desktop, often with earbuds in. A test
 * browser that plays a stream, a chime or a call's audio plays it through whatever is
 * on the machine's output at full volume, and a headless browser plays sound like any
 * other. 36 scripts launched one with nothing muting it before this check existed; none
 * had happened to play anything yet, which is luck, not a rule.
 *
 * WHAT IS REQUIRED, per launch:
 *   chromium.launch / launchPersistentContext / launchServer   '--mute-audio' in its args
 *   firefox.launch / ...                                       firefoxUserPrefs 'media.volume_scale' at 0
 *   webkit.launch                                              wrapped: muteWebkit(await webkit.launch(...)),
 *                                                              muteWebkit imported from e2e/muted.mjs
 *                                                              (WebKit has no mute flag; that wraps every
 *                                                              context in an init script that mutes media
 *                                                              elements and Web Audio at the source)
 *   a `launchOptions` object (playwright.config.ts, test.use)  '--mute-audio' in its args
 *   chromium.connectOverCDP / connect (a browser the script    listed in ATTACHED below, with where its sound
 *     did not start: an emulator's WebView, the desktop app)   is turned off; a new one fails until reviewed
 *   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS set by a script      '--mute-audio' in it (the desktop app's WebView2)
 *
 * And two sounds a browser's mute does not reach, because the OS makes them:
 *   - a file that turns the app's spoken join/leave on (voiceTTS: true) must replace
 *     window.speechSynthesis: on Windows speech goes through the OS speech engine, outside
 *     the browser's audio output, so --mute-audio is not relied on for it;
 *   - a file that grants 'notifications' must launch Chromium with NativeNotifications
 *     disabled: a native toast plays Windows' notification sound.
 *
 * Parsed, not grepped: the flag has to be in THIS launch's options, followed through
 * the variables, spreads, .concat()s, ternaries (both sides) and option-building
 * functions the scripts use. A launch whose options it cannot follow fails and says so;
 * write the flag where the launch can be seen to have it.
 *
 *   node scripts/check-e2e-muted.mjs          # e2e/ and playwright.config.ts, as the lint chain runs it
 *   node scripts/check-e2e-muted.mjs <dir>    # every script file there, for the test's fixtures
 *
 * src/tests/e2eMuted.test.ts shows it failing on each shape, and passing the right ones.
 */
import ts from 'typescript';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(HERE, '..');

/**
 * Scripts that ATTACH to a browser they did not start, so there is no launch for the
 * flag to be on. Keyed by path from frontend/, with how many attach calls the file has:
 * a new one fails until someone has read where its sound goes and said so here.
 */
const EMULATOR = "the debug APK's WebView on a HEADLESS emulator, whose sound is the emulator's: the header has it started -no-window -no-audio, and the script refuses any serial but emulator-NNNN";
const ATTACHED = {
    'e2e/android-camera-flip-live.mjs': { count: 1, why: EMULATOR },
    'e2e/android-control-live.mjs': { count: 1, why: EMULATOR },
    'e2e/android-phone-sweep-live.mjs': { count: 2, why: EMULATOR },
    'e2e/android-shade-keys-live.mjs': { count: 1, why: EMULATOR },
    'e2e/android-share-live.mjs': { count: 1, why: EMULATOR },
    'e2e/csp-smoke-desktop.mjs': { count: 1, why: 'the desktop app this script starts, with --mute-audio in WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS (checked here too)' },
};

const LAUNCH = new Set(['launch', 'launchPersistentContext', 'launchServer']);
const ATTACH = new Set(['connect', 'connectOverCDP']);
const ENGINES = new Set(['chromium', 'firefox', 'webkit']);
const MUTE = '--mute-audio';

function problemsIn(fileName, text, relName) {
    const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true,
        /\.(c|m)?tsx?$/.test(fileName) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    const problems = [];
    const report = (node, what) => {
        const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
        problems.push({ line: line + 1, column: character + 1, what });
    };

    const unwrap = (e) => {
        while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)
            || ts.isSatisfiesExpression?.(e) || ts.isTypeAssertionExpression(e))) e = e.expression;
        return e;
    };

    /** What a name refers to where it is used: the nearest enclosing scope that declares it. */
    const declarationOf = (id) => {
        const name = id.text;
        const inStatements = (statements) => {
            for (const st of statements) {
                if (ts.isVariableStatement(st)) {
                    for (const d of st.declarationList.declarations) {
                        if (ts.isIdentifier(d.name) && d.name.text === name) {
                            // `let x` assigned later, or a `let` that is ever reassigned, cannot be followed.
                            const isConst = (st.declarationList.flags & ts.NodeFlags.Const) !== 0;
                            return { init: d.initializer, followable: isConst && !!d.initializer };
                        }
                        if (!ts.isIdentifier(d.name) && bindsName(d.name, name)) return { followable: false };
                    }
                }
                if (ts.isFunctionDeclaration(st) && st.name?.text === name) return { fn: st, followable: true };
            }
            return null;
        };
        for (let node = id.parent; node; node = node.parent) {
            if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
                const found = inStatements(node.statements);
                if (found) return found;
            }
            if (ts.isFunctionLike(node) && node.parameters) {
                for (const p of node.parameters) if (bindsName(p.name, name)) return { followable: false };
            }
            if ((ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node))
                && node.initializer && ts.isVariableDeclarationList(node.initializer)) {
                for (const d of node.initializer.declarations) if (bindsName(d.name, name)) return { followable: false };
            }
            if (ts.isCatchClause(node) && node.variableDeclaration && bindsName(node.variableDeclaration.name, name)) return { followable: false };
        }
        // An import: whatever it is, it is not in this file to read.
        return { followable: false };
    };
    const bindsName = (binding, name) => {
        if (ts.isIdentifier(binding)) return binding.text === name;
        if (ts.isObjectBindingPattern(binding) || ts.isArrayBindingPattern(binding)) {
            return binding.elements.some((el) => !ts.isOmittedExpression(el) && bindsName(el.name, name));
        }
        return false;
    };

    /** Every expression a function call can give back (arrow bodies and return statements). */
    const returnsOf = (fn) => {
        if (!fn.body) return [];
        if (!ts.isBlock(fn.body)) return [fn.body];
        const out = [];
        const walk = (n) => {
            if (ts.isFunctionLike(n) && n !== fn) return;
            if (ts.isReturnStatement(n)) { out.push(n.expression); return; }
            ts.forEachChild(n, walk);
        };
        ts.forEachChild(fn.body, walk);
        return out;
    };
    const functionOf = (callee) => {
        callee = unwrap(callee);
        if (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) return callee;
        if (!ts.isIdentifier(callee)) return null;
        const d = declarationOf(callee);
        if (d.fn) return d.fn;
        const init = d.followable ? unwrap(d.init) : null;
        return init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : null;
    };

    /**
     * Does this expression DEFINITELY satisfy `test`? `test` sees only object/array/literal
     * nodes; names, calls and ternaries are followed here, and anything that cannot be
     * followed is a no. Every path must satisfy it (both sides of a ternary, every return).
     */
    const definitely = (expr, test, seen = new Set()) => {
        expr = unwrap(expr);
        if (!expr || seen.has(expr) || seen.size > 60) return false;
        seen = new Set(seen).add(expr);
        if (ts.isIdentifier(expr)) {
            const d = declarationOf(expr);
            return d.followable && !d.fn && definitely(d.init, test, seen);
        }
        if (ts.isConditionalExpression(expr)) return definitely(expr.whenTrue, test, seen) && definitely(expr.whenFalse, test, seen);
        if (ts.isBinaryExpression(expr) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(expr.operatorToken.kind)) {
            return definitely(expr.left, test, seen) && definitely(expr.right, test, seen);
        }
        if (ts.isAwaitExpression(expr)) return definitely(expr.expression, test, seen);
        if (ts.isCallExpression(expr)) {
            const fn = functionOf(expr.expression);
            if (fn) {
                const rets = returnsOf(fn);
                return rets.length > 0 && rets.every((r) => definitely(r, test, seen));
            }
        }
        return test(expr, seen);
    };

    const stringOf = (e) => {
        e = unwrap(e);
        return e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : null;
    };

    /** An array expression that certainly holds an element `ok` says yes to. */
    const arrayHolds = (ok) => {
        const test = (e, seen) => {
            if (ts.isArrayLiteralExpression(e)) {
                return e.elements.some((el) => ts.isSpreadElement(el)
                    ? definitely(el.expression, test, seen)
                    : (stringOf(el) !== null && ok(stringOf(el))));
            }
            if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
                const method = e.expression.name.text;
                if (method === 'concat') {
                    return definitely(e.expression.expression, test, seen) || e.arguments.some((a) => definitely(a, test, seen));
                }
                // filter(Boolean) keeps every non-empty string, the flag among them.
                if (method === 'filter' && e.arguments.length === 1 && ts.isIdentifier(e.arguments[0]) && e.arguments[0].text === 'Boolean') {
                    return definitely(e.expression.expression, test, seen);
                }
            }
            return false;
        };
        return test;
    };

    const keyOf = (p) => {
        if (!p.name) return null;
        if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name)) return p.name.text;
        if (ts.isComputedPropertyName(p.name)) return stringOf(p.name.expression);
        return null;
    };
    /**
     * Every shape an object expression can have at run time: a Map from each key to the
     * expression that last wrote it, one Map per path through its ternaries, spreads and
     * option-building functions; null for a path that cannot be read. A spread that cannot
     * be read is taken to add nothing (a parameter's `...extra` beside a literal `args`).
     */
    const shapes = (expr, seen = new Set()) => {
        expr = unwrap(expr);
        if (!expr || seen.has(expr) || seen.size > 60) return [null];
        seen = new Set(seen).add(expr);
        if (ts.isIdentifier(expr)) {
            const d = declarationOf(expr);
            return d.followable && !d.fn ? shapes(d.init, seen) : [null];
        }
        if (ts.isConditionalExpression(expr)) return [...shapes(expr.whenTrue, seen), ...shapes(expr.whenFalse, seen)];
        if (ts.isBinaryExpression(expr) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(expr.operatorToken.kind)) {
            return [...shapes(expr.left, seen), ...shapes(expr.right, seen)];
        }
        if (ts.isAwaitExpression(expr)) return shapes(expr.expression, seen);
        if (ts.isCallExpression(expr)) {
            const fn = functionOf(expr.expression);
            const rets = fn ? returnsOf(fn) : [];
            return rets.length ? rets.flatMap((r) => shapes(r, seen)) : [null];
        }
        if (!ts.isObjectLiteralExpression(expr)) return [null];
        let maps = [new Map()];
        for (const p of expr.properties) {
            if (ts.isSpreadAssignment(p)) {
                const subs = shapes(p.expression, seen);
                maps = maps.flatMap((m) => subs.map((s) => (s ? new Map([...m, ...s]) : m)));
            } else {
                const key = keyOf(p);
                const value = ts.isPropertyAssignment(p) ? p.initializer : ts.isShorthandPropertyAssignment(p) ? p.name : null;
                maps = maps.map((m) => new Map(m).set(key, value));
            }
            if (maps.length > 64) return [null];
        }
        return maps;
    };
    /** An object expression whose `key`, on every path, certainly satisfies `valueOk`. */
    const objectHas = (key, valueOk) => (e, seen = new Set()) => shapes(e, new Set([...seen].filter((n) => n !== unwrap(e)))).every((m) => m && m.get(key) && definitely(m.get(key), valueOk, seen));

    const isZero = (e) => {
        const s = stringOf(e);
        if (s !== null) return /^\s*[+-]?0*(\.0*)?\s*$/.test(s) && /0/.test(s);
        if (ts.isNumericLiteral(e)) return Number(e.text) === 0;
        return false;
    };

    const chromiumMuted = objectHas('args', arrayHolds((s) => s === MUTE));
    const firefoxMuted = objectHas('firefoxUserPrefs', objectHas('media.volume_scale', isZero));
    const noNativeToasts = objectHas('args', arrayHolds((s) => /^--disable-features=/.test(s) && s.slice(19).split(',').includes('NativeNotifications')));

    const grantsNotifications = /\bgrantPermissions\s*\([^)]*['"]notifications['"]|permissions\s*:\s*\[[^\]]*['"]notifications['"]/.test(text);

    const engineOf = (obj) => {
        obj = unwrap(obj);
        if (ts.isIdentifier(obj)) return obj.text;
        if (ts.isPropertyAccessExpression(obj)) return obj.name.text;
        return null;
    };
    const importsMuteWebkit = source.statements.some((st) => ts.isImportDeclaration(st)
        && ts.isStringLiteral(st.moduleSpecifier) && /(^|\/)muted\.mjs$/.test(st.moduleSpecifier.text)
        && st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings)
        && st.importClause.namedBindings.elements.some((el) => el.name.text === 'muteWebkit' && !el.propertyName));
    const wrappedByMuteWebkit = (call) => {
        let n = call;
        while (ts.isAwaitExpression(n.parent) || ts.isParenthesizedExpression(n.parent)) n = n.parent;
        const p = n.parent;
        return ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === 'muteWebkit' && p.arguments[0] === n;
    };

    let attaches = [];
    const visit = (node) => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
            const method = node.expression.name.text;
            const engine = engineOf(node.expression.expression);
            if (LAUNCH.has(method)) {
                const opts = method === 'launchPersistentContext' ? node.arguments[1] : node.arguments[0];
                const where = `${engine ?? '?'}.${method}()`;
                if (!ENGINES.has(engine)) {
                    report(node, `${where}: cannot tell which browser this starts, so not how it is muted: call chromium/firefox/webkit.${method} by name`);
                } else if (engine === 'chromium') {
                    if (!opts || !definitely(opts, chromiumMuted)) report(node, `${where} is not muted: put '${MUTE}' in its args (where this check can follow it)`);
                    else if (grantsNotifications && !definitely(opts, noNativeToasts)) {
                        report(node, `${where} in a file that grants notifications: add '--disable-features=NativeNotifications' to its args, or a Windows toast plays its sound`);
                    }
                } else if (engine === 'firefox') {
                    if (!opts || !definitely(opts, firefoxMuted)) report(node, `${where} is not muted: give it firefoxUserPrefs { 'media.volume_scale': '0.0' }`);
                } else if (method !== 'launch' || !wrappedByMuteWebkit(node) || !importsMuteWebkit) {
                    report(node, `${where} is not muted (WebKit has no flag for it): muteWebkit(await webkit.launch(...)), with muteWebkit imported from e2e/muted.mjs`);
                }
            } else if (ATTACH.has(method) && ENGINES.has(engine)) {
                attaches.push(node);
            }
        }
        if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
            const key = keyOf(node);
            const value = ts.isPropertyAssignment(node) ? node.initializer : node.name;
            if (key === 'launchOptions' && !definitely(value, chromiumMuted)) {
                report(node, `launchOptions is not muted: put '${MUTE}' in its args`);
            }
            if (key === 'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS') {
                const v = unwrap(value);
                const words = v && ts.isTemplateExpression(v)
                    ? [v.head.text, ...v.templateSpans.map((s) => s.literal.text)].join(' ')
                    : stringOf(v) ?? '';
                if (!words.split(/\s+/).includes(MUTE)) report(node, `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS starts the desktop app's WebView2 unmuted: add '${MUTE}' to it`);
            }
            if (key === 'voiceTTS') {
                const v = unwrap(value);
                const on = v && v.kind === ts.SyntaxKind.TrueKeyword;
                if (on && !/defineProperty\(\s*window\s*,\s*['"]speechSynthesis['"]/.test(text)) {
                    report(node, 'voiceTTS turned on with the real speechSynthesis: replace window.speechSynthesis first (Object.defineProperty(window, \'speechSynthesis\', ...)); --mute-audio is not relied on to reach the OS speech engine');
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);

    if (attaches.length) {
        const reviewed = ATTACHED[relName];
        if (!reviewed || reviewed.count !== attaches.length) {
            for (const a of attaches) {
                report(a, `attaches to a browser it did not start (${attaches.length} in this file${reviewed ? `, ${reviewed.count} reviewed` : ''}): say where its sound is turned off in ATTACHED in scripts/check-e2e-muted.mjs`);
            }
        }
    }
    return problems;
}

function scriptsUnder(dir) {
    const found = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) found.push(...scriptsUnder(path));
        } else if (/\.(m|c)?(j|t)s$/.test(entry.name) && !entry.name.endsWith('.d.ts') && !entry.name.endsWith('.d.mts')) {
            found.push(path);
        }
    }
    return found;
}

const fixtureDir = process.argv[2] ? resolve(process.argv[2]) : null;
const root = fixtureDir ?? FRONTEND;
const files = fixtureDir
    ? scriptsUnder(fixtureDir)
    : [...scriptsUnder(join(FRONTEND, 'e2e')), join(FRONTEND, 'playwright.config.ts')].filter((f) => existsSync(f));
let failed = 0;
for (const file of files) {
    const rel = relative(root, file).replaceAll('\\', '/');
    for (const p of problemsIn(file, readFileSync(file, 'utf8'), rel)) {
        failed++;
        console.error(`${rel}:${p.line}:${p.column}  ${p.what}`);
    }
}
if (!fixtureDir) {
    for (const rel of Object.keys(ATTACHED)) {
        if (!existsSync(join(FRONTEND, rel))) { failed++; console.error(`${rel}  is in ATTACHED in scripts/check-e2e-muted.mjs but does not exist: take it out`); }
    }
}
if (failed > 0) {
    console.error(`\ncheck-e2e-muted: ${failed} problem(s) in ${files.length} files`);
    process.exit(1);
}
console.log(`check-e2e-muted: ${files.length} files, every browser started muted`);
