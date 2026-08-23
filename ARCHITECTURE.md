# DocMaster — Unified Workspace Architecture

DocMaster is a **single-page application shell** that hosts multiple, fully
independent **workspaces**. Two are first-class — **PDF** and **Document** — plus
a lightweight **Home** hub. They share one chrome (navigation, toolbar, contextual
properties panel, status bar) but share **no editing logic**: PDF and Document
code never import each other.

This document describes the architecture that has been scaffolded. The concrete
editing features are built in later phases (**PDF workspace first, then the
Document workspace**); the seams for them are already in place and marked
`NEXT PHASE` in the code.

---

## 1. The big picture

```
                          ┌────────────────────────────────────────────┐
                          │                 SHELL                       │
                          │  nav · toolbar · properties panel · status  │
                          └───────────────┬────────────────────────────┘
                                          │  bus + store (the only channel)
        ┌─────────────────────────────────┼─────────────────────────────────┐
        │                                 │                                 │
 ┌──────▼──────┐                  ┌───────▼───────┐                 ┌───────▼───────┐
 │  Home hub    │                  │ PDF workspace │                 │ Doc workspace │
 │  workspace   │                  │  (renderer +  │                 │  (renderer +  │
 │              │                  │   engine +    │                 │   engine +    │
 │              │                  │   tools)      │                 │   tools)      │
 └──────────────┘                  └───────────────┘                 └───────────────┘
```

The shell never references a concrete workspace. Everything flows through two
shared primitives:

- **`eventBus`** — synchronous pub/sub. The one channel between shell ⇄ workspaces.
- **`appStore`** — an observable store of *shell-level* state only (active
  workspace, doc name, zoom, page counts, selection, recent list). Per-workspace
  document state lives inside each workspace and never leaks here.

---

## 2. Separation of concerns (as required)

| Concern | Where it lives | Notes |
| --- | --- | --- |
| **Workspace management** | `app/core/workspaceRegistry.js`, `app/core/workspaceManager.js` | Register + switch/mount/hide workspaces. Switching never reloads. |
| **Rendering** | inside each workspace (`workspaces/*/`) | The PDF renderer (PDF.js) and the Document renderer are separate; neither is in the shell. |
| **Editing engine** | `public/js/workspace/engine/` (reusable) | The existing object-model / command-stack / incremental renderer. A workspace mounts it; the shell doesn't know it exists. |
| **Tool system** | `app/core/*` + each workspace's `getTools()` / `handleAction()` | Tools are per-workspace; the toolbar adapts to the active one. |
| **Properties panel** | `app/shell/propertiesPanel.js` + `app/core/propertyRegistry.js` + `app/properties/` | **Selection-driven**, not tool-driven. |
| **File management** | `app/services/fileManager.js` | Picker, drag-drop, MIME routing, recent list. Workspaces receive a `File`. |
| **Export system** | `app/services/exportManager.js` | Dispatches to the active workspace's `export()`; owns download + progress. |

---

## 3. The workspace contract

Every center surface implements one interface (documented in
`app/workspaces/workspaceContract.js`). The shell only knows this shape:

```
createXWorkspace({ bus, store, services }) => {
  id, label, icon,
  accepts(file),                 // routing: can it open this file?
  mount(container),              // build DOM once (lazy)
  activate() / deactivate(),     // show / hide — STATE IS PRESERVED
  onActivate(payload),           // per-activation intent (e.g. { intent:'new' })
  getToolbar(),                  // workspace-specific toolbar group(s)
  getTools(),                    // optional in-center tools
  handleAction(action, payload), // toolbar/nav actions
  open(file), export(options),   // file + export system hooks
  getSelection(),                // current SelectionDescriptor
}
```

A workspace talks *outward* only via `store.setState(...)` and `bus.emit(...)`.
That is what keeps PDF and Document logic decoupled.

### Switching without reloading

