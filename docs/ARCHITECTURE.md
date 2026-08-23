# DocMaster — Client-First Architecture

> **North star:** DocMaster is architected like Photopea. The browser tab *is* the
> application. The Node server serves static bytes with the right headers and does
> nothing else. Every document lives in tab memory; every transform (render, OCR,
> image ops, export encoding) runs in a Web Worker on a WebGPU-or-WASM backend.
> **No document content ever leaves the tab.**

## Non-negotiable constraints

- **No cloud AI. No Anthropic / OpenAI / Gemini API. No API keys.**
- Processing is client-side; the server is a dumb static host (+ `/health`).
- PDF.js for render/parse · WebAssembly for hot paths · ONNX Runtime Web for models
  (incl. OCR) · **WebGPU primary, WASM fallback** · Web Workers · documents in
  browser memory (OPFS spill, Cache Storage for models).

---

## 1. System overview

```
NODE / EXPRESS  — dumb static host (no compute, no document data)
  • serves app JS, .wasm, .onnx models, pdf.js, self-hosted fonts
  • COOP/COEP (cross-origin isolation), CORP, wasm/onnx MIME, range + long cache
  • /health only.  NO /api/ai.  NO keys.
        │ static fetch (models cached in Cache Storage / OPFS)
MAIN THREAD  — UI + orchestration ONLY (never blocks on compute)
  • view layer (public/js/app/…) + keyboard manager (app/core/keyboard.js)
  • canonical DocumentModel (in-memory) + Command/undo stack
  • compositor surface (WebGPU canvas / 2D fallback)
  • dispatches TASKS to the worker pool; applies results to the model
        │ postMessage + Transferables (ArrayBuffer / ImageBitmap / OffscreenCanvas)
WORKER POOL  (hardwareConcurrency-sized)
  pdf.worker (PDF.js) · ocr.worker (ORT Web) · imaging.worker (WASM/WebGPU) · export.worker (zip/OOXML)
        └── COMPUTE BACKEND: WebGPU (primary) ── WASM+SIMD (fallback)
STORAGE  heap (active doc) → OPFS (spill/large) → Cache Storage (models/wasm)
```

## 2. Requirement → mechanism

| Requirement | Mechanism |
|---|---|
| PDF.js render/parse | Vendored `/vendor/pdfjs`; runs in its own module worker → `pdf.worker` role |
| WebAssembly hot paths | DEFLATE (fflate/wasm), image resample/convolve/color kernels, OCR pre/post |
| ONNX Runtime Web | `ocr.worker` hosts ORT sessions (also bg-removal / super-res / table-structure) |
| WebGPU primary | ORT `executionProviders:['webgpu','wasm']`; WGSL compute for compositing/filters |
| WASM fallback | 2nd ORT EP; JS/WASM kernels when no `navigator.gpu`; single-thread WASM when not isolated |
| Web Workers | Typed task-scheduler pool; nothing heavy on main thread |
| Docs in memory | Canonical `DocumentModel` in heap; OPFS spill; zero server persistence |
| Minimize server | Static host only |
| No cloud AI / keys | Phase 0 removed the cloud path; server has no compute routes |

## 3. Server (small but load-bearing) — `src/app.js`, `src/config/index.js`

1. **Cross-origin isolation** (required for WASM threads / SharedArrayBuffer):
   `crossOriginOpenerPolicy: same-origin`, `crossOriginEmbedderPolicy: credentialless`.
   Client gates threads on `self.crossOriginIsolated` (else `ort.env.wasm.numThreads = 1`).
   **Caveat:** COEP breaks cross-origin subresources → **self-host the Google Fonts**
   (currently `fonts.googleapis.com` / `fonts.gstatic.com` in the CSP) or they fail.
2. **MIME + headers** on `/models` and `/wasm`: `application/wasm`, `application/octet-stream`
   for `.onnx`, `Cross-Origin-Resource-Policy: same-origin`, `Accept-Ranges: bytes`, immutable long cache.
3. **CSP**: keep `'wasm-unsafe-eval'`; `worker-src 'self' blob:`; `connect-src 'self'`;
   `img-src 'self' data: blob:`. No external origins.

## 4. Canonical DocumentModel (`public/js/app/core/document/`)

