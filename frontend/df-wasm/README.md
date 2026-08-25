# df-wasm — DeepFilterNet compiled to WebAssembly

This crate wraps the upstream [`deep_filter`](https://github.com/Rikorose/DeepFilterNet)
pipeline (tract runtime + embedded DFN3 model) and exposes a thin per-hop
`process()` to JavaScript via `wasm-bindgen`. It powers the **DeepFilter (Max)**
noise-suppression tier in the voice UI (`src/api/deepFilter.ts`).

## Prebuilt output is committed

The build output lives in [`../src/wasm/df/`](../src/wasm/df/) and **is checked
in** (the ~14 MB `df_wasm_bg.wasm` embeds the DFN3 model), so a plain
`npm run build` / `npm run tauri build` works with no Rust toolchain. You only
need to rebuild if you change `src/lib.rs`.

## Rebuilding

Requires Rust + the wasm target + wasm-pack:

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-pack --locked

cd frontend/df-wasm
# --remap-path-prefix is NOT optional: without it rustc bakes the ABSOLUTE path
# of every crate in ~/.cargo/registry into the panic-location strings, so the
# committed 14 MB artifact ships (and publishes) YOUR HOME DIRECTORY — 275
# copies of C:\Users\<you>\.cargo\... in the build this replaced. It is a
# public repo; strip it at build time rather than patching it out afterwards.
RUSTFLAGS="--remap-path-prefix=$HOME=~ --remap-path-prefix=$PWD=." \
  wasm-pack build --target web --release --out-dir pkg
cp pkg/df_wasm.js pkg/df_wasm_bg.wasm pkg/df_wasm.d.ts pkg/df_wasm_bg.wasm.d.ts ../src/wasm/df/

# Confirm before committing (expect no output):
grep -c "$(basename "$HOME")" ../src/wasm/df/df_wasm_bg.wasm
```

On Windows use `%USERPROFILE%` in place of `$HOME`.

`pkg/` and `target/` are git-ignored; only the copied files under
`src/wasm/df/` are committed.