`workspaceManager` mounts each workspace once into its own hidden `<div>` layer
inside the center stage and then just toggles `hidden`. Scroll position, zoom,
open document and selection all survive a switch because the DOM and JS state are
never torn down.

---

## 4. The contextual properties panel

The right sidebar is **selection-driven**. A workspace emits a
`SelectionDescriptor` (`app/core/selection.js`) on `selection:change`:

```
{ kind: 'text' | 'image' | 'page' | 'none' | <custom>, label, target, values }
```

The panel resolves a **provider** from the property registry by `kind` and
renders its declarative schema:

| Selection | Provider | Panel |
| --- | --- | --- |
| Text | `app/properties` → text | Typography |
| Image | image | Image controls |
| PDF/Doc page | page | Page controls |
| *(nothing)* | none | **Document properties** (fallback) |

Providers are workspace-agnostic — the same typography panel serves a PDF text
run and a Document text block. New selection kinds just register a new provider.

---

## 5. The shared toolbar

There is exactly one toolbar (`app/shell/toolbar.js`). It has fixed chrome (home,
doc name, undo/redo, zoom, save, export, panel toggle) plus a **middle region**
filled by the active workspace's `getToolbar()`. On `workspace:change` (or a
workspace's `toolbar:refresh`) that region is rebuilt — the bar "adapts" without
the shell knowing anything workspace-specific.

---

## 6. Navigation

`app/config/navigation.js` is the single source of truth for the left rail:

```
Home · Recent · Projects
PDF        → Open PDF · Edit PDF · Merge · Split · Compress · OCR
Documents  → New Document · Open Document · Templates
```

Each item is declarative (`{ command, arg }`). The **command router** in
`app/index.js` is the one place intents become effects (switch workspace, open a
file dialog, select a tool). Adding a nav entry never touches component code.

### Event catalogue

| Event | Emitted by | Consumed by |
| --- | --- | --- |
| `nav:command` | nav rail, hub cards | command router |
| `workspace:change` | workspace manager | toolbar, (any listener) |
| `toolbar:refresh` | a workspace | toolbar |
| `selection:change` | a workspace | properties panel |
| `property:change` | properties panel | (workspaces, later) |
| `file:dropped` | workspaces (drop zones) | command router |
| `recent:change` | file manager | hub |
| `export:done` | export manager | (any listener) |
| `toast` | anywhere | toast center |

---

## 7. Directory map

```
public/js/app/
├── index.js                  # entry: assemble shell + register workspaces + command router
├── config/navigation.js      # left-rail definition
├── model/                    # the Unified Document Model (editing engine's truth)
│   ├── documentModel.js       #   types + factories (blocks / runs / marks)
│   ├── editableHtml.js        #   model ⇄ contentEditable DOM (round-trip)
│   └── pdfImporter.js         #   PDF.js → Document Model (extraction only)
├── editor/
│   ├── pdfEditor.js           #   PDF Edit Mode — in-place, layout-preserving
│   ├── layoutEngine.js        #   measured bounding boxes + overflow (condense/wrap/push) + collisions
│   └── documentEditor.js      #   Document Mode — Google-Docs-style flowing editor
├── core/
│   ├── eventBus.js           # pub/sub
│   ├── appStore.js           # shell-level observable state
│   ├── selection.js          # SelectionDescriptor contract
│   ├── propertyRegistry.js   # kind → property provider
│   ├── workspaceRegistry.js  # id → workspace
│   └── workspaceManager.js   # mount / switch (no reload)
├── services/
│   ├── fileManager.js        # picker, drag-drop, recent, MIME routing
│   └── exportManager.js      # dispatch export → download
├── properties/index.js       # built-in providers: text / image / page / document
├── shell/
│   ├── navSidebar.js         # left rail
│   ├── toolbar.js            # shared adaptive toolbar
│   ├── propertiesPanel.js    # selection-driven right panel
│   ├── controls.js           # declarative control renderer (shared)
│   ├── statusBar.js
│   └── toast.js
└── workspaces/
    ├── workspaceContract.js   # the interface + dev-time assert
    ├── home/homeWorkspace.js  # Home / Recent / Projects hub
    ├── pdf/                    # PDF workspace — REAL PDF.js viewer
    │   ├── pdfWorkspace.js     #   contract impl + local store + shell mirroring
    │   ├── viewerCanvas.js     #   page-stack layout, zoom/pan/scroll, selection
    │   └── thumbnailRail.js    #   lazy virtualized page navigator
    └── document/documentWorkspace.js  # Document (scaffold)

public/js/workspace/           # REUSED as a library by the workspaces:
├── engine/                    #   the editing engine (object model, commands, renderer)
├── pdf/                       #   PDF.js integration (viewer + loader)
└── {core,ui,tools,utils}      #   store impl, icons, dom/format helpers
```