Unify today's three shapes (import descriptors `pdfImport.js`, editor objects
`blankPdfEditor.js`, `engine.getExportModel()`) into one mutable in-memory model
the editor writes and every exporter reads.

```
DocumentModel
 ├─ meta { title, created, id }
 ├─ pages: Page[]
 │   ├─ size { w, h }
 │   ├─ raster?: ImageBitmap        // imported PDF backdrop (lazy, OPFS-spillable)
 │   └─ layers: Node[]              // z-ordered
 │        ├─ TextNode  { runs[], box, style, source:'pdf'|'ocr'|'user' }
 │        ├─ ImageNode { bitmapRef, box, transform, filters[] }
 │        ├─ TableNode { rows[][cells], borders, box }
 │        └─ ShapeNode { path, stroke, fill }
 ├─ history: CommandStack           // every edit is a Command (do/undo)
 └─ assets: BlobStore               // dedup bitmaps/fonts; heap→OPFS spill
```

- Every mutation is a `Command` → uniform undo/redo, dispatched by `app/core/keyboard.js`.
- Project save `.dmz` = a DEFLATE ZIP of `document.json` + binary assets (File System
  Access API / download). Crash recovery + large docs → **OPFS**, never the server.
- Exporters (`docx.js`, `xlsx.js`, `pptx.js`, `pdfExport.js`) refactor to read
  `DocumentModel` directly — this is what makes edit → export faithful.

## 5. Worker & scheduling — `public/js/app/core/workers/`

- `pool.js` — spawns `min(hardwareConcurrency, N)` generic workers + dedicated `pdf`/`ocr`; round-robins; tracks in-flight.
- `protocol.js` — typed `{ id, kind, payload, transfer[] }`; kinds `RENDER_PAGE`, `OCR_PAGE`, `IMAGE_FILTER`, `BUILD_DOCX`…; promise-per-id on main.
- **Transferables everywhere** — `ArrayBuffer`, `ImageBitmap`, `OffscreenCanvas` (zero-copy). Never clone big pixel arrays.
- Hand-rolled or a thin comlink-style wrapper (stay dependency-light, matching repo style).

## 6. Compute backend — `public/js/app/core/gpu/`

- `backend.js` — detects `navigator.gpu` → `WebGPUBackend` (WGSL compute) | `WasmBackend` (SIMD) | `Canvas2DBackend`. One kernel interface: `resize`, `colorMatrix`, `convolve`, `composite`, `threshold`.
- **ORT bootstrap** (in workers):
  ```js
  ort.env.wasm.wasmPaths = '/wasm/ort/';
  ort.env.wasm.simd = true;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? navigator.hardwareConcurrency : 1;
  const session = await ort.InferenceSession.create(url, { executionProviders: ['webgpu', 'wasm'] });
  ```
- Capability-graceful: no WebGPU → WASM; not isolated → single-thread WASM. Nothing crashes; it just slows down.

## 7. Rendering / compositing

1. `pdf.worker` renders page → `OffscreenCanvas` → `transferToImageBitmap()` → main.
2. Compositor draws raster → images → shapes → tables → text into the WebGPU (or 2D) surface.
3. Pan/zoom/filters as GPU passes; tiling for high zoom / huge pages.
4. Selection/handles on a separate top canvas (no re-raster on hover) — generalizes the
   current dormant-imported-text approach.

## 8. Editing subsystems

| Feature | Implementation |
|---|---|
| Text | Extend `blankPdfEditor` text editing onto `TextNode`; PDF text via `getTextContent()`; font substitution; box-level CSS styling (already inherited) |
| Images | `ImageNode` + non-destructive `filters[]` (crop/rotate/brightness/curves) as GPU passes; optional ONNX bg-removal (RMBG/U²-Net) + super-res in `imaging.worker` |
| Tables | `TableNode` (editable cells/spans/borders); default detector = geometry `reconstruct.js`; optional ONNX table-structure model (PP-Structure / Table-Transformer) as upgrade; exports to real `w:tbl` / sheet rows |
| Pages | reorder/insert/delete/rotate/duplicate as Commands on `pages[]`; drag-reorder thumbnail strip |

## 9. OCR (client-side, ORT + WebGPU) — `public/js/app/services/ocr/`

