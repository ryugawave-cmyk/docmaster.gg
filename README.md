# DocMaster

> Every document tool you need — in one place.

DocMaster is a modern, production-ready SaaS foundation for an all-in-one PDF &
document platform, built with **Node.js, Express, EJS, HTML5, CSS3 and vanilla
JavaScript**.

DocMaster is a **desktop-style document editor**: instead of a separate page per
tool, every feature lives inside one reusable **Document Workspace**
(`/workspace`). The marketing site funnels users into the editor:

```
Home → Open / Upload → Document Workspace → edit with any tool → Export
```

It is built on a real **document engine** (object model, layered incremental
rendering, undo/redo, selection, hit testing, plugins) with **PDF rendering via
Mozilla PDF.js** already in place. The remaining editing/processing tools plug
into that foundation and are still being filled in.

> **🧭 New architecture.** DocMaster is being evolved into a **unified PDF &
> Document workspace**: one application shell (left navigation, shared adaptive
> toolbar, selection-driven properties panel, status bar) hosting two decoupled
> workspaces — **PDF** and **Document** — that switch without reloading. The new
> shell lives under `public/js/app/`; the engine and PDF.js viewer under
> `public/js/workspace/` are reused as a library. See
> **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the full design. The shared shell
> and the **PDF workspace** (a virtualized PDF.js viewer — multi-page, high-DPI,
> selectable text, lazy thumbnails, page-selection → properties) are complete;
> the Document workspace is next. Editing tools come after, one at a time.

---

## ✨ Features

- **Single Document Workspace** — one editor shell hosts every tool; switching
  tools never navigates away.
- **Pluggable tool architecture** — a tool is a data definition registered in a
  registry; it then appears in the sidebar, gets a cursor/shortcut and renders
  its own properties panel with zero UI changes.
- **Client state management** — an observable store + command-based undo/redo
  history that every future editing feature plugs into.
- **Modular architecture** — config, routes, controllers, middleware and data
  cleanly separated on the server; ES modules on the client.
- **EJS layouts & partials** — reusable `head`, `header`, `footer`, `brand`,
  `icon` and `tool-card` components; a dedicated minimal workspace layout.
- **Premium, responsive UI** — modern landing page plus a full editor chrome
  (toolbar, sidebar, canvas, properties panel, status bar).
- **SEO-friendly** — per-page meta, Open Graph/Twitter, JSON-LD, canonical URLs,
  dynamic `robots.txt` / `sitemap.xml` (the workspace is `noindex`).
- **Security & performance** — Helmet + nonce-based CSP, gzip, HTTP logging.

---

## 🧰 Tools (all inside the workspace)

Select · Hand · Text · Image · Shapes · Draw · Highlight · Eraser · Comments ·
Signature · Merge · Split · Compress · Rotate · Delete / Reorder / Extract Pages ·
Watermark · Protect · OCR · AI Tools

Each is registered as a tool definition and shows its properties panel. **PDF
viewing is fully implemented** — real pages are decoded and rendered with
Mozilla PDF.js (virtualized, high-DPI, with a selectable text layer); the
editing/processing tools build on the document engine and are still being filled
in. Legacy `/tools/:slug` URLs redirect into the workspace with the matching
tool preselected (`/workspace?tool=<id>`).

---

## 📁 Project structure

```
DocMaster/
├── public/
│   ├── css/
│   │   ├── style.css              # Marketing site stylesheet
│   │   └── workspace.css          # Document Workspace (editor) stylesheet
│   ├── js/
│   │   ├── main.js                # Marketing progressive enhancement
│   │   └── workspace/             # The editor app (ES modules)
│   │       ├── index.js           #   entry: bootstraps + wires everything
│   │       ├── icons.js           #   inline SVG icon set
│   │       ├── core/              #   store, history, toolRegistry, documentModel
│   │       ├── engine/            #   the document engine (see engine/README.md)
│   │       ├── pdf/               #   PDF.js integration (viewer + loader)
│   │       ├── tools/             #   tool definitions (navigate/annotate/pages/document)
│   │       ├── ui/                #   sidebar, toolbar, canvas, propertiesPanel, statusBar
│   │       └── utils/             #   dom + format helpers
│   └── favicon.svg
├── src/
│   ├── config/                    # Env-driven configuration + navigation
│   ├── controllers/               # page, tool (redirect), workspace controllers
│   ├── data/                      # Tool catalog (single source of truth)
│   ├── middleware/                # nonce, locals, notFound, errorHandler
│   ├── routes/                    # seo, pages, tools, workspace, index
│   ├── app.js                     # Express app assembly
│   └── server.js                  # Entry point
├── views/
│   ├── layouts/                   # main.ejs (marketing) + workspace.ejs (editor)
│   ├── partials/                  # head, header, footer, brand, icon, tool-card
│   ├── pages/                     # home, tools, about, pricing, contact
│   ├── workspace/index.ejs        # Editor shell markup
│   └── errors/                    # 404, 500
├── .env.example
├── .gitignore
└── package.json
```

> `robots.txt` and `sitemap.xml` are generated dynamically (see
> `src/routes/seo.js`) from configuration, so they stay correct in every
> environment.

---

## 🎛️ Document Workspace architecture

The editor is a small, dependency-free client app under
`public/js/workspace/`, built around three ideas:

