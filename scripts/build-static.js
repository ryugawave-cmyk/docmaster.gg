'use strict';

/**
 * Static site build for Cloudflare Workers (assets binding).
 *
 * DocMaster is a GET-only, server-rendered marketing + workspace site whose
 * every page is the same for all visitors (no per-user data, no server AI —
 * all AI runs client-side). So instead of running Express on the Worker, we
 * render each route ONCE here using the real Express app, and ship the HTML as
 * static assets. The Worker (worker/index.js) then serves those assets, adds
 * the security headers, and swaps in a fresh per-request CSP nonce.
 *
 * Big files (the ONNX layout model + large ORT .wasm) exceed Cloudflare's
 * 25 MiB per-asset limit; they are LEFT OUT of dist and listed in
 * dist/../r2-manifest.json so they can be uploaded to R2 instead. The Worker
 * serves /models/* and /wasm/* from R2 when an asset is missing.
 */

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');

// Render with production settings and a fixed nonce placeholder the Worker
// replaces per request. Set BEFORE requiring the app/config.
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.STATIC_BUILD = '1';
// One stamp per build, appended to static asset URLs (?v=…) so a new deploy
// busts the immutable long-cache the Worker sets on CSS/JS/images. Base36 of the
// build time keeps it short. See src/middleware/locals.js + worker/index.js.
process.env.ASSET_VERSION = process.env.ASSET_VERSION || Date.now().toString(36);

const createApp = require('../src/app');
const { getAllTools } = require('../src/data/tools');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PUBLIC = path.join(ROOT, 'public');
const PDFJS = path.join(ROOT, 'node_modules', 'pdfjs-dist');

// Cloudflare static-asset per-file limit is 25 MiB. Anything at or above this
// must be served from R2 instead of the assets binding.
const ASSET_LIMIT = 25 * 1024 * 1024;

/** GET a path from the running app; resolve to { status, contentType, body }. */
function fetchPath(port, urlPath) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: urlPath, headers: { 'accept-encoding': 'identity' } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            contentType: res.headers['content-type'] || '',
            body: Buffer.concat(chunks),
          })
        );
      })
      .on('error', reject);
  });
}

async function writeFile(rel, buf) {
  const dest = path.join(DIST, rel);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(dest, buf);
}

/** Recursively copy a dir into dist, skipping files >= ASSET_LIMIT. */
async function copyDir(srcDir, destRel, oversized) {
  const entries = await fsp.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const rel = path.posix.join(destRel, entry.name);
    if (entry.isDirectory()) {
      await copyDir(src, rel, oversized);
    } else if (entry.isFile()) {
      const { size } = await fsp.stat(src);
      if (size >= ASSET_LIMIT) {
        oversized.push({ path: '/' + rel.replace(/^\.?\/?/, ''), bytes: size, source: path.relative(ROOT, src) });
        continue; // -> R2, not an asset
      }
      await writeFile(rel, await fsp.readFile(src));
    }
  }
}

async function main() {
  // Fresh dist
  await fsp.rm(DIST, { recursive: true, force: true });
  await fsp.mkdir(DIST, { recursive: true });

  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;

  try {
    // ----- HTML routes -> pretty-URL files ---------------------------------
    const pageRoutes = [
      ['/', 'index.html'],
      ['/about', 'about/index.html'],
      ['/pricing', 'pricing/index.html'],
      ['/contact', 'contact/index.html'],
      ['/privacy', 'privacy/index.html'],
      ['/terms', 'terms/index.html'],
      ['/cookies', 'cookies/index.html'],
      ['/security', 'security/index.html'],
      ['/tools', 'tools/index.html'],
      ['/workspace', 'workspace/index.html'],
    ];
    for (const tool of getAllTools()) {
      pageRoutes.push([`/tools/${tool.slug}`, `tools/${tool.slug}/index.html`]);
    }

    for (const [route, out] of pageRoutes) {
      const r = await fetchPath(port, route);
      if (r.status !== 200) throw new Error(`Route ${route} returned ${r.status}`);
      await writeFile(out, r.body);
      console.log(`  rendered ${route}  ->  dist/${out}`);
    }

    // ----- SEO endpoints ----------------------------------------------------
    for (const [route, out] of [['/robots.txt', 'robots.txt'], ['/sitemap.xml', 'sitemap.xml']]) {
      const r = await fetchPath(port, route);
      if (r.status !== 200) throw new Error(`${route} returned ${r.status}`);
      await writeFile(out, r.body);
      console.log(`  rendered ${route}`);
    }

    // ----- 404 page (Cloudflare serves dist/404.html on misses) -------------
    const notFound = await fetchPath(port, '/__definitely_not_a_real_route__');
    await writeFile('404.html', notFound.body);
    console.log('  rendered 404 page');

    // ----- Static assets ----------------------------------------------------
    const oversized = [];
    console.log('  copying public/ ...');
    await copyDir(PUBLIC, '.', oversized);
    console.log('  copying pdfjs-dist -> vendor/pdfjs ...');
    await copyDir(PDFJS, 'vendor/pdfjs', oversized);

    // ----- R2 manifest for oversized files ---------------------------------
    await fsp.writeFile(
      path.join(ROOT, 'r2-manifest.json'),
      JSON.stringify({ limitBytes: ASSET_LIMIT, files: oversized }, null, 2)
    );

    console.log('');
    console.log('Build complete -> dist/');
    if (oversized.length) {
      console.log('');
      console.log(`  ${oversized.length} file(s) exceed the 25 MiB asset limit and were NOT bundled.`);
      console.log('  These are served from the GitHub Release (see worker/index.js RELEASE_BASE).');
      console.log('  Upload them as assets on that Release. r2-manifest.json lists them:');
      for (const f of oversized) {
        console.log(`   - ${f.path}  (${(f.bytes / 1048576).toFixed(1)} MB)  from ${f.source}`);
      }
    }
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
