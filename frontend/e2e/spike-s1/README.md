# Spike S1 harness — kept, but S1 is already resolved

**You probably do not need to run this.** S1 was settled on 2026-07-29 by
API-level evidence, not by another experiment: WebView2 has **no mechanism** to
approve screen capture, so the answer cannot change with more measurement.

- `CoreWebView2PermissionKind` has no screen/display-capture value, and
  `getDisplayMedia` never raises `PermissionRequested`.
- `ICoreWebView2_27::add_ScreenCaptureStarting` is veto-or-defer only — it can
  cancel or delay the picker, never answer it.
- Edge's `ScreenCaptureWithoutGestureAllowedForOrigins` does not apply to
  WebView2, and addresses activation, which was never the blocker.

**What this harness is still good for:** confirming *why* a given build hangs —
it distinguishes "promise pending" from "page wedged", which the first S1 attempt
could not, and that ambiguity is the only reason S1 stayed open for a day.

    node collector.mjs      # http://127.0.0.1:8791/ , then point a webview at it

Arm B runs with no gesture 3s after load. Arm A needs a click and is the CONTROL:
if A also hangs, the flag or the harness is the problem, not activation.

**Do not use the in-app Browser pane.** It blocks localhost by policy and blocks
device capture outright, so it answers `NotAllowedError` regardless of the truth.

**The trap that cost the first attempt:** `additionalBrowserArgs` is split on
spaces by the argument tokenizer, so
`--auto-select-desktop-capture-source="Entire screen"` breaks at the space and
never takes effect. The same flag works in this repo's headless-Chromium e2e only
because it is passed as an argv ARRAY element, where no splitting happens.
