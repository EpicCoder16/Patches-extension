'use strict';

// Builds the Chrome extension for local loading via chrome://extensions.
//
//   npm run build:extension
//
// Output: dist/extension/  — point Chrome's "Load unpacked" at this directory.
//
// The extension uses plain ES modules (no bundler), so the build is a clean
// recursive copy that guarantees dist never picks up stray secrets
// (.env, .env.*, etc.) or dev files. Icons are (re)generated first if missing.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const srcDir = path.join(root, 'extension');
const outDir = path.join(root, 'dist', 'extension');  // Everything the extension loads, per extension/manifest.json.
  const INCLUDES = ['manifest.json', 'background', 'content', 'popup', 'panel', 'offscreen', 'icons'];

function fail(msg) {
  process.stderr.write(`[build:extension] ${msg}\n`);
  process.exit(1);
}

function main() {
  const manifestPath = path.join(srcDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) fail('extension/manifest.json is missing.');

  // Basic manifest sanity checks (load-key errors surface in Chrome anyway).
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  for (const key of ['manifest_version', 'name', 'version', 'background', 'action']) {
    if (!(key in manifest)) fail(`manifest.json is missing "${key}".`);
  }
  if (manifest.manifest_version !== 3) fail('manifest_version must be 3.');

  // Every manifest-referenced path must exist — catches the classic
  // "default_popup file doesn't exist" warning before Chrome ever sees it.
  const manifestRefs = [
    ['default_popup', manifest.action && manifest.action.default_popup],
    ['service_worker', manifest.background && manifest.background.service_worker],
    ...(manifest.content_scripts || []).flatMap((cs) => (cs.js || []).map((f) => ['content script', f])),
    ...Object.entries(manifest.icons || {}),
  ];
  for (const [kind, ref] of [
    ...manifestRefs,
    ['side_panel.default_path', manifest.side_panel && manifest.side_panel.default_path],
  ]) {
    if (!ref) fail(`Manifest references no ${kind} path.`);
    if (!fs.existsSync(path.join(srcDir, ref))) fail(`Manifest ${kind} does not exist: extension/${ref}`);
  }

  // Verify the offscreen auth document wires up correctly.
  const offscreenHtml = path.join(srcDir, 'offscreen', 'offscreen.html');
  if (!fs.existsSync(path.join(srcDir, 'offscreen', 'auth-entry.js'))) fail('extension/offscreen/auth-entry.js is missing.');
  if (fs.existsSync(offscreenHtml)) {
    if (!fs.existsSync(path.join(srcDir, 'offscreen', 'offscreen.bundle.js'))) fail(
      'extension/offscreen/offscreen.bundle.js is missing — run scripts/build-offscreen-auth.js (npm run ext:auth).'
    );
    if (!fs.existsSync(path.join(srcDir, 'offscreen', 'offscreen.bundle.js'))) fail('offscreen.bundle.js is missing.');
  }

  // Regenerate icons when missing (extension/icons is committed, so usually a no-op).
  if (!fs.existsSync(path.join(srcDir, 'icons', 'icon48.png'))) {
    process.stdout.write('Icons missing — running scripts/generate-extension-icons.js\n');
    execFileSync(process.execPath, [path.join(__dirname, 'generate-extension-icons.js')], { stdio: 'inherit', cwd: root });
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  let copied = 0;
  for (const include of INCLUDES) {
    const from = path.join(srcDir, include);
    if (!fs.existsSync(from)) fail(`Missing extension source: extension/${include}`);
    const to = path.join(outDir, include);
    if (fs.statSync(from).isFile()) {
      fs.copyFileSync(from, to);
      copied++;
    } else {
      copied += copyDir(from, to);
    }
  }

  // Ship the repository's existing Firebase web config for the offscreen auth
  // document (public client config, same policy as the desktop app).
  const firebaseCfg = path.join(root, 'firebase-config.json');
  if (fs.existsSync(firebaseCfg)) {
    fs.mkdirSync(path.join(outDir, 'offscreen'), { recursive: true });
    fs.copyFileSync(firebaseCfg, path.join(outDir, 'offscreen', 'firebase-config.json'));
  } else {
    fail('firebase-config.json not found — the offscreen auth document needs it.');
  }

  process.stdout.write(`Copied ${copied} files → dist/extension\n`);
  process.stdout.write('Load it at chrome://extensions → Developer mode → "Load unpacked" → dist/extension\n');
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) count += copyDir(from, to);
    else { fs.copyFileSync(from, to); count++; }
  }
  return count;
}

main();
