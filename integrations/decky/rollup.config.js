import deckyPlugin from '@decky/rollup';
import typescript from '@rollup/plugin-typescript';

export default [
  // The plugin: src/index.tsx -> dist/index.js (Decky's standard build).
  deckyPlugin(),
  // The page shim the backend injects into the Púca page: one self-contained
  // script, no imports, nothing from Steam's globals (it runs in the page).
  {
    input: './src/shim/pageShim.ts',
    plugins: [typescript({ tsconfig: './tsconfig.shim.json' })],
    output: { file: 'dist/page-shim.js', format: 'iife' },
  },
];
