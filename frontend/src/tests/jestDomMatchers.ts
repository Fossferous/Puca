// jest-dom's matchers (toBeInTheDocument, …) and their type declarations.
// Its own entry is a typings SCRIPT, not a module, so setup.ts cannot import()
// it directly; it imports this module instead — AFTER the browser-global trap
// is armed, so a read of `window` while the matchers load would be caught.
import '@testing-library/jest-dom';