`ocr.worker` pipeline (replaces the "scanned → OCR toast" dead-ends):

1. **Detect** — DBNet ONNX → text-region boxes.
2. **Classify** angle (optional 180° cls model).
3. **Recognize** — SVTR/CRNN ONNX per crop → CTC decode against a char dictionary.
4. **Assemble** → `TextNode`s with positions, overlaid on the raster (like imported text) → editable + exportable.

- Models: **PaddleOCR PP-OCRv4/v5** det+rec exported to ONNX (few MB each, WebGPU-capable, Apache-2.0). Pre/post in WASM/WebGPU.
- Served as static assets (`public/models/ocr/…`), lazy-loaded, cached in Cache Storage. Ship dicts per language.
- (Tesseract.js/WASM is an optional secondary engine; ORT+Paddle is primary.)

## 10. Export (reuse + move to worker) — `public/js/app/services/convert/`

- Keep the hand-rolled OOXML (`zip.js, model.js, docx.js, xlsx.js, pptx.js, html.js, reconstruct.js`) and `editor/pdfExport.js`.
- Changes: (a) drive from `DocumentModel` not `getExportModel()`; (b) run build + zip in `export.worker`; (c) upgrade `zip.js` STORED → **DEFLATE** (fflate ~8 KB or wasm-zlib).
- Result: PDF / DOCX / XLSX / PPTX generated in-tab from the same edited model. `exportPanel.js` UI stays.

## 11. Proposed module layout (delta)

```
public/js/app/
  core/
    document/   NEW  DocumentModel, Command stack, serialize, OPFS store
    workers/    NEW  pool.js, protocol.js, {pdf,ocr,imaging,export}.worker.js
    gpu/        NEW  backend.js (WebGPU/WASM/Canvas2D), wgsl kernels
    keyboard.js      existing (dispatches Commands)
  editor/            existing; operates on DocumentModel
  services/
    convert/         existing OOXML; read DocumentModel; +DEFLATE
    ocr/        NEW  detect/recognize/decode glue over ort
public/
  models/{ocr,imaging}/*.onnx   NEW static assets
  wasm/{ort,fflate,kernels}/*   NEW static assets
  fonts/                        NEW self-hosted (COEP)
src/                            app.js/config header edits; NO compute routes
```

## 12. Phased plan

- **Phase 0 — De-cloud.** ✅ Done. Removed `routes/ai.js`, `/api/ai` mount, `ai` config,
  `aiConvert.js`, the `ai` Word mode + `WORD_MODES` entry + `docx.js` `aiBody`, and the
  `ANTHROPIC_*` env. Existing offline Word modes untouched. Server restarted.
- **Phase 1 — Host & isolation.** ✅ Done. Self-hosted all 9 workspace + 2 marketing font families (`public/fonts/`, `public/css/fonts.css`, latin+latin-ext) and removed the Google CDN from both templates + CSP. Enabled `COOP: same-origin` + `COEP: credentialless` in helmet (`src/app.js`); added `/models` + `/wasm` static mounts (onnx/wasm MIME, immutable cache, range requests). Added `core/capabilities.js` (WebGPU / WASM-SIMD / threads / isolation / OPFS probe) wired into `app/index.js` as the boot smoke test. Verified: workspace serves COOP/COEP/CORP, `fonts.css` has zero google refs, woff2 served `font/woff2`, no cross-origin subresources remain.
- **Phase 2 — Worker infra + backend.** ✅ Done. `core/workers/protocol.js` (id-routed request/response + `withTransfer`), `core/workers/pool.js` (least-busy dispatch), `core/gpu/backend.js` (WebGPU grayscale WGSL kernel + CPU fallback + `pickBackendName`), `core/onnx/ort.js` (EP `['webgpu','wasm']`, threads from caps, lazy load — ORT binary vendored in Phase 6), `core/workers/imaging.worker.js` (reference worker). Node-tested: 12/12 (protocol resolve/reject, pool load-balancing, backend selection + CPU luma). WebGPU kernel + ORT are browser/Phase-6-runtime (parse-clean).
- **Phase 3 — DocumentModel + undo + OPFS.** ⚙ Core + persistence done & Node-tested (20/20 model + 14/14 zip/project): `core/document/document.js` (pages/nodes, Command stack undo/redo incl. restoring absent keys, serialize round-trip), `core/document/opfs.js` (guarded), `core/document/assets.js` (refcount + hash dedup + explicit-id restore), `core/document/project.js` (`.dmz` pack/unpack: document.json + manifest + assets, restores assets under original ids). ✅ **Phase 3 core complete (browser-confirmed for edits; Node-proven for structure).** `blankPdfEditor.js` instantiates a `DocumentModel` that is now the single source of truth for **history + complete structure**, and can reconstruct the editor and drive exports:
1. **History** — whole-document undo/redo + page ops delegate to `doc.history` (`useSnapshotSource`/`recordSnapshot`; editor `past`/`future` removed). Node 16/16.
2. **Structure mirror** — `getDocumentModel()` syncs the live editor (incl. embedded page `images`, after `commitActiveEdit`) into `doc.pages` via `documentSync.editorSnapshotToPages` → `doc.setStructure` (non-undoable). Node 11/11.
3. **Reconstruction** — `documentSync.pagesToEditorSnapshot` (inverse) + editor `loadFromModel(model)` rebuild the editor from the model. Round-trip forward∘inverse is property-identical incl. images/signature/stamp/draw. Node 13/13.
4. **Export equivalence** — `documentSync.exportModelFromDoc(doc)` is **proven byte-identical** to the legacy `getExportModel()` across all object types. Node 3/3.

