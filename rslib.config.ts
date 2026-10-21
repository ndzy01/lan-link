import { defineConfig } from '@rslib/core';

export default defineConfig({
  source: {
    entry: { index: ['./src/**/*.ts'] },
    tsconfigPath: './tsconfig.lib.json',
  },
  lib: [{ format: 'esm', bundle: false, dts: true }],
  output: { target: 'web', distPath: { root: 'dist' }, sourceMap: true },
});
