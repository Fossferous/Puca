-- Case-Insensitive Login Migration
-- Run this on your PostgreSQL database to enable case-insensitive login
-- 
-- WARNING: This will require ALL users with mixed-case usernames to reset their passwords!
-- Make sure your email/password reset system is working before running this.

-- Step 1: Add force_password_reset column if it doesn't exist
ALTER TABLE users ADD COLUMN IF NOT EXISTS force_password_reset BOOLEAN DEFAULT FALSE;

-- Step 2: Mark all users with mixed-case usernames for password reset
-- Only users whose username differs from lowercase version need reset
UPDATE users 
SET force_password_reset = TRUE 
WHERE username != LOWER(username);

-- Step 3: Normalize all usernames to lowercase
-- This ensures uniqueness checks work correctly
UPDATE users 
SET username = LOWER(username);

-- Step 4: Verify the migration
-- This should return 0 rows (all usernames are now lowercase)
SELECT id, username FROM users WHERE username != LOWER(username);

-- Step 5: Check how many users need password reset
SELECT COUNT(*) as users_needing_reset FROM users WHERE force_password_reset = TRUE;

-- After running this migration:
-- 1. Deploy the updated backend (handles force_password_reset)
-- 2. Deploy the updated frontend (shows reset prompt, uses lowercase for SRP)
-- 3. Users will be prompted to reset their password on next login attempt
