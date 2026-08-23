/**
 * PDF.js loader + configuration (local, never a CDN).
 *
 * The library and its worker/cMaps/fonts are served from `/vendor/pdfjs`
 * (mounted from `node_modules/pdfjs-dist` by the server), so everything stays
 * same-origin and satisfies the app's strict Content-Security-Policy. Rendering
 * runs in a module Web Worker off the main thread, so decoding a heavy page
 * never freezes the UI.
 *
 * This module owns the one-time global configuration and re-exports the few
 * PDF.js symbols the viewer needs, keeping the coupling to a single file.
 */

import * as pdfjsLib from '/vendor/pdfjs/build/pdf.min.mjs';

/** Base path for all locally-served PDF.js runtime assets. */
export const PDFJS_VENDOR_BASE = '/vendor/pdfjs/';

// Off-main-thread rendering. Same-origin module worker → allowed by CSP.
pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_VENDOR_BASE}build/pdf.worker.min.mjs`;

/** Options every `getDocument` call should carry (character maps + base fonts). */
export const PDF_DOCUMENT_DEFAULTS = Object.freeze({
  cMapUrl: `${PDFJS_VENDOR_BASE}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${PDFJS_VENDOR_BASE}standard_fonts/`,
  // We hand PDF.js the bytes directly, so it never needs to reach the network.
  enableXfa: false,
});

export const {
  getDocument,
  TextLayer,
  PixelsPerInch,
  RenderingCancelledException,
  Util,
  OPS,
  version: PDFJS_VERSION,
} = pdfjsLib;

/** CSS px per PDF point (72dpi → 96dpi). Page geometry is expressed in these. */
export const CSS_UNITS = PixelsPerInch.PDF_TO_CSS_UNITS;

export default pdfjsLib;
