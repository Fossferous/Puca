// One Escape closes only the TOP of two stacked NotesDialogs — on a REAL key press.
//
// WHY THIS EXISTS. Each NotesDialog listens for Escape on the document in the
// capture phase, so two stacked dialogs — the shortcuts help over a paste
// question — hear the same key. A real key press ends every listener in a
// microtask checkpoint, and React 19 commits the top dialog's onClose there,
// cleanup and all, before the next listener runs; a check made afresh by the
// one below then found itself on top and closed it too. vitest runs under
// jsdom, whose dispatch runs no microtasks between listeners, so its tests
// saw one dialog close where a person pressing Escape saw both
// (src/tests/notesHiddenDialogKeys.test.tsx emulates the checkpoint with
// flushSync; this is the thing itself). It bundles the REAL NotesDialog
// (esbuild) and presses Escape through the browser's own input, with a
// positive control that this browser does run a checkpoint between two
// listeners — without one the rig could not see the defect, and says so.
//
// SILENT and headless: no media at all.
//
//   cd frontend && node e2e/notes-dialog-escape-real-browser.mjs
//
// No server and no build needed.
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// Top sits EARLIER in the tree than Below but opens LATER (a help opened over
// a composer's question). Hiding the layer and showing it again — Notes left
// and came back, in the desktop app — re-binds both in tree order, Top first:
// the order a fresh check cannot survive.
const entry = `
import { useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NotesDialog } from './components/NotesDialog';
import { LayerOnScreenContext } from './components/portalTarget';
const log = [];
window.__log = log;
function App() {
    const [below, setBelow] = useState(true);
    const [top, setTop] = useState(false);
    const [shown, setShown] = useState(true);
    const closeTop = useCallback(() => { log.push('top'); setTop(false); }, []);
    const closeBelow = useCallback(() => { log.push('below'); setBelow(false); }, []);
    window.__openTop = () => setTop(true);
    window.__shown = setShown;
    return (
        <LayerOnScreenContext.Provider value={shown}>
            {top && <NotesDialog title="Top" onClose={closeTop}><span>top</span></NotesDialog>}
            {below && <NotesDialog title="Below" onClose={closeBelow}><span>below</span></NotesDialog>}
            <div id="state">{'below=' + below + ' top=' + top}</div>
        </LayerOnScreenContext.Provider>
    );
}
createRoot(document.getElementById('root')).render(<App />);
`;
const bundle = await build({
    stdin: { contents: entry, resolveDir: join(here, '..', 'src'), loader: 'tsx', sourcefile: 'entry.tsx' },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"development"' },
    logLevel: 'warning',
});
const appSrc = bundle.outputFiles[0].text;

let pass = 0, fail = 0;
const ck = (cond, label, extra = '') => {
    if (cond) { pass++; console.log('PASS', label, extra); }
    else { fail++; console.log('FAIL', label, extra); }
};

const CHANNEL = process.env.CHANNEL || 'bundled';
const browser = await chromium.launch({
    headless: true,
    ...(CHANNEL === 'bundled' ? {} : { channel: CHANNEL }),
    args: ['--mute-audio'],
});
const settle = (page) => page.evaluate(() => new Promise((r) => setTimeout(r, 50)));

// Positive control: a microtask queued by one listener runs before the next
// listener of the same trusted key press — the checkpoint the defect needs.
{
    const page = await browser.newPage();
    await page.setContent('<!doctype html><body>rig</body>');
    await page.evaluate(() => {
        window.__seen = [];
        let flag = false;
        document.addEventListener('keydown', () => { flag = false; queueMicrotask(() => { flag = true; }); }, true);
        document.addEventListener('keydown', () => { window.__seen.push(flag); }, true);
    });
    await page.keyboard.press('Escape');
    const trusted = await page.evaluate(() => window.__seen[0]);
    await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    const synthetic = await page.evaluate(() => window.__seen[1]);
    ck(trusted === true, 'positive control: a real key press runs a microtask checkpoint between two listeners', String(trusted));
    ck(synthetic === false, 'negative control: a dispatched one does not (what jsdom does)', String(synthetic));
    await page.close();
}

for (const reBound of [false, true]) {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><body><div id="root"></div></body>');
    await page.addScriptTag({ content: appSrc });
    await page.waitForSelector('#state');
    await page.evaluate(() => window.__openTop());
    await settle(page);
    if (reBound) {
        await page.evaluate(() => window.__shown(false));
        await settle(page);
        await page.evaluate(() => window.__shown(true));
        await settle(page);
    }
    const how = reBound ? 'hidden and shown again (both re-bound, Top first)' : 'as opened';
    ck(await page.textContent('#state') === 'below=true top=true', `${how}: both open`);
    await page.keyboard.press('Escape');
    await settle(page);
    const one = await page.textContent('#state');
    ck(one === 'below=true top=false', `${how}: one Escape closes only the top one`, `${one} ${JSON.stringify(await page.evaluate(() => window.__log))}`);
    await page.keyboard.press('Escape');
    await settle(page);
    const two = await page.textContent('#state');
    ck(two === 'below=false top=false', `${how}: the next closes the one below`, two);
    await page.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
