// Register a throwaway account through the built web app and give it two
// notes via Notes, so the APK under test has "current notes" to show.
// Usage: node e2e/notes-seed-user.mjs <baseURL> <username> <password>   (from frontend/)
import { chromium } from '@playwright/test';
const [, , baseURL, username, password] = process.argv;
const b = await chromium.launch();
const ctx = await b.newContext({ baseURL });
const p = await ctx.newPage();
p.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 200)));
await p.goto('/login');
await p.waitForSelector('.toggle-mode', { timeout: 20000 });
await p.click('.toggle-mode');
await p.fill('#username', username);
await p.fill('#password', password);
await p.click('button[type="submit"]');
await p.waitForURL('**/chat', { timeout: 30000 });
try { await p.click('.recovery-done-btn', { timeout: 8000 }); } catch { /* none */ }
console.log('registered', username);
await p.goto('/notes/');
await p.waitForSelector('.notes-app', { timeout: 20000 });
const add = async (title, items) => {
    await p.click('.notes-quickadd-collapsed');
    await p.fill('.notes-quickadd-title', title);
    for (let i = 0; i < items.length; i++) {
        const inp = p.locator('.notes-quickadd-item input').nth(i);
        await inp.fill(items[i]);
        if (i < items.length - 1) await inp.press('Enter');
    }
    await p.getByRole('button', { name: 'Done' }).click();
    await p.waitForSelector(`.notes-card:has-text("${title}")`, { timeout: 15000 });
    console.log('note', title);
};
await add('Groceries', ['Milk', 'Bread', 'Eggs']);
await add('Weekend', ['Call Sam', 'Fix the bike']);
await p.locator('.notes-card', { hasText: 'Groceries' }).hover();
await p.locator('.notes-card', { hasText: 'Groceries' }).locator('.notes-card-pin').click();
await p.waitForSelector('section[aria-label="Pinned notes"]', { timeout: 10000 });
console.log('pinned Groceries');
await b.close();