**Exports now flow THROUGH the model:** `getExportModel()` = `exportModelFromDoc(syncDoc())` and `getDocumentModel()` = `syncDoc()` (one shared `syncDoc()` commits edits + mirrors live pages into `doc`). Proven byte-identical to the prior direct build (Node 3/3); awaiting the user's in-browser export pass. So DocumentModel is the single source of truth that **drives history, structure, reconstruction, and exports**.

✅ **Save/Open Project (`.dmz`) wired** (browser-test pending): File menu → `bus.emit('action','save-project'|'open-project')` → `doAction` default → `pdfWorkspace.handleAction` → `blankEditorShell.saveProject()/openProject()` → `packProject(getDocumentModel(), null)` / `unpackProject` → `engine.loadFromModel()`. A `.dmz` is a DEFLATE zip of the serialized DocumentModel (pages + layer objects + raster/image data URLs inline; no asset store needed), all client-side. Node-tested 5/5: save→load round-trips the whole document byte-for-byte (all object types + images). **Remaining:** (c) move mutations to the per-node command API; OPFS autosave; export path already through the model.
- **Phase 4 — Render/compositor.** `pdf.worker` → ImageBitmap; WebGPU compositor + 2D fallback; drag-reorder thumbnails. Verify pan/zoom perf + reorder.
- **Phase 5 — Editing.** text/image/table/pages as Commands; image filters as GPU passes; `TableNode` → real `w:tbl`/sheet. Verify each edit survives export.
- **Phase 6 — OCR.** `ocr.worker` det→cls→rec→CTC, PaddleOCR-ONNX assets, WebGPU + WASM fallback → editable `TextNode`s. Verify on a scanned PDF.
- **Phase 7 — Export hardening.** ⚙ DEFLATE archive done & Node-tested (14/14, incl. zlib interop): `core/zip/archive.js` (`zipAsync` native `CompressionStream('deflate-raw')` with per-entry STORED fallback + `unzip` reader). **Remaining:** move the OOXML builders into `export.worker` and switch them from `services/zip.js` (STORED) onto `zipAsync` (touches the working exporters → do with browser verification); large-doc streaming.
- **Phase 8 — Polish.** model lazy-load + Cache Storage, memory ceilings, progress UX, degradation banners (no-WebGPU / not-isolated).

## 13. Risks

- **COEP breaks 3rd-party fonts** → self-host (Phase 1). Required for WASM threads.
- **WebGPU coverage** (older Safari/Firefox) → WASM fallback is mandatory; everything must run GPU-off / isolation-off, just slower.
- **Model size/licensing** → PaddleOCR Apache-2.0; ship only what you serve; lazy-load.
- **Memory** → big multi-page rasters spill to OPFS; `ImageBitmap.close()`; else a large PDF OOMs the tab.
