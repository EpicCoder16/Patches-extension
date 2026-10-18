'use strict';

// Bundles the offscreen-document Firebase auth entry point with esbuild so the
// extension ships no remote code (MV3 requirement) and no secrets.
//
//   node scripts/build-offscreen-auth.js
//
// Source: extension/offscreen/auth-entry.js
// Output: extension/offscreen/offscreen.bundle.js (loaded by offscreen.html)
// The Firebase web config itself is copied verbatim into dist/ by
// scripts/build-extension.js — never bundled or hardcoded.

const esbuild = require('esbuild');
const path = require('path');

const src = path.join(__dirname, '..', 'extension', 'offscreen', 'auth-entry.js');
const out = path.join(__dirname, '..', 'extension', 'offscreen', 'offscreen.bundle.js');

esbuild
  .build({
    entryPoints: [src],
    bundle: true,
    format: 'esm',
    target: 'chrome120',
    outfile: out,
    sourcemap: false,
    minify: false,
    logLevel: 'info',
  })
  .then(() => {
    process.stdout.write('Built extension/offscreen/offscreen.bundle.js\n');
  })
  .catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
