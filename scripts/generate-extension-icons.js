'use strict';

// Generates the Chrome extension icon set from the current brand logo.
// Source (in priority order): build/patchesnewlogo.png (official sage-green
// logo) → build/patcheslogorounded.png (legacy) → fallback "P" SVG.
// Output: extension/icons/icon{16,32,48,128}.png

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const NEW_LOGO = path.join(root, 'build', 'patchesnewlogo.png');
const LEGACY_LOGO = path.join(root, 'build', 'patcheslogorounded.png');
const fallbackSvg = `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" rx="112" fill="#608463"/>
  <text x="50%" y="52%" text-anchor="middle" dominant-baseline="middle" fill="#ffffff"
    font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="300">P</text>
</svg>`.trim();

const outDir = path.join(root, 'extension', 'icons');
const SIZES = [16, 32, 48, 128];

async function main() {
  fs.mkdirSync(outDir, { recursive: true });

  let png;
  if (fs.existsSync(NEW_LOGO)) {
    // contain-fit onto a square canvas preserves the source aspect ratio and
    // (existing) artwork exactly — no stretch, no recolour.
    png = await sharp(NEW_LOGO)
      .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    process.stdout.write('Using source logo: build/patchesnewlogo.png\n');
  } else if (fs.existsSync(LEGACY_LOGO)) {
    png = await sharp(LEGACY_LOGO)
      .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    process.stdout.write('build/patchesnewlogo.png not found; using legacy build/patcheslogorounded.png\n');
  } else {
    png = await sharp(Buffer.from(fallbackSvg)).png().toBuffer();
    process.stdout.write('No source logo found; using fallback "P" icon.\n');
  }

  for (const size of SIZES) {
    await sharp(png).resize(size, size).png().toFile(path.join(outDir, `icon${size}.png`));
  }
  process.stdout.write(`Generated ${SIZES.map((s) => `icon${s}.png`).join(', ')} in extension/icons/\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
