#!/usr/bin/env node
/**
 * Vendor the on-device OCR engine (Tesseract.js v5) into public/vendor/tesseract/.
 *
 * OCR powers "Make editable" and the PDF→Doc transfer's recovery of text baked into
 * images/banners/diagrams. The engine is SELF-HOSTED (never a CDN) to satisfy the
 * app's strict CSP and cross-origin isolation — see core/ai/ocrTesseract.js.
 *
 * The downloaded binaries are large (~18 MB) and git-ignored; run this once after
 * cloning (or in CI/build) to enable OCR:  `npm run vendor:ocr`
 *
 * Pins matched tesseract.js + core versions so the engine, worker and WASM core
 * agree. Bump TESS / CORE together when upgrading.
 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TESS = '5.1.1';      // tesseract.js (engine + worker)
const CORE = '5.1.1';      // tesseract.js-core (WASM core)
const DATA = '4.0.0';      // tessdata release for the language files

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'public', 'vendor', 'tesseract');

const FILES = [
  { url: `https://cdn.jsdelivr.net/npm/tesseract.js@${TESS}/dist/tesseract.esm.min.js`, name: 'tesseract.esm.min.js' },
  { url: `https://cdn.jsdelivr.net/npm/tesseract.js@${TESS}/dist/worker.min.js`, name: 'worker.min.js' },
  { url: `https://cdn.jsdelivr.net/npm/tesseract.js-core@${CORE}/tesseract-core-simd-lstm.wasm.js`, name: 'tesseract-core-simd-lstm.wasm.js' },
  { url: `https://cdn.jsdelivr.net/npm/tesseract.js-core@${CORE}/tesseract-core-simd-lstm.wasm`, name: 'tesseract-core-simd-lstm.wasm' },
  { url: `https://tessdata.projectnaptha.com/${DATA}/eng.traineddata.gz`, name: 'eng.traineddata.gz' },
];

async function download({ url, name }) {
  const out = join(dest, name);
  try { if ((await stat(out)).size > 0) { console.log(`  ✓ ${name} (already present)`); return; } } catch { /* not there yet */ }
  process.stdout.write(`  ↓ ${name} … `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(out, buf);
  console.log(`${(buf.length / 1024 / 1024).toFixed(1)} MB`);
}

async function main() {
  await mkdir(dest, { recursive: true });
  console.log(`Vendoring Tesseract OCR → ${dest}`);
  for (const f of FILES) await download(f);
  console.log('Done. OCR is now enabled (restart the dev server if it was running).');
}

main().catch((e) => { console.error('\nvendor-ocr failed:', e.message); process.exit(1); });
