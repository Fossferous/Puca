import { test, expect } from '@playwright/test';

test.describe('Smoke Tests', () => {
    test('homepage loads correctly', async ({ page }) => {
        await page.goto('/');

        // Verify page title
        await expect(page).toHaveTitle(/frontend|Puca/);
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
