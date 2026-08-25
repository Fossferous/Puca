-- Keep the CURRENT verified email until the NEW one is proven.
--
-- The change-email flow used to UPDATE users.email and clear email_verified
-- BEFORE attempting to send the verification mail. A typo'd address or a down
-- SMTP relay therefore destroyed the previous verified email while the UI
-- reported "Could not send the verification email" — implying nothing had
-- changed. The address being verified now rides on the token row instead, and
-- users.email is only rewritten when that token is redeemed.
ALTER TABLE email_verification_tokens ADD COLUMN pending_email TEXT;
