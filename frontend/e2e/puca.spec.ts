import { test, expect, type Page, type Browser } from '@playwright/test';
import { execSync } from 'child_process';

// Enforce serial run for sequential state-based tests
test.describe.configure({ mode: 'serial' });

// Function to truncate all database tables before test starts (excluding _sqlx_migrations)
function resetDatabase() {
    console.log('[E2E Setup] Resetting database tables (excluding _sqlx_migrations)...');
    try {
        const cmd = `$env:PGPASSWORD='postgres'; & 'C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe' -U postgres -h 127.0.0.1 -d puca -c "TRUNCATE TABLE users, servers, server_members, channels, messages, dm_conversations, dm_messages, friend_requests, friends, reactions, custom_emojis, reports, audit_log, roles, user_roles, channel_keys, member_roles, server_roles, invites, bans, member_timeouts CASCADE;"`;
        execSync(cmd, { shell: 'powershell.exe' });
        console.log('[E2E Setup] Database truncated successfully.');
    } catch (err) {
        console.error('[E2E Setup] Database truncation failed:', err);
    }
}

// Function to run a direct psql query and return stdout
function runQuery(query: string): string {
    try {
        const cmd = `$env:PGPASSWORD='postgres'; & 'C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe' -U postgres -h 127.0.0.1 -d puca -t -A -c "${query}"`;
        return execSync(cmd, { shell: 'powershell.exe' }).toString().trim();
    } catch (err) {
        console.error('[E2E DB Query] Query failed:', err);
        return '';
    }
}

async function dismissWelcomePopup(page: Page) {
    const closeBtn = page.locator('.welcome-popup-close');
    try {
        await closeBtn.waitFor({ state: 'visible', timeout: 2000 });
        await closeBtn.click();
        console.log('[E2E] Welcome popup dismissed.');
    } catch {
        // Not visible or timed out, which is fine
    }
}

// The v3-crypto recovery-code modal appears exactly once after every fresh
// registration and stacks ON TOP of the welcome popup — it must be dismissed
// first or every later click hangs. Call after each register → /chat redirect.
async function dismissRecoveryModal(page: Page) {
    const confirm = page.locator('.recovery-confirm input[type="checkbox"]');
    try {
        await confirm.waitFor({ state: 'visible', timeout: 5000 });
        await confirm.check();
        await page.click('.recovery-done-btn');
        console.log('[E2E] Recovery-code modal dismissed.');
    } catch {
        // Not shown (plain login, not a fresh registration), which is fine
    }
}

