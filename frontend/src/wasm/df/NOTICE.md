# DeepFilterNet — built here, from pinned upstream sources

`df_wasm_bg.wasm`, `df_wasm.js` and the `.d.ts` files in this folder are
**built from `frontend/df-wasm/` in this repository**, not copied from
upstream. That crate links **DeepFilterNet** (the DeepFilterNet3 model,
embedded) by Hendrik Schröter and contributors:

- Source: https://github.com/Rikorose/DeepFilterNet
- Licence: dual-licensed under the MIT License **or** the Apache License,
  Version 2.0, at the user's option (see `LICENSE-MIT` and `LICENSE-APACHE`
  in the upstream repository). Puca redistributes it under the MIT License.
- Paper: H. Schröter, A. Maier, A. N. Escalante-B., T. Rosenkranz,
  "DeepFilterNet: Perceptually Motivated Real-Time Speech Enhancement".

Púca uses it as the "max quality" noise-suppression tier
(`frontend/src/api/deepFilter.ts`), loaded only when a user selects it.

The upstream version is pinned: `frontend/df-wasm/Cargo.toml` takes
`deep_filter` from the git tag `v0.5.6`. An earlier version of this file said
the commit "was not recorded at build time", which was wrong — the tag is in
the manifest.

**DeepFilterNet is not the only thing linked into that binary.** The crate also
pulls wasm-bindgen, ndarray, tract and their transitive dependencies: 149
packages in total, all permissive (MIT, Apache-2.0, BSD, Unlicense, 0BSD), and
every one of them is now listed in
[`THIRD_PARTY_NOTICES.md`](../../../../THIRD_PARTY_NOTICES.md) under the `wasm`
label. This file naming only DeepFilterNet was an incomplete notice for the
largest single artifact Púca ships.

MIT License

Copyright (c) 2022 Hendrik Schröter

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