1. **A single observable store** (`core/store.js`) holds all state — the open
   document, active tool, zoom, current page, per-tool settings and undo/redo
   flags. UI components subscribe and update only what they own.
2. **A tool registry** (`core/toolRegistry.js`) is the extension point. Each tool
   is a plain definition (`id`, `label`, `group`, `icon`, `cursor`, `shortcut`
   and a declarative `properties` schema). Registering it makes it appear in the
   sidebar, respond to its shortcut, set its cursor and render its properties
   panel — **with no other code changes**.
3. **Command-based history** (`core/history.js`) gives every future editing
   feature reversible actions via a shared `execute / undo / redo` API.

UI is split into independent components (`ui/sidebar`, `ui/toolbar`,
`ui/canvas`, `ui/propertiesPanel`, `ui/statusBar`) that render purely from the
store. The canvas abstracts page rendering (`drawPage`) so a real PDF engine can
be dropped in later without touching interaction, zoom or panning code.

### The document engine

On top of those three ideas sits the reusable **document engine**
(`workspace/engine/`, exposed as `ctx.engine`) — the foundation every editing
feature depends on. It adds an extensible object model, reversible commands
(with transactions + coalescing), layer-based **incremental** rendering that
repaints only changed regions, a selection system, spatial-index-backed hit
testing, and a plugin architecture so new tools register themselves without
touching the core. It virtualizes pages and indexes lazily to stay fast and
memory-light on very large documents. It is purely additive to the UI (it paints
onto a transparent per-page overlay). See
[`public/js/workspace/engine/README.md`](public/js/workspace/engine/README.md)
for the full architecture and the plugin-authoring guide.

### PDF rendering

Real PDF pages are decoded and rendered with **Mozilla PDF.js**, kept isolated
in `workspace/pdf/` and served **locally** (never a CDN) from
`node_modules/pdfjs-dist` at `/vendor/pdfjs`, so it satisfies the strict CSP.
The viewer paints each page onto the engine's **background layer** while
annotations/shapes/selection stay on the overlay above it. It is built for scale:

- **Virtualized + lazy** — an `IntersectionObserver` renders a page only when it
  scrolls into view; off-screen pages never decode.
- **Cancellable + cached** — leaving a page cancels its render task and releases
  its canvas backing store and text layer, bounding memory on 1,000+ page files.
- **High-DPI** — pages rasterize at `devicePixelRatio`, capped to a safe pixel
  budget; visible pages **re-render on zoom** so text stays crisp.
- **Background** — all decoding runs in the PDF.js Web Worker; the UI never
  freezes.
- **Selectable text** — a real text layer renders beneath the annotation overlay
  (copyable today, search-ready tomorrow).
- **Viewer features** — multi-page, accurate sizes, zoom, Fit Width / Fit Page
  (`Ctrl+0` / `Ctrl+9`), page rotation (`[` / `]`), and a lazy thumbnail rail
  for fast navigation.

### Adding a workspace tool

Add one definition to the relevant file in `public/js/workspace/tools/`
(e.g. `annotate.js`):

```js
{
  id: 'redact',
  label: 'Redact',
  group: 'document',
  icon: 'protect',          // any key from icons.js
  cursor: 'crosshair',
  shortcut: 'R',
  properties: [
    fields.heading('Redaction'),
    fields.color('color', 'Fill', '#000000'),
    fields.opacity(),
  ],
}
```

It immediately appears in the sidebar with a working properties panel, cursor
and keyboard shortcut. No layout, routing or UI changes required.

---

## 🚀 Getting started

**Prerequisites:** Node.js 18+

```bash
# 1. Install dependencies
npm install

# 2. (Optional) create your environment file
cp .env.example .env

# 3. Run in development (auto-reload)
npm run dev

# ...or run in production mode
npm start
```

Then open **http://localhost:3000**.

---

## 📜 npm scripts

| Script          | Description                                  |
| --------------- | -------------------------------------------- |
| `npm start`     | Start the server (production).               |
| `npm run dev`   | Start with nodemon (auto-reload).            |
| `npm run lint`  | Placeholder — no linter configured yet.      |
| `npm test`      | Placeholder — no tests configured yet.       |

---

## ⚙️ Environment variables

See [`.env.example`](./.env.example). All settings have sensible defaults, so the
app runs without an `.env` file.

| Variable        | Default                 | Description                    |
| --------------- | ----------------------- | ------------------------------ |
| `NODE_ENV`      | `development`           | Runtime environment.           |
| `PORT`          | `3000`                  | HTTP port.                     |
| `HOST`          | `localhost`             | Host name for local links.     |
| `SITE_NAME`     | `DocMaster`             | Public site name.              |
| `SITE_URL`      | `http://localhost:3000` | Base URL for canonical/OG tags.|
| `CONTACT_EMAIL` | `hello@docmaster.io`    | Public contact email.          |

---

## 🧩 Adding a tool

There are two independent surfaces:

- **In the editor** — add a definition under `public/js/workspace/tools/`
  (see [Document Workspace architecture](#️-document-workspace-architecture)).
- **On the marketing site** — add an entry to `src/data/tools.js` with a
  `workspaceTool` id. The landing grid, tools overview and footer pick it up
  automatically, deep-linking to `/workspace?tool=<id>`.

---

## 📄 License

MIT
