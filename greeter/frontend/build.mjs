import { build, context } from 'esbuild';
import { solidPlugin } from 'esbuild-plugin-solid';
import { rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: { app: 'src/main.tsx' },
  outdir: 'dist',
  bundle: true,
  format: 'iife',
  // QuickJS (silnik JS Silvera) rozumie ES2020+; nie transpilujemy niżej, żeby kod był mały i szybki.
  target: 'es2020',
  platform: 'browser',
  conditions: ['browser'],
  minify: !watch,
  sourcemap: false,
  legalComments: 'none',
  jsx: 'preserve',
  loader: { '.ttf': 'file', '.woff': 'file', '.woff2': 'file' },
  assetNames: 'fonts/[name]-[hash]',
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
  plugins: [solidPlugin()],
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('[hdm-greeter] watch: dist/app.js, dist/app.css');
} else {
  rmSync('dist', { recursive: true, force: true });
  await build(options);
}