The `public/js/workspace/` tree from the previous single-workspace app is
**retained as a library** — its engine and PDF.js viewer are what the PDF
workspace mounts in the next phase. The shell simply no longer boots it directly.

---

## 8. What's built vs. what's next

**Phase 1 — architecture + navigation (done)**
- Shared shell: nav rail, adaptive toolbar, selection-driven properties, status bar.
- Workspace manager/registry/contract; switching with no reload.
- File-management and export service seams.

**Phase 2 — PDF workspace (done)**
- Real, virtualized PDF.js viewer mounted into the shell (`workspaces/pdf/`):
  multi-page rendering, high-DPI raster, selectable text layer, lazy thumbnails.
- A **workspace-local store** isolates viewer state; zoom/pan/scroll survive
  workspace switches (the layer is hidden, never unmounted).
- Page click → `page` selection → page-properties panel; empty → document props.
- Zoom / fit-width / fit-page / rotate / thumbnails wired through `handleAction`
  and the shared toolbar chrome. No editing tools yet (by design).
- Verified end-to-end in a headless browser (render, virtualization, selection,
  state preservation).

**Phase 3 — true document editing (in progress)**
Two distinct editing modes, both reached from the PDF workspace's **Edit** button
(a `[PDF Edit | Document]` toggle switches between them live):

- **📄 PDF Edit Mode (default) — `editor/pdfEditor.js` + `editor/layoutEngine.js`.**
  *Layout-preserving, in-place* editing (Acrobat/PDFgear style). The page is
  rendered exactly as the PDF; each PDF text object gets its own
  **absolutely-positioned, contentEditable box at the same x/y**, transparent
  until focused (so the page is pixel-identical until you change a word). A
  **collision-aware layout engine** gives every run a *measured bounding box*
  (real font metrics) and the whitespace to its right, then resolves overflow so
  a longer edit can **never overlap** a neighbour. Two modes:
  - **Preserve Layout (default)** — the page stays as the original; text that fits
    expands into the available whitespace, longer text is condensed horizontally
    to fit, and past a floor it is clipped/ellipsised with a warning
    (*"The edited text is longer than the available space."*).
  - **Smart Reflow (opt-in)** — an overflowing run wraps onto extra lines and the
    engine pushes the objects below it straight down, keeping the page clean and
    overlap-free.

  Layout is recomputed after every edit; a final AABB collision pass over
  text/image/table boxes flags any residual overlap. Best for forms, resumes,
  certificates, official docs. Snapshot Undo/Redo, zoom, per-object formatting.
- **📝 Document Mode — `editor/documentEditor.js`.** *Flowing*, Google-Docs-style
  editor over the Unified Document Model (`model/` + `pdfImporter.js`): reflow,
  Enter/Backspace paragraphs, headings, live formatting. For rewriting/reorganizing.

PDF.js is only an extractor in both modes; editing happens on our own layer/model.

- **Next increments:** images (drag/resize) + tables in each mode; DOCX import
  into the same Document Model; Save/Export regenerating **PDF** and **DOCX**.
```
