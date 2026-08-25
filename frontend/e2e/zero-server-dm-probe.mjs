// Zero-server DM regression probe: a fresh account with NO servers opens a
// DM — the Friends dashboard must NOT force-reopen over the conversation (the
// no-servers effect refires on showFriendsPanel / currentDM changes and used
// to resurrect itself).
//
// Needs a PARTNER account to DM (self-DMs were retired with "Notes to self").
// Usage: node e2e/zero-server-dm-probe.mjs <partnerUserId>
import { chromium } from '@playwright/test';

const partnerId = Number(process.argv[2]);
if (!Number.isFinite(partnerId)) {
    console.error('FAIL  usage: node e2e/zero-server-dm-probe.mjs <partnerUserId>');
    process.exit(1);
}
const username = 'zs_' + Math.random().toString(36).slice(2, 8);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false });
const page = await ctx.newPage();

let failures = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++; };

await page.goto('http://localhost:5173/');
await page.waitForURL('**/login');
await page.click('.toggle-mode');
await page.fill('#username', username);
await page.fill('#password', 'Password123!');
await page.click('button[type="submit"]');
await page.waitForURL('**/chat', { timeout: 30000 });
await page.waitForTimeout(1200);
try { await page.check('.recovery-confirm input[type="checkbox"]', { timeout: 5000 }); await page.click('.recovery-done-btn'); } catch { /* none */ }
await page.waitForTimeout(500);
try { await page.click('.welcome-popup-close', { timeout: 3000 }); } catch { /* none */ }
await page.waitForTimeout(500);

// No servers -> dashboard should be open.
check('zero-server account starts on Friends home', await page.locator('.friends-dashboard').count() > 0);

// Create the DM via API, then reload so the list picks it up and open it
// from the dashboard.
await page.evaluate(async (uid) => {
    const token = localStorage.getItem('auth_token');
    await fetch('http://127.0.0.1:3000/dms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ user_id: uid }),
    });
}, partnerId);
await page.reload();
await page.waitForTimeout(2000);
try { await page.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* none */ }
const dmRow = page.locator('.friends-dashboard .dm-item').first();
const dmName = (await dmRow.locator('.dm-username').textContent().catch(() => ''))?.trim() ?? '';
await dmRow.click({ timeout: 5000 });
await page.waitForTimeout(1500);

// The conversation must be open and STAY open — no dashboard resurrection.
check('DM view open after starting the DM',
    (await page.locator('.chat-header h2').textContent().catch(() => '')) === dmName);
check('dashboard did not force-reopen (immediate)', await page.locator('.friends-dashboard').count() === 0);
await page.waitForTimeout(2000); // give the effect every chance to misfire
check('dashboard did not force-reopen (after 2s)', await page.locator('.friends-dashboard').count() === 0);
check('home sidebar present in DM view', await page.locator('.sidebar .friends-sidebar').count() > 0);
check('composer present (currentCollection cleared)', await page.locator('.message-textarea').count() > 0);

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
