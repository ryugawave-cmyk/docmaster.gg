# Deploying DocMaster to Cloudflare Workers

DocMaster deploys as a **Cloudflare Worker with a static-assets binding**. The
site is rendered to static HTML at build time; the Worker serves it, injects a
per-request CSP nonce, sets the cross-origin-isolation headers, and serves the
oversized AI files from R2.

> **This project name is `docmaster`.** It is different from the background
> remover (`advanced-bg-remover`), so deploying this can **never** overwrite
> that project. They are separate.

---

## What's already set up (done — no action needed)

- `scripts/build-static.js` — renders every route to `dist/` (`npm run build`).
- `worker/index.js` — the Worker (assets + nonce + headers + R2 + `/api/ai/*` stub).
- `wrangler.jsonc` — Worker config, name `docmaster`, assets binding.
- `package.json` — `build`, `preview` (local), `deploy` scripts.

## What YOU still have to do (needs your Cloudflare/GitHub account)

### 1. Log in to Cloudflare (once)
The saved wrangler token expired. In a normal terminal:
```
wrangler login
```

### 2. Build the site
```
npm run build
```
This creates `dist/` and prints which files are too big for the asset limit
(also written to `r2-manifest.json`).

### 3. Create the R2 bucket for the oversized AI files
Two files exceed Cloudflare's **25 MiB per-asset limit** and cannot ship as
assets — they must go to R2:

- `/models/layout/doclaynet-yolov10m.onnx` (~59 MB)
- `/wasm/ort/ort-wasm-simd-threaded.jsep.wasm` (~26 MB)  ← required for all AI

```
wrangler r2 bucket create docmaster-models

wrangler r2 object put docmaster-models/models/layout/doclaynet-yolov10m.onnx \
  --file public/models/layout/doclaynet-yolov10m.onnx

wrangler r2 object put docmaster-models/wasm/ort/ort-wasm-simd-threaded.jsep.wasm \
  --file public/wasm/ort/ort-wasm-simd-threaded.jsep.wasm
```

Then **uncomment the `r2_buckets` block** at the bottom of `wrangler.jsonc`.

### 4. (Recommended) Connect the GitHub repo for auto-deploy
Same model as the bg-remover: push = deploy.
1. Create a **new, separate** GitHub repo (not `Advanced-bg-remover`), push this project to it.
2. Cloudflare dashboard → **Workers & Pages → Create → Connect to Git** → pick the repo.
3. Build command: `npm run build`. Deploy command: `npx wrangler deploy`.
4. Confirm the project name is **`docmaster`**.

### 5. Deploy — ONLY when you say so
Do NOT deploy until you're ready. Manual deploy from the CLI:
```
npm run deploy
```
Or just `git push` if you connected the repo in step 4.

---

## Future: adding cloud AI (e.g. Claude)
Your current AI (OCR, layout model) runs **in the browser** and needs none of
this. If you later add a *cloud* model:
- Implement it in `worker/index.js` under `/api/ai/*`.
- Store the API key as a Worker **secret**, never in client code:
  ```
  wrangler secret put AI_API_KEY
  ```
- The client calls `/api/ai/...`; the Worker adds the key and calls the provider.

## Local smoke test (no deploy, no account)
```
npm run build
npm run preview   # wrangler dev — serves the Worker + dist locally
```
Note: `wrangler dev` won't have the R2 files unless you add them locally, so the
in-browser AI won't load models in local preview — that's expected.
