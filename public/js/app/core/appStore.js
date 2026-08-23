/**
 * The global application store.
 *
 * Reuses the workspace's proven observable store implementation, but holds only
 * SHELL-level state — the things the shared chrome (nav, toolbar, panel, status
 * bar) needs. Per-workspace state (documents, engine objects, page stacks) lives
 * inside each workspace, never here, so the two stay decoupled.
 */
import { createStore } from '../../workspace/core/store.js';

export function createAppStore() {
  return createStore({
    // Shell
    activeWorkspaceId: null, // 'home' | 'pdf' | 'document'
    panelOpen: window.innerWidth > 1024,
    navHidden: false, // true collapses the global nav rail (blank PDF editor → single sidebar)
    blankMode: false, // true = the blank PDF editor owns the whole window (shared chrome hidden)
    homeMode: false, // true = the minimal home launcher (shared chrome hidden)
    docMode: false, // true = the Document editor owns the window as a dedicated word processor (its own menu + formatting bars; shared toolbar/nav/panel hidden, status bar kept)

    // Active document (mirrored up from the workspace for the toolbar/status bar)
    file: null, // { name, size, type }
    docName: 'Untitled',
    status: 'idle', // idle | loading | ready | processing | error
    statusMessage: 'Ready',

    // View state surfaced by the active workspace
    zoom: 1,
    currentPage: 1,
    totalPages: 0,
    pageSize: null, // e.g. 'A4' — shown in the status bar when a canvas is open
    canUndo: false,
    canRedo: false,

    // Contextual selection (drives the properties panel)
    selection: { kind: 'none' },

    // Library
    recent: [],
    projects: [],
  });
}
