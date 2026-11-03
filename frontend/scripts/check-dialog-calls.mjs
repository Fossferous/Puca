#!/usr/bin/env node
/**
 * Every question the app asks is awaited, and nothing but api/appDialogs.ts calls the
 * page's blocking dialogs. Part of `npm run lint`.
 *
 * WHY THE AWAIT. `if (!askConfirm(x)) return` compiles, and a Promise is truthy, so it
 * goes ahead as a yes with nobody asked. That exact shape, reached through a plugin's
 * replacement of window.confirm, left the desktop app with no question before Disband
 * Server, Kick or Delete forever for two months (src/tests/desktopScriptDialogs.test.ts).
 * tsc -b does not catch the `!` form and no test of a component's happy path can.
 *
 * WHY THE NATIVE CALLS. On the desktop a native dialog stops the page's JavaScript until
 * it is answered: the release that closes a push-to-talk microphone is page JavaScript,
 * and so is relayed remote control, which is how someone would answer it from afar. The
 * header of api/appDialogs.ts has the rest.
 *
 * Parsed, not grepped: a comment may say alert(), a string may hold `javascript:alert(1)`,
 * and an install prompt's own .prompt() is nobody's dialog.
 *
 *   node scripts/check-dialog-calls.mjs          # src/, as the lint chain runs it
 *   node scripts/check-dialog-calls.mjs <dir>    # every file there, for the test's fixtures
 *
 * src/tests/desktopScriptDialogs.test.ts shows this failing on each shape, and on every
 * real site with its await taken off.
 */
import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');

/** Answer with a Promise, so each is only an answer once awaited. */
const QUESTIONS = new Set(['askConfirm', 'askText', 'tellUserAndWait']);
const NATIVE = new Set(['alert', 'confirm', 'prompt']);
/** What the native ones are reached through. */
const GLOBALS = new Set(['window', 'globalThis', 'self', 'top', 'parent']);

function problemsIn(fileName, text) {
    const source = ts.createSourceFile(
        fileName, text, ts.ScriptTarget.Latest, true,
        fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const problems = [];
    const report = (node, what) => {
        const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
        problems.push({ line: line + 1, column: character + 1, what });
    };
    const isGlobal = node => ts.isIdentifier(node) && GLOBALS.has(node.text);
    const visit = node => {
        if (ts.isIdentifier(node) && QUESTIONS.has(node.text) && !ts.isImportSpecifier(node.parent)) {
            const parent = node.parent;
            if (ts.isCallExpression(parent) && parent.expression === node) {
                let call = parent;
                while (ts.isParenthesizedExpression(call.parent)) call = call.parent;
                if (!ts.isAwaitExpression(call.parent)) {
                    report(node, `${node.text}() is not awaited: its answer is a Promise, which is truthy, so this goes ahead unasked`);
                }
            } else {
                report(node, `${node.text} is passed around: call it where its answer is awaited`);
            }
        }
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && NATIVE.has(node.expression.text)) {
            report(node, `${node.expression.text}() stops the page's JavaScript on the desktop: use api/appDialogs.ts`);
        }
        if (ts.isPropertyAccessExpression(node) && isGlobal(node.expression) && NATIVE.has(node.name.text)) {
            report(node, `${node.expression.text}.${node.name.text} stops the page's JavaScript on the desktop: use api/appDialogs.ts`);
        }
        if (ts.isElementAccessExpression(node) && isGlobal(node.expression)
            && ts.isStringLiteralLike(node.argumentExpression) && NATIVE.has(node.argumentExpression.text)) {
            report(node, `${node.expression.text}['${node.argumentExpression.text}'] stops the page's JavaScript on the desktop: use api/appDialogs.ts`);
        }
        if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && isGlobal(node.initializer)) {
            for (const element of node.name.elements) {
                const name = (element.propertyName ?? element.name).getText(source);
                if (NATIVE.has(name)) report(element, `${name}, taken from ${node.initializer.text}, stops the page's JavaScript on the desktop: use api/appDialogs.ts`);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return problems;
}

function sourcesUnder(dir, keep) {
    const found = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) found.push(...sourcesUnder(path, keep));
        else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') && keep(path)) found.push(path);
    }
    return found;
}

/** The tests stand in for these functions, and the one module that may call them must. */
const isAppCode = path => {
    const rel = relative(SRC, path).replaceAll('\\', '/');
    return !rel.startsWith('tests/') && !/\.(test|spec)\.tsx?$/.test(rel) && rel !== 'api/appDialogs.ts';
};

const fixtureDir = process.argv[2] ? resolve(process.argv[2]) : null;
const files = fixtureDir ? sourcesUnder(fixtureDir, () => true) : sourcesUnder(SRC, isAppCode);
let failed = 0;
for (const file of files) {
    for (const p of problemsIn(file, readFileSync(file, 'utf8'))) {
        failed++;
        console.error(`${relative(fixtureDir ?? join(HERE, '..'), file).replaceAll('\\', '/')}:${p.line}:${p.column}  ${p.what}`);
    }
}
if (failed > 0) {
    console.error(`\ncheck-dialog-calls: ${failed} problem(s) in ${files.length} files`);
    process.exit(1);
}
console.log(`check-dialog-calls: ${files.length} files, every question awaited, no native dialog`);
