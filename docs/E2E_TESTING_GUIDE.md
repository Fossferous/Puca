# Level 3: Playwright E2E Testing Setup

## Context
- **Project**: Púca - a self-hosted, end-to-end encrypted chat application
- **Stack**: React + TypeScript frontend, Rust backend
- **Dev Port**: `http://localhost:1420` (Tauri/Vite)
- **Backend Tests**: ✅ Complete (Rust integration tests in `/tests/`)
- **Frontend Unit Tests**: ✅ Complete (Vitest in `/frontend/src/tests/`)

---

## Task: Initialize Playwright E2E Testing

### Step 1: Install Playwright
```powershell
cd <repo>\frontend
npm init playwright@latest
```

**Select these options:**
- Language: TypeScript
- Tests folder: `e2e`
- Add GitHub Actions: No
- Install browsers: Yes

---

### Step 2: Configure `playwright.config.ts`

Replace the generated config with:

```typescript
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  
  use: {
    baseURL: 'http://localhost:1420',
    trace: 'on-first-retry',
    
    // CRITICAL: Mock WebRTC devices to prevent permission popups
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream'
      ]
    }
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Start dev server before running tests
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:1420',
    reuseExistingServer: !process.env.CI,
  },
});
```

---

### Step 3: Create First E2E Test

Create `frontend/e2e/smoke.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';

test.describe('Smoke Tests', () => {
  test('homepage loads correctly', async ({ page }) => {
    await page.goto('/');
    
    // Verify page title
    await expect(page).toHaveTitle(/Púca/);
  });

  test('login button is visible', async ({ page }) => {
    await page.goto('/');
    
    // Find and verify login button
    const loginButton = page.getByRole('button', { name: /login/i });
    await expect(loginButton).toBeVisible();
  });

  test('can navigate to register', async ({ page }) => {
    await page.goto('/');
    
    // Click "Create Account" or similar link
    const registerLink = page.getByText(/create account|register|sign up/i);
    if (await registerLink.isVisible()) {
      await registerLink.click();
      await expect(page.getByText(/username/i)).toBeVisible();
    }
  });
});
```

---

### Step 4: Add npm Scripts

Add to `frontend/package.json`:

```json
{
  "scripts": {
    "e2e": "playwright test",
    "e2e:ui": "playwright test --ui",
    "e2e:headed": "playwright test --headed"
  }
}
```

---

### Step 5: Run Tests

```powershell
cd <repo>\frontend

# Run all E2E tests (headless)
npm run e2e

# Run with UI (interactive mode)
npm run e2e:ui

# Run with visible browser
npm run e2e:headed
```

---

## Important Notes

1. **WebRTC Mocking**: The `--use-fake-device-for-media-stream` flag is essential for voice/video tests
2. **Dev Server**: Playwright auto-starts `npm run dev` before tests
3. **Test Location**: All E2E tests go in `frontend/e2e/` folder
4. **No Backend Needed**: E2E tests use the real running app, backend must be running

---

## Next Steps After Basic Setup

1. **Auth Flow Test**: Login → Dashboard navigation
2. **Server Creation Test**: Create server → Add channel → Send message
3. **Voice Chat Test**: Join voice channel → Verify connection (mocked audio)
4. **Mobile Responsive Test**: Test with mobile viewport