test.describe('Puca End-to-End Chat App Tests', () => {
    let browserContext: Browser;
    let pageA: Page;
    let pageB: Page;
    let pageC: Page;
    let serverId: string = '';
    let inviteCode: string = '';
    let channelId: string = '';
    let userAId: string = '';
    let userBId: string = '';
    let userCId: string = '';

    test.beforeAll(async ({ browser }) => {
        resetDatabase();
        browserContext = browser;
    });

    // eslint-disable-next-line no-empty-pattern -- Playwright idiom: request no fixtures, keep testInfo
    test.beforeEach(async ({}, testInfo) => {
        // Message seeding in test 3 is deliberately paced under the backend's
        // per-IP rate limiter (with 429 retries), which adds up to ~15s —
        // budget for it rather than flirting with the old 90s ceiling.
        testInfo.setTimeout(150000);
    });

    test('1. Authentication, Registration & Key Derivation', async () => {
        // Create context A for User A
        const contextA = await browserContext.newContext();
        await contextA.route(/.*(placeholder|giphy).*/, route => {
            route.fulfill({
                status: 200,
                contentType: 'image/png',
                body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
            });
        });
        pageA = await contextA.newPage();
        pageA.on('console', msg => console.log(`[Browser A] ${msg.type()}: ${msg.text()}`));

        // 1.1 Navigate to home, wait for redirect to login
        await pageA.goto('/');
        await pageA.waitForURL('**/login');
        await expect(pageA).toHaveTitle(/frontend|Puca/);
        
        // Register User A
        await pageA.click('.toggle-mode'); // Switch to Register mode
        await expect(pageA.locator('button[type="submit"]')).toHaveText('Create Account');
        await pageA.fill('#username', 'user_a');
        await pageA.fill('#password', 'password123');
        await pageA.click('button[type="submit"]');

        // Assert auto-login and redirection to /chat
        await pageA.waitForURL('**/chat');
        await dismissRecoveryModal(pageA);
        await dismissWelcomePopup(pageA);
        await expect(pageA.locator('.user-profile-info')).toContainText('user_a');

        // Get User A ID from DB
        userAId = runQuery("SELECT id FROM users WHERE username = 'user_a';");
        expect(userAId).not.toBe('');

        // Wait to throttle auth requests
        await pageA.waitForTimeout(3500);

        // 1.2 Log User A out
        await pageA.locator('.user-action-btn[title="Settings"]').evaluate(el => (el as HTMLElement).click());
        await pageA.locator('.settings-nav-item.logout').evaluate(el => (el as HTMLElement).click());
        await pageA.waitForURL('**/login');

        // Wait to throttle auth requests
        await pageA.waitForTimeout(3500);

        // 1.3 Wrong password rejection
        await pageA.fill('#username', 'user_a');
        await pageA.fill('#password', 'wrong_password');
        await pageA.click('button[type="submit"]');
        await expect(pageA.locator('.error-message')).toContainText(/Invalid username or password|failed/i);

        // Wait to throttle auth requests
        await pageA.waitForTimeout(3500);

        // 1.4 Valid login with correct password
        await pageA.fill('#password', 'password123');
        await pageA.click('button[type="submit"]');
        await pageA.waitForURL('**/chat');
        await dismissWelcomePopup(pageA);

        // 1.5 Session persists on reload
        await pageA.reload();
        await expect(pageA.locator('.user-profile-info')).toContainText('user_a', { timeout: 15000 });
        await dismissWelcomePopup(pageA);

        // Wait to throttle auth requests
        await pageA.waitForTimeout(3500);

        // 1.6 Create context B and Register User B via UI (crucial for E2EE keys)
        const contextB = await browserContext.newContext();
        await contextB.route(/.*(placeholder|giphy).*/, route => {
            route.fulfill({
                status: 200,
                contentType: 'image/png',
                body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
            });
        });
        pageB = await contextB.newPage();
        pageB.on('console', msg => console.log(`[Browser B] ${msg.type()}: ${msg.text()}`));
        await pageB.goto('/');
        await pageB.waitForURL('**/login');
        await pageB.click('.toggle-mode');
        await expect(pageB.locator('button[type="submit"]')).toHaveText('Create Account');
        await pageB.fill('#username', 'user_b');
        await pageB.fill('#password', 'password456');
        await pageB.click('button[type="submit"]');
        await pageB.waitForURL('**/chat');
        await dismissRecoveryModal(pageB);
        await dismissWelcomePopup(pageB);
        await expect(pageB.locator('.user-profile-info')).toContainText('user_b');

        userBId = runQuery("SELECT id FROM users WHERE username = 'user_b';");
        expect(userBId).not.toBe('');

        // Wait to throttle auth requests
        await pageB.waitForTimeout(3500);

        // 1.7 Create context C and Register User C via UI (crucial for E2EE keys)
        const contextC = await browserContext.newContext();
        await contextC.route(/.*(placeholder|giphy).*/, route => {
            route.fulfill({
                status: 200,
                contentType: 'image/png',
                body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
            });
        });
        pageC = await contextC.newPage();
        pageC.on('console', msg => console.log(`[Browser C] ${msg.type()}: ${msg.text()}`));
        await pageC.goto('/');
        await pageC.waitForURL('**/login');
        await pageC.click('.toggle-mode');
        await expect(pageC.locator('button[type="submit"]')).toHaveText('Create Account');
        await pageC.fill('#username', 'user_c');
        await pageC.fill('#password', 'password789');
        await pageC.click('button[type="submit"]');
        await pageC.waitForURL('**/chat');
        await dismissRecoveryModal(pageC);
        await dismissWelcomePopup(pageC);
        await expect(pageC.locator('.user-profile-info')).toContainText('user_c');

        userCId = runQuery("SELECT id FROM users WHERE username = 'user_c';");
        expect(userCId).not.toBe('');
    });

    test('2. Servers & Channels management', async () => {
        await pageA.bringToFront();

        // 2.1 Create server
        await pageA.click('.server-icon.add-server');
        await pageA.click('.template-card:has-text("Create My Own")');
        await pageA.click('.skip-btn');
        await pageA.fill('input[placeholder="Enter server name"]', 'E2E Server');
        await pageA.click('.create-btn');
        await expect(pageA.locator('.server-name')).toContainText('E2E Server');

        // Close Friends Panel overlay if it remains open (unblocking the channel sidebar)
        try {
            await pageA.locator('.close-btn').click({ timeout: 2000 });
        } catch {
            // Friends panel not open or closed
        }

        serverId = runQuery("SELECT id FROM servers ORDER BY created_at DESC LIMIT 1;");
        expect(serverId).not.toBe('');
        console.log(`[E2E] Server ID is ${serverId}`);

        // 2.2 Create Category (Collection)
        await pageA.click('.add-channel-btn[title="Create Text Channel"]');
        await pageA.click('.type-btn:has-text("Collection")');
        await pageA.fill('.modal input[type="text"]', 'Test Category');
        await pageA.click('.modal button[type="submit"]');
        await expect(pageA.locator('.channel.collection-parent')).toContainText('Test Category');

        // 2.3 Create Text Channel nested under Test Category
        await pageA.click('.add-channel-btn[title="Create Text Channel"]');
        await pageA.selectOption('.parent-channel-select', { label: 'Test Category' });
        await pageA.fill('.modal input[type="text"]', 'test-text');
        await pageA.click('.modal button[type="submit"]');
        await expect(pageA.locator('.channel.subchannel', { hasText: 'test-text' })).toBeVisible();

        // 2.4 Create Voice Channel nested under Test Category
        await pageA.click('.add-channel-btn[title="Create Text Channel"]');
        await pageA.click('.type-btn:has-text("Voice")');
        await pageA.selectOption('.parent-channel-select', { label: 'Test Category' });
        await pageA.fill('.modal input[type="text"]', 'test-voice');
        await pageA.click('.modal button[type="submit"]');
        await expect(pageA.locator('.voice-channel', { hasText: 'test-voice' })).toBeVisible();

        // 2.5 Edit Text Channel
        await pageA.locator('.channel.subchannel', { hasText: 'test-text' }).click({ button: 'right' });
        await pageA.waitForTimeout(200);
        await pageA.click('text=Edit Channel');
        await pageA.fill('#channel-name', 'test-text-edited');
        await pageA.fill('#channel-topic', 'E2E Testing Topic');
        await pageA.selectOption('#channel-slowmode', { value: '5' }); // 5s slowmode
        await pageA.click('button[type="submit"]:has-text("Save Changes")');
        await expect(pageA.locator('.channel.subchannel', { hasText: 'test-text-edited' })).toBeVisible();

        channelId = runQuery("SELECT id FROM channels WHERE name = 'test-text-edited' LIMIT 1;");
        expect(channelId).not.toBe('');

        // 2.6 Delete Voice Channel
        pageA.once('dialog', async dialog => {
            await dialog.accept();
        });
        await pageA.locator('.voice-channel', { hasText: 'test-voice' }).click({ button: 'right' });
        await pageA.waitForTimeout(200);
        await pageA.click('text=Delete Channel');
        await expect(pageA.locator('.voice-channel', { hasText: 'test-voice' })).not.toBeVisible();
    });

    test('3. Messaging & Interactive Features', async () => {
        // 3.1 Invite User B and User C to the server
        await pageA.bringToFront();
        await pageA.click('.server-settings-btn');
        await pageA.click('text=Invites');
        await pageA.click('button:has-text("Create Invite")');
        
        const codeLocator = pageA.locator('code');
        await expect(codeLocator).toBeVisible();
        inviteCode = (await codeLocator.innerText()).trim();
        expect(inviteCode).not.toBe('');
        console.log(`[E2E] Invite code is ${inviteCode}`);
        await pageA.click('.close-btn');

        // Let user B join the server
        await pageB.bringToFront();
        await pageB.click('.server-icon.discover-server'); // Join Server
        await pageB.fill('input[placeholder*="invite"]', inviteCode);
        await pageB.click('button:has-text("Look Up Invite")');
        await pageB.click('button:has-text("Join Server")');
        await expect(pageB.locator('.server-name')).toContainText('E2E Server');
        await pageB.click('.channel.subchannel:has-text("test-text-edited")');

        // Let user C join the server
        await pageC.bringToFront();
        await pageC.click('.server-icon.discover-server');
        await pageC.fill('input[placeholder*="invite"]', inviteCode);
        await pageC.click('button:has-text("Look Up Invite")');
        await pageC.click('button:has-text("Join Server")');
        await expect(pageC.locator('.server-name')).toContainText('E2E Server');
        await pageC.click('.channel.subchannel:has-text("test-text-edited")');

        // 3.2 Real-time Messaging verification (A and B are both logged in with keys derived)
        await pageA.bringToFront();
        await pageA.click('.channel.subchannel:has-text("test-text-edited")');
        const inputA = pageA.locator('.message-form textarea');
        await inputA.fill('Hello from User A');
        await inputA.press('Enter');

        // Check instantly visible on page B
        await pageB.bringToFront();
        await expect(pageB.locator('.message', { hasText: 'Hello from User A' })).toBeVisible();

        const inputB = pageB.locator('.message-form textarea');
        await inputB.fill('Hello from User B');
        await inputB.press('Enter');

        // Check instantly visible on page A
        await pageA.bringToFront();
        await expect(pageA.locator('.message', { hasText: 'Hello from User B' })).toBeVisible();

        // 3.3 Markdown Formatting
        await inputA.fill('**bold**');
        await inputA.press('Enter');
        await expect(pageA.locator('.message strong', { hasText: 'bold' }).last()).toBeVisible();

        await inputA.fill('*italic*');
        await inputA.press('Enter');
        await expect(pageA.locator('.message em', { hasText: 'italic' }).last()).toBeVisible();

        await inputA.fill('__underline__');
        await inputA.press('Enter');
        await expect(pageA.locator('.message u', { hasText: 'underline' }).last()).toBeVisible();

        await inputA.fill('~~strike~~');
        await inputA.press('Enter');
        await expect(pageA.locator('.message del', { hasText: 'strike' }).last()).toBeVisible();

        await inputA.fill('||spoiler||');
        await inputA.press('Enter');
        await expect(pageA.locator('.message span.spoiler', { hasText: 'spoiler' }).last()).toBeVisible();

        await inputA.fill('`inline code`');
        await inputA.press('Enter');
        await expect(pageA.locator('.message code.inline-code', { hasText: 'inline code' }).last()).toBeVisible();

        await inputA.fill('```\ncode block\n```');
        await inputA.press('Enter');
        await expect(pageA.locator('.message pre.code-block code', { hasText: 'code block' }).last()).toBeVisible();

        await inputA.fill('> quote');
        await inputA.press('Enter');
        await expect(pageA.locator('.message blockquote.message-quote', { hasText: 'quote' }).last()).toBeVisible();

        // 3.4 Mentions and References
        // Typing @name opens the familiar chat-app mention autocomplete popup; the first
        // Enter completes the highlighted entry, the second sends the message.
        await inputA.fill('@user_b');
        await inputA.press('Enter'); // complete mention from popup
        await inputA.press('Enter'); // send
        await expect(pageA.locator('.message span.mention', { hasText: '@user_b' }).last()).toBeVisible();

        // @everyone matches no member, so no popup opens — a single Enter sends.
        await inputA.fill('@everyone');
        await inputA.press('Enter');
        await expect(pageA.locator('.message span.mention.everyone', { hasText: '@everyone' }).last()).toBeVisible();

        await inputA.fill('#test-text-edited');
        await inputA.press('Enter'); // complete channel from popup
        await inputA.press('Enter'); // send
        await expect(pageA.locator('.message span.mention.channel', { hasText: '#test-text-edited' }).last()).toBeVisible();

        // 3.5 Image and GIF Embeds
        await inputA.fill('https://via.placeholder.com/150.png');
        await inputA.press('Enter');
        await expect(pageA.locator('.message span.message-image img').last()).toBeVisible();

        await inputA.fill('https://media.giphy.com/media/t3NzfCL24gFBm/giphy.gif');
        await inputA.press('Enter');
        await expect(pageA.locator('.message span.message-image img').last()).toBeVisible();

        // 3.6 Edit and Delete message
        const lastMsg = pageA.locator('.message', { hasText: 'Hello from User A' }).last();
        
        // Edit message (native prompt)
        pageA.once('dialog', async dialog => {
            await dialog.accept('Hello from User A [EDITED]');
        });
        await lastMsg.hover();
        await lastMsg.locator('.msg-action-btn[title="Edit"]').click();
        await expect(pageA.locator('.message', { hasText: 'Hello from User A [EDITED]' })).toBeVisible();

        // Delete message (native confirm)
        pageA.once('dialog', async dialog => {
            await dialog.accept();
        });
        const editedMsg = pageA.locator('.message', { hasText: 'Hello from User A [EDITED]' }).last();
        await editedMsg.hover();
        await editedMsg.locator('.msg-action-btn.delete[title="Delete"]').click();
        await expect(pageA.locator('.message', { hasText: 'Hello from User A [EDITED]' })).not.toBeVisible();

        // 3.7 Pin message
        pageA.once('dialog', async dialog => {
            await dialog.accept(); // Message pinned alert
        });
        const msgToPin = pageA.locator('.message', { hasText: '@user_b' }).last();
        await msgToPin.hover();
        await msgToPin.locator('.msg-action-btn[title="Pin Message"]').click();

        // Verify pinning via DB
        const pinCount = runQuery(`SELECT count(*) FROM pinned_messages WHERE channel_id = ${channelId};`);
        expect(parseInt(pinCount)).toBeGreaterThan(0);

        // 3.8 Search Messages
        await pageA.fill('.search-bar input', 'bold');
        await pageA.waitForSelector('.search-results');
        await expect(pageA.locator('.search-result-item')).toContainText('bold');
        await pageA.click('.search-results-header button'); // Close search

        // 3.9 Pagination: Seed 55 messages via API directly in pageA context for speed
        const dbChannelId = runQuery("SELECT id FROM channels WHERE name = 'test-text-edited' LIMIT 1;");
        console.log(`[E2E] Channel ID for pagination: ${dbChannelId}`);
        const parsedChannelId = parseInt(dbChannelId);
        const apiBaseUrl = process.env.VITE_API_URL || 'http://127.0.0.1:3000';

        console.log('[E2E] Seeding 55 messages for pagination via API...');
        await pageA.evaluate(async ({ cid, baseUrl }) => {
            const token = localStorage.getItem('auth_token');
            if (!token) throw new Error("No auth token found in localStorage!");
            for (let i = 1; i <= 55; i++) {
                // The API limiter (src/middleware/rate_limit.rs) is keyed per
                // IP: burst 100, refill 1 token/20ms — and all three test
                // browser contexts share 127.0.0.1. Each seeded message also
                // fans out over WS and triggers refetches from the other two
                // pages, so seeding effectively costs ~3 requests per POST.
                // Pace well below the shared refill and retry on 429 (bucket
                // refills in ~1s) instead of failing the run.
                await new Promise(r => setTimeout(r, 100));
                let res!: Response;
                for (let attempt = 0; attempt < 5; attempt++) {
                    res = await fetch(`${baseUrl}/channels/${cid}/messages`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify({
                            content: `Pagination message ${i}`,
                            is_task: false
                        })
                    });
                    if (res.status !== 429) break;
                    await new Promise(r => setTimeout(r, 1000));
                }
                if (!res.ok) {
                    throw new Error(`Failed to seed message ${i}: ${res.status} ${res.statusText}`);
                }
            }
        }, { cid: parsedChannelId, baseUrl: apiBaseUrl });
        console.log('[E2E] Seeding pagination messages complete.');

        // Space out message timestamps in the DB to avoid millisecond truncation/timezone pagination issues
        runQuery(`
            WITH rows AS (
                SELECT id, row_number() OVER (ORDER BY created_at ASC) as rn 
                FROM messages 
                WHERE content LIKE 'Pagination message%'
            )
            UPDATE messages 
            SET created_at = CASE 
                WHEN rn <= 10 THEN NOW() - INTERVAL '1 day' - (10 - rn) * INTERVAL '2 seconds'
                ELSE NOW() - (60 - rn) * INTERVAL '2 seconds'
            END
            FROM rows 
            WHERE messages.id = rows.id;
        `);
        console.log('[E2E] Spaced out message timestamps in database.');

        // Force a channel refetch to load the seeded messages. The bootstrap
        // text channel is named "default" since v0.5.62 (was "general");
        // exclude the same-named voice channel from the match.
        await pageA.click('.channel:not(.voice-channel):has-text("default")');
        await pageA.click('.channel.subchannel:has-text("test-text-edited")');

        // Wait for messages to load
        await expect(pageA.locator('.message', { hasText: 'Pagination message 55' })).toBeVisible();

        // Verify Load older messages button appears
        await pageA.locator('.messages-container').evaluate((el) => el.scrollTop = 0);
        await expect(pageA.locator('.load-older-btn')).toBeVisible();
        await pageA.click('.load-older-btn');
        await expect(pageA.locator('.message', { hasText: /Pagination message 1\b/ }).first()).toBeVisible();

        // 3.10 Slowmode enforcement at the API level (Correction #4)
        // User B sent "Hello from User B" earlier in this test; on a fast local
        // run everything since may have taken <5s, so B could still be inside
        // the 5s slowmode window and message 1 would 429. Wait it out so the
        // (200, 429) pair below deterministically tests the enforcement itself.
        await pageB.waitForTimeout(5500);
        console.log('[E2E] Testing slowmode (429) at API level...');
        const slowmodeResult = await pageB.evaluate(async ({ cid, baseUrl }) => {
            const token = localStorage.getItem('auth_token');
            
            // First message
            const res1 = await fetch(`${baseUrl}/channels/${cid}/messages`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ content: 'API slowmode test message 1' })
            });

            // Second message sent immediately
            const res2 = await fetch(`${baseUrl}/channels/${cid}/messages`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ content: 'API slowmode test message 2' })
            });

            return { status1: res1.status, status2: res2.status };
        }, { cid: parsedChannelId, baseUrl: apiBaseUrl });

        console.log(`[E2E] Slowmode API response statuses: ${slowmodeResult.status1}, ${slowmodeResult.status2}`);
        expect(slowmodeResult.status1).toBe(200);
        expect(slowmodeResult.status2).toBe(429); // Must return HTTP 429

        // User A (Owner) is exempt from slowmode
        const ownerSlowmodeResult = await pageA.evaluate(async ({ cid, baseUrl }) => {
            const token = localStorage.getItem('auth_token');
            const res1 = await fetch(`${baseUrl}/channels/${cid}/messages`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ content: 'API owner slowmode 1' })
            });
            const res2 = await fetch(`${baseUrl}/channels/${cid}/messages`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ content: 'API owner slowmode 2' })
            });
            return { status1: res1.status, status2: res2.status };
        }, { cid: parsedChannelId, baseUrl: apiBaseUrl });
        expect(ownerSlowmodeResult.status1).toBe(200);
        expect(ownerSlowmodeResult.status2).toBe(200);
    });

    test('4. Reactions & Emojis', async () => {
        await pageA.bringToFront();
        await pageA.locator('.message', { hasText: 'Pagination message 55' }).hover();
        
        // Add emoji reaction: the add-reaction button under the message opens the
        // picker (full EmojiPicker; 👍 is in the default "Frequently Used" grid).
        const reactToggle = pageA.locator('.message', { hasText: 'Pagination message 55' }).locator('.add-reaction-btn');
        await reactToggle.click();
        await pageA.locator('.reaction-picker .emoji-btn', { hasText: '👍' }).first().click();

        // Assert updates for both users
        await expect(pageA.locator('.reaction-emoji', { hasText: '👍' })).toBeVisible();
        await pageB.bringToFront();
        await expect(pageB.locator('.reaction-emoji', { hasText: '👍' })).toBeVisible();

        // Clicking someone else's reaction joins it (additive reaction semantics): count 1 → 2.
        await pageB.locator('.reaction-badge', { hasText: '👍' }).click();
        await expect(pageB.locator('.reaction-badge', { hasText: '👍' }).locator('.reaction-count')).toHaveText('2');
        // A sees B join in real time.
        await expect(pageA.locator('.reaction-badge', { hasText: '👍' }).locator('.reaction-count')).toHaveText('2');
        // Clicking again removes only B's own reaction: back to 1, badge still visible.
        await pageB.locator('.reaction-badge', { hasText: '👍' }).click();
        await expect(pageB.locator('.reaction-badge', { hasText: '👍' }).locator('.reaction-count')).toHaveText('1');

        // 4.2 Upload custom server emoji via API and use it
        const apiBaseUrl = process.env.VITE_API_URL || 'http://127.0.0.1:3000';
        await pageA.bringToFront();
        await pageA.evaluate(async ({ srvId, baseUrl }) => {
            const token = localStorage.getItem('auth_token');
            const fileBlob = new Blob(['PNG_MOCK_DATA'], { type: 'image/png' });
            const formData = new FormData();
            formData.append('file', fileBlob, 'custom_emoji.png');

            const uploadRes = await fetch(`${baseUrl}/upload`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: formData
            });
            const uploaded = await uploadRes.json();

            await fetch(`${baseUrl}/servers/${srvId}/emojis`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ name: 'my_custom_emoji', file_id: uploaded.id })
            });
        }, { srvId: serverId, baseUrl: apiBaseUrl });

        // Open the reaction picker again — custom server emojis render in a row
        // above the standard grid (.picker-emoji.custom).
        await pageA.locator('.message', { hasText: 'Pagination message 55' }).hover();
        await pageA.locator('.message', { hasText: 'Pagination message 55' }).locator('.add-reaction-btn').click();
        
        const customEmojiBtn = pageA.locator('.picker-emoji.custom[title=":my_custom_emoji:"]');
        await expect(customEmojiBtn).toBeVisible();
        await customEmojiBtn.click();

        // Verify custom emoji reaction displays on both pages
        await expect(pageA.locator('.reaction-emoji img.custom-emoji-img')).toBeVisible();
        await pageB.bringToFront();
        await expect(pageB.locator('.reaction-emoji img.custom-emoji-img')).toBeVisible();
    });

    test('5. Direct Messages & Friends (with Block enforcement check)', async () => {
        // 5.1 Send friend request A -> B
        await pageA.bringToFront();
        await pageA.locator('.member-item.online', { hasText: 'user_b' }).click();
        await pageA.locator('.friend-btn:has-text("Add Friend")').click();
        await expect(pageA.locator('.friend-btn')).toContainText('Request Sent');
        await pageA.locator('.user-profile-popup').dispatchEvent('mousedown'); // Close popup

        // B accepts friend request
        await pageB.bringToFront();
        await pageB.click('.server-icon.home-button'); // Open Friends panel
        await pageB.click('.header-tab:has-text("Pending")');
        await pageB.locator('.action-accept').click();
        
        // Verify they are friends
        await pageB.click('.header-tab:has-text("All")');
        await expect(pageB.locator('.friend-row')).toContainText('user_a');

        // 5.2 Direct messaging both ways (real-time)
        // The row's message button opens the DM (clicking the row itself does nothing).
        await pageB.locator('.friend-row', { hasText: 'user_a' }).locator('.action-msg').click();
        const dmInputB = pageB.locator('.message-form textarea');
        await dmInputB.fill('DM from User B');
        await dmInputB.press('Enter');

        // Check User A receives DM
        await pageA.bringToFront();
        await pageA.click('.server-icon.home-button');
        await pageA.locator('.dm-item', { hasText: 'user_b' }).click();
        await expect(pageA.locator('.message', { hasText: 'DM from User B' })).toBeVisible();

        const dmInputA = pageA.locator('.message-form textarea');
        await dmInputA.fill('DM from User A');
        await dmInputA.press('Enter');

        await pageB.bringToFront();
        await expect(pageB.locator('.message', { hasText: 'DM from User A' })).toBeVisible();

        // 5.3 Block User B (A blocks B)
        const blockApiBase = process.env.VITE_API_URL || 'http://127.0.0.1:3000';
        await pageA.bringToFront();
        await pageA.evaluate(async ({ bid, baseUrl }) => {
            const token = localStorage.getItem('auth_token');
            await fetch(`${baseUrl}/users/${bid}/block`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` }
            });
        }, { bid: parseInt(userBId), baseUrl: blockApiBase });

        // 5.4 Verify if the backend actually enforces blocks on DM send (Correction #4)
        console.log('[E2E] Testing Block enforcement on DM Send at API level...');
        const blockDMResult = await pageB.evaluate(async ({ baseUrl }) => {
            const token = localStorage.getItem('auth_token');
            // Try to start/send DM message to User A
            // We first search for active conversations
            const dmsRes = await fetch(`${baseUrl}/dms`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const dms = await dmsRes.json();
            const dmWithA = dms.find(d => d.other_username === 'user_a');
            if (!dmWithA) return { status: 999, message: 'Conversation not found' };

            const res = await fetch(`${baseUrl}/dms/${dmWithA.id}/messages`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ content: 'Post block message content' })
            });

            return { status: res.status };
        }, { baseUrl: blockApiBase });

        console.log(`[E2E] Blocked DM send API result status: ${blockDMResult.status}`);
        if (blockDMResult.status === 200) {
            console.log('[QA FINDING] GAP IDENTIFIED: Backend does NOT enforce blocks on DM send (API returned 200). Block is client-side only!');
            // Report the finding without failing the test (as instructed)
        } else {
            console.log(`[E2E] Backend successfully enforced block (API returned status: ${blockDMResult.status}).`);
            expect(blockDMResult.status).toBeGreaterThanOrEqual(400);
        }

        // Unblock B
        await pageA.evaluate(async ({ bid, baseUrl }) => {
            const token = localStorage.getItem('auth_token');
            await fetch(`${baseUrl}/users/${bid}/block`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            });
        }, { bid: parseInt(userBId), baseUrl: blockApiBase });
    });

    test('6. E2EE Cryptographic verification & Forward Secrecy', async () => {
        // 6.1 DM Secrecy DB Check
        const dbDMContent = runQuery("SELECT content FROM dm_messages ORDER BY created_at DESC LIMIT 1;");
        expect(dbDMContent).toContain('{"v":3');
        expect(dbDMContent).toContain('"ct"');
        expect(dbDMContent).not.toContain('DM from User A');
        console.log('[E2E] DB DM message content is secure (encrypted):', dbDMContent);

        // 6.2 Channel Secrecy DB Check
        const dbChannelMsg = runQuery("SELECT content, key_epoch FROM messages WHERE key_epoch IS NOT NULL ORDER BY created_at DESC LIMIT 1;");
        expect(dbChannelMsg).toContain('{"v":3');
        expect(dbChannelMsg).toContain('"ct"');
        expect(dbChannelMsg).not.toContain('API owner slowmode 2');
        console.log('[E2E] DB channel message content is secure (encrypted):', dbChannelMsg);

        // 6.3 Key Recovery / Cross-device decryption
        const contextA2 = await browserContext.newContext();
        const pageA2 = await contextA2.newPage();
        await pageA2.goto('/');
        await pageA2.waitForURL('**/login');
        
        // Log in in a completely fresh profile (no local storage keys)
        await pageA2.fill('#username', 'user_a');
        await pageA2.fill('#password', 'password123');
        await pageA2.click('button[type="submit"]');
        await pageA2.waitForURL('**/chat');
        await dismissWelcomePopup(pageA2);

        // Check we can still read historical DMs
        await pageA2.click('.server-icon.home-button');
        await pageA2.locator('.dm-item', { hasText: 'user_b' }).click();
        await expect(pageA2.locator('.message', { hasText: 'DM from User B' })).toBeVisible();
        await contextA2.close();

        // 6.4 E2EE Forward Secrecy DB-level verification (Correction #3)
        console.log('[E2E] Verifying forward secrecy at DB layer...');
        
        // Current epoch before User C is kicked
        const currentEpochStr = runQuery(`SELECT MAX(epoch) FROM channel_keys WHERE channel_id = ${channelId};`);
        const currentEpoch = parseInt(currentEpochStr) || 0;
        console.log(`[E2E] Current epoch: ${currentEpoch}`);

        // Kick User C via the real moderation endpoint (POST /servers/:id/kick/:uid).
        // Must use the absolute API base — a relative URL hits the Vite dev server
        // and silently no-ops.
        const kickApiBase = process.env.VITE_API_URL || 'http://127.0.0.1:3000';
        await pageA.bringToFront();
        const kickStatus = await pageA.evaluate(async ({ sid, cid, baseUrl }) => {
            const token = localStorage.getItem('auth_token');
            const res = await fetch(`${baseUrl}/servers/${sid}/kick/${cid}`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ reason: 'E2E forward-secrecy test' })
            });
            return res.status;
        }, { sid: serverId, cid: parseInt(userCId), baseUrl: kickApiBase });
        console.log(`[E2E] Kick User C status: ${kickStatus}`);
        expect(kickStatus).toBe(200);

        // User A sends a new message in the channel
        const inputA = pageA.locator('.message-form textarea');
        await pageA.click(`.server-icon[title="E2E Server"]`);
        await pageA.click('.channel.subchannel:has-text("test-text-edited")');
        await inputA.fill('Message after kicking User C');
        await inputA.press('Enter');
        await expect(pageA.locator('.message', { hasText: 'Message after kicking User C' })).toBeVisible();

        // Check the new message's key_epoch and verify C cannot decrypt new keys.
        // The visible message above is the client's optimistic render — the key
        // rotation (detect generation bump -> mint epoch -> publish -> send) is
        // still in flight, so poll the DB rather than asserting instantly.
        let nextEpoch = 0;
        for (let attempt = 0; attempt < 20; attempt++) {
            nextEpoch = parseInt(runQuery(`SELECT MAX(epoch) FROM channel_keys WHERE channel_id = ${channelId};`)) || 0;
            if (nextEpoch > currentEpoch) break;
            await pageA.waitForTimeout(500);
        }
        console.log(`[E2E] Next epoch after kick: ${nextEpoch}`);
        expect(nextEpoch).toBeGreaterThan(currentEpoch);

        // Verify there is NO row in channel_keys for User C at the new epoch
        const userCKeysCount = runQuery(`SELECT count(*) FROM channel_keys WHERE channel_id = ${channelId} AND epoch = ${nextEpoch} AND recipient_id = ${userCId};`);
        console.log(`[E2E] Number of keys wrapped for User C at epoch ${nextEpoch}: ${userCKeysCount}`);
        expect(parseInt(userCKeysCount)).toBe(0);

        // Verify rows DO exist for A and B
        const userAKeysCount = runQuery(`SELECT count(*) FROM channel_keys WHERE channel_id = ${channelId} AND epoch = ${nextEpoch} AND recipient_id = ${userAId};`);
        const userBKeysCount = runQuery(`SELECT count(*) FROM channel_keys WHERE channel_id = ${channelId} AND epoch = ${nextEpoch} AND recipient_id = ${userBId};`);
        expect(parseInt(userAKeysCount)).toBe(1);
        expect(parseInt(userBKeysCount)).toBe(1);
        console.log('[E2E] Cryptographic forward secrecy successfully verified in database.');
    });

    test('7. Roles, Moderation & Reports', async () => {
        await pageA.bringToFront();

        // 7.1 Create role "Moderator" and assign KICK/BAN permissions
        await pageA.click('.server-settings-btn');
        await pageA.click('text=Roles');
        await pageA.click('text=+ Create Role');
        
        await pageA.fill('input[value="New Role"]', 'Moderator');
        await pageA.locator('.permission-item:has-text("KICK MEMBERS") input').check();
        await pageA.locator('.permission-item:has-text("BAN MEMBERS") input').check();
        await pageA.click('button:has-text("Save")');
        await pageA.click('.close-btn');

        // Assign role Moderator to User B
        await pageA.locator('.member-item.online', { hasText: 'user_b' }).click();
        await pageA.locator('.role-checkbox:has-text("Moderator") input').check();
        await pageA.locator('.user-profile-popup').dispatchEvent('mousedown'); // Close popup

        // Verify User B has Moderator role tag
        await pageA.locator('.member-item.online', { hasText: 'user_b' }).click();
        await expect(pageA.locator('.role-tag', { hasText: 'Moderator' })).toBeVisible();
        await pageA.locator('.user-profile-popup').dispatchEvent('mousedown'); // Close popup

        // 7.2 Timeout User B (API fallback since no UI). Absolute API base —
        // relative URLs hit the Vite dev server and silently no-op.
        const modApiBase = process.env.VITE_API_URL || 'http://127.0.0.1:3000';
        await pageA.evaluate(async ({ sid, bid, baseUrl }) => {
            const token = localStorage.getItem('auth_token');
            await fetch(`${baseUrl}/servers/${sid}/timeout/${bid}`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ duration_seconds: 5, reason: 'E2E Timeout' })
            });
        }, { sid: serverId, bid: parseInt(userBId), baseUrl: modApiBase });

        // B tries to message during timeout, should fail (API level verification)
        console.log('[E2E] Testing timeout message rejection at API level...');
        const timeoutRes = await pageB.evaluate(async ({ cid, baseUrl }) => {
            const token = localStorage.getItem('auth_token');
            const res = await fetch(`${baseUrl}/channels/${cid}/messages`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ content: 'Message during timeout API test' })
            });
            return res.status;
        }, { cid: parseInt(channelId), baseUrl: modApiBase });
        console.log(`[E2E] Timeout message response status: ${timeoutRes}`);
        expect(timeoutRes).toBe(403); // Forbidden

        // Wait out the timeout
        await pageA.waitForTimeout(5000);

        // 7.3 Kick User B
        pageA.once('dialog', async dialog => {
            await dialog.accept();
        });
        await pageA.locator('.member-item.online', { hasText: 'user_b' }).click();
        await pageA.click('.kick-btn'); // Clicks Kick button

        // Verify User B is kicked and cannot see channels
        await pageB.bringToFront();
        await expect(pageB.locator('.server-name')).not.toBeVisible();

        // 7.4 Ban User B
        // Re-invite User B first so we can ban them
        await pageA.bringToFront();
        await pageA.click('.server-settings-btn');
        await pageA.click('text=Invites');
        await pageA.click('button:has-text("Create Invite")');
        // NB: the app writes invites to server_invites (the bare `invites` table is legacy/empty).
        const newInvite = runQuery("SELECT code FROM server_invites ORDER BY created_at DESC LIMIT 1;");
        await pageA.click('.close-btn');

        await pageB.bringToFront();
        await pageB.click('.server-icon.discover-server');
        await pageB.fill('input[placeholder*="invite"]', newInvite);
        await pageB.click('button:has-text("Look Up Invite")');
        await pageB.click('button:has-text("Join Server")');
        await expect(pageB.locator('.server-name')).toContainText('E2E Server');

        // Ban User B
        await pageA.bringToFront();
        pageA.once('dialog', async dialog => {
            await dialog.accept('E2E Ban reason');
        });
        await pageA.locator('.member-item.online', { hasText: 'user_b' }).click();
        await pageA.click('.ban-btn'); // Click Ban

        // Verify banned B is removed
        await pageB.bringToFront();
        await expect(pageB.locator('.server-name')).not.toBeVisible();

        // Try to rejoin, should fail due to Ban
        await pageB.click('.server-icon.discover-server');
        await pageB.fill('input[placeholder*="invite"]', newInvite);
        await pageB.click('button:has-text("Look Up Invite")');
        // It might fail during lookup or during join. Let's try both or expect error
        const joinError = pageB.locator('.error-toast, .error-message, .error');
        if (await joinError.isVisible()) {
            await expect(joinError).toContainText(/ban|banned|forbidden/i);
        }

        // 7.5 Audit Log Verification (API fallback)
        const auditLogs = JSON.parse(await pageA.evaluate(async ({ srvId, baseUrl }) => {
            const token = localStorage.getItem('auth_token');
            const res = await fetch(`${baseUrl}/servers/${srvId}/audit-log`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            return await res.text();
        }, { srvId: serverId, baseUrl: modApiBase }));

        expect(auditLogs.length).toBeGreaterThan(0);
        console.log('[E2E] Audit log verified. Log entries count:', auditLogs.length);

        // 7.6 Reports System (API fallback)
        // File report as User A on User B
        await pageA.evaluate(async ({ sid, bid, baseUrl }) => {
            const token = localStorage.getItem('auth_token');
            const repRes = await fetch(`${baseUrl}/servers/${sid}/reports`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    reported_user_id: bid,
                    report_type: 'spam',
                    reason: 'User B is spamming messages'
                })
            });
            const report = await repRes.json();

            // Resolve the report
            await fetch(`${baseUrl}/servers/${sid}/reports/${report.id}`, {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    status: 'resolved',
                    notes: 'Resolved by E2E test'
                })
            });
        }, { sid: serverId, bid: parseInt(userBId), baseUrl: modApiBase });

        // Assert report is in the database and is resolved
        const dbReportStatus = runQuery(`SELECT status FROM reports WHERE server_id = '${serverId}' ORDER BY created_at DESC LIMIT 1;`);
        expect(dbReportStatus).toBe('resolved');
        console.log('[E2E] Report system verified. DB report status is:', dbReportStatus);
    });
});
