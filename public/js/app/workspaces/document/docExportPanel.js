/**
 * Advanced Export panel (Document editor).
 *
 * A focused modal opened from Download → "Advanced Export". Its main view is a
 * grid of large tool cards — PDF, page images (JPG/PNG) and Compress Word — each
 * running client-side straight from the editor's block model (see
 * `services/convert/blockExport.js` and `blockMedia.js`). The editor stays
 * mounted underneath; nothing is lost.
 *
 * Most tools convert and download on click. Compress Word instead opens a second
 * view in the same sheet: a compression dialog with size presets and a custom
 * target size. Compression is real — the resulting size is measured from the
 * generated file, and custom targets are approached iteratively and reported
 * honestly (achieved or not), never faked.
 *
 * The TOOLS table is the extension point; adding a converter later is one entry.
 */
import { el } from '../../../workspace/utils/dom.js';
import { renderIcon } from '../../../workspace/icons.js';
import { blockModelToImages, compressWord, estimateWordSize } from '../../services/convert/blockMedia.js';
import { blockModelToPdf, blockModelToXlsx, blockModelToPptx } from '../../services/convert/blockExport.js';
import { trackEvent } from '../../core/analytics.js';

// Each tool: an icon, title, description and either a `run(ctx)` (convert +
// download immediately) or `view` (open a sub-view). `ctx` = { model, name,
// base, onProgress }.
const TOOLS = [
  {
    id: 'pdf', icon: 'pdf', title: 'Document → PDF', desc: 'Convert your document into PDF',
    async run({ model, base }) {
      const blob = await blockModelToPdf(model);
      return { blob, filename: `${base}.pdf` };
    },
  },
  {
    id: 'jpg', icon: 'image', title: 'Document → JPG', desc: 'Export document pages as JPG images',
    async run({ model, name, onProgress }) {
      return blockModelToImages(model, { format: 'jpg', name, onProgress: pageMsg(onProgress) });
    },
  },
  {
    id: 'png', icon: 'image', title: 'Document → PNG', desc: 'Export document pages as PNG images',
    async run({ model, name, onProgress }) {
      return blockModelToImages(model, { format: 'png', name, onProgress: pageMsg(onProgress) });
    },
  },
  {
    id: 'excel', icon: 'layers', title: 'Document → Excel', desc: 'Convert your document into a spreadsheet',
    async run({ model, base }) {
      const blob = await blockModelToXlsx(model);
      return { blob, filename: `${base}.xlsx` };
    },
  },
  {
    id: 'compress', icon: 'compress', title: 'Compress Word', desc: 'Reduce Word document file size',
    view: 'compress',
  },
  {
    id: 'ppt', icon: 'template', title: 'Document → PowerPoint',
    desc: 'Convert your document into an editable presentation', wide: true,
    async run({ model, base }) {
      const blob = await blockModelToPptx(model);
      return { blob, filename: `${base}.pptx` };
    },
  },
];

const COMPRESSION_MODES = [
  { id: 'small', label: 'Small Compression', desc: 'Lighter reduction, best quality' },
  { id: 'medium', label: 'Medium Compression', desc: 'Balanced size and quality' },
  { id: 'high', label: 'High Compression', desc: 'Smaller file, more image loss' },
  { id: 'custom', label: 'Custom Target Size', desc: 'Compress toward a size you choose' },
];

const KB = 1024;
const MB = 1024 * 1024;
const pageMsg = (onProgress) => (done, total) => onProgress(`Rendering pages… ${done}/${total}`);

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < KB) return `${n} B`;
  if (n < MB) return `${(n / KB).toFixed(0)} KB`;
  return `${(n / MB).toFixed(1)} MB`;
}

/**
 * @param {{ getModel:()=>object, getDocName:()=>string,
 *   downloadBlob:(blob:Blob, filename:string)=>void, toast?:(m:string)=>void,
 *   mount?:HTMLElement }} deps
 */
export function createDocExportPanel({ getModel, getDocName, downloadBlob, toast, mount }) {
  let overlay = null;
  let busy = false;
  let lastFocus = null;
  let view = 'grid';
  // Compress dialog state, reset each time the dialog is opened.
  const compress = { mode: 'medium', targetValue: '2.0', targetUnit: 'MB', currentSize: 0 };

  function open() {
    if (overlay) return;
    lastFocus = document.activeElement;
    view = 'grid';

    overlay = el('div', {
      class: 'dxp', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Advanced export',
      onMousedown: (e) => { if (e.target === overlay) close(); },
    }, [
      el('div', { class: 'dxp__sheet', role: 'document' }, [
        el('div', { class: 'dxp__head' }),
        el('div', { class: 'dxp__body' }),
        el('div', { class: 'dxp__status', 'aria-live': 'polite' }),
      ]),
    ]);

    (mount || document.body).appendChild(overlay);
    document.addEventListener('keydown', onKey, true);
    render();
  }

  function close() {
    if (busy || !overlay) return;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    overlay = null;
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch { /* gone */ } }
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); }
  }

  /* -------------------------------- views -------------------------------- */
  function render() {
    if (!overlay) return;
    const head = overlay.querySelector('.dxp__head');
    const body = overlay.querySelector('.dxp__body');
    clearStatus();

    if (view === 'compress') {
      head.replaceChildren(
        el('button', {
          class: 'dxp__back', type: 'button', 'aria-label': 'Back to export tools',
          html: renderIcon('chevron'), onClick: () => { if (!busy) { view = 'grid'; render(); } },
        }),
        el('div', { class: 'dxp__head-txt' }, [
          el('h2', { class: 'dxp__title' }, 'Compress Word'),
          el('p', { class: 'dxp__sub' }, 'Reduce Word document file size'),
        ]),
        el('button', { class: 'dxp__x', type: 'button', 'aria-label': 'Close', html: renderIcon('close'), onClick: close }),
      );
      body.replaceChildren(compressForm());
      body.querySelector('.dxp__mode')?.focus();
      return;
    }

    head.replaceChildren(
      el('div', { class: 'dxp__head-txt' }, [
        el('h2', { class: 'dxp__title' }, 'Advanced Export'),
        el('p', { class: 'dxp__sub' }, 'More formats and document tools'),
      ]),
      el('button', { class: 'dxp__x', type: 'button', 'aria-label': 'Close', html: renderIcon('close'), onClick: close }),
    );
    body.replaceChildren(el('div', { class: 'dxp__grid', role: 'group', 'aria-label': 'Export tools' },
      TOOLS.map(toolCard)));
    body.querySelector('.dxp__tool:not(.dxp__tool--locked)')?.focus();
  }

  // One card per tool. Available tools convert/open on click; a locked tool is a
  // muted, non-interactive "Coming Soon" placeholder (lock icon + badge, native
  // tooltip) that never runs or downloads.
  function toolCard(t) {
    const locked = t.available === false;
    const cls = `dxp__tool${t.wide ? ' dxp__tool--wide' : ''}${locked ? ' dxp__tool--locked' : ''}`;
    const body = el('span', { class: 'dxp__tool-body' }, [
      el('span', { class: 'dxp__tool-title' }, [
        t.title,
        t.comingSoon ? el('span', { class: 'dxp__badge' }, 'Coming Soon') : null,
      ]),
      el('span', { class: 'dxp__tool-desc' }, t.desc),
    ]);
    if (locked) {
      return el('div', {
        class: cls, 'data-id': t.id, role: 'button', 'aria-disabled': 'true',
        title: t.tooltip || '',
      }, [
        el('span', { class: 'dxp__tool-ico', html: renderIcon(t.icon), 'aria-hidden': 'true' }),
        body,
        el('span', { class: 'dxp__tool-lock', html: renderIcon('lock'), 'aria-hidden': 'true' }),
      ]);
    }
    return el('button', {
      class: cls, type: 'button', 'data-id': t.id,
      onClick: () => (t.view ? openCompress() : run(t)),
    }, [
      el('span', { class: 'dxp__tool-ico', html: renderIcon(t.icon), 'aria-hidden': 'true' }),
      body,
    ]);
  }

  /* ---------------------------- compress view ---------------------------- */
  async function openCompress() {
    const model = getModel && getModel();
    if (!hasContent(model)) { setError('This document is empty — add some content first.'); return; }
    compress.mode = 'medium';
    compress.targetValue = '2.0';
    compress.targetUnit = 'MB';
    compress.currentSize = 0;
    view = 'compress';
    render();
    // The real starting size, measured from the plain Word export (async now that
    // charts/shapes may be rasterised during export).
    try { compress.currentSize = await estimateWordSize(model); render(); } catch { compress.currentSize = 0; }
  }

  function compressForm() {
    const form = el('div', { class: 'dxp__compress' });

    form.appendChild(el('div', { class: 'dxp__size' }, [
      el('span', { class: 'dxp__size-lbl' }, 'Current file size'),
      el('span', { class: 'dxp__size-val' }, fmtBytes(compress.currentSize)),
    ]));

    form.appendChild(el('div', { class: 'dxp__section-lbl' }, 'Compression Mode'));

    const modes = el('div', { class: 'dxp__modes', role: 'radiogroup', 'aria-label': 'Compression mode' },
      COMPRESSION_MODES.map((m) => el('button', {
        class: `dxp__mode${m.id === compress.mode ? ' is-on' : ''}`, type: 'button', role: 'radio',
        'data-mode': m.id, 'aria-checked': m.id === compress.mode ? 'true' : 'false',
        onClick: () => {
          compress.mode = m.id;
          for (const c of modes.querySelectorAll('.dxp__mode')) {
            const on = c.dataset.mode === m.id;
            c.classList.toggle('is-on', on);
            c.setAttribute('aria-checked', on ? 'true' : 'false');
          }
          custom.hidden = m.id !== 'custom';
          syncValidity();
        },
      }, [
        el('span', { class: 'dxp__mode-dot', 'aria-hidden': 'true' }),
        el('span', { class: 'dxp__mode-txt' }, [
          el('span', { class: 'dxp__mode-lbl' }, m.label),
          el('span', { class: 'dxp__mode-desc' }, m.desc),
        ]),
      ])));
    form.appendChild(modes);

    // Custom target size — a number + KB/MB unit, plus a live validation hint.
    const num = el('input', {
      class: 'dxp__num', type: 'number', min: '0', step: 'any', inputmode: 'decimal',
      'aria-label': 'Target size', placeholder: 'e.g. 2.0', value: compress.targetValue,
      onInput: (e) => { compress.targetValue = e.target.value; syncValidity(); },
    });
    const unit = el('select', {
      class: 'dxp__unit', 'aria-label': 'Size unit',
      onChange: (e) => { compress.targetUnit = e.target.value; syncValidity(); },
    }, [
      el('option', { value: 'KB', selected: compress.targetUnit === 'KB' ? 'selected' : null }, 'KB'),
      el('option', { value: 'MB', selected: compress.targetUnit === 'MB' ? 'selected' : null }, 'MB'),
    ]);
    const hint = el('p', { class: 'dxp__hint' });
    const custom = el('div', { class: 'dxp__field', hidden: compress.mode !== 'custom' }, [
      el('label', { class: 'dxp__section-lbl' }, 'Target file size'),
      el('div', { class: 'dxp__sizerow' }, [num, unit]),
      hint,
    ]);
    form.appendChild(custom);

    const go = el('button', { class: 'dxp__go', type: 'button', onClick: runCompress },
      [el('span', { html: renderIcon('compress'), 'aria-hidden': 'true' }), el('span', {}, 'Compress')]);
    form.appendChild(el('div', { class: 'dxp__go-row' }, [go]));

    // Keep the hint text and Compress button in step with the current input.
    function syncValidity() {
      const v = validateTarget();
      hint.textContent = v.message || '';
      hint.className = `dxp__hint${v.tone ? ` is-${v.tone}` : ''}`;
      go.disabled = busy || v.block;
    }
    syncValidity();

    return form;
  }

  /** Validate the custom target. Returns { block, message, tone, bytes }. */
  function validateTarget() {
    if (compress.mode !== 'custom') return { block: false, bytes: 0 };
    const raw = String(compress.targetValue).trim();
    if (raw === '') return { block: true, message: 'Enter a target size.', tone: 'error', bytes: 0 };
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      return { block: true, message: 'Enter a valid size greater than 0.', tone: 'error', bytes: 0 };
    }
    const bytes = Math.round(n * (compress.targetUnit === 'MB' ? MB : KB));
    if (compress.currentSize && bytes >= compress.currentSize) {
      return { block: true, message: 'Target size is already larger than the current file.', tone: 'error', bytes };
    }
    // Very small targets are allowed, but warn that they may be unreachable.
    if (bytes < 8 * KB || (compress.currentSize && bytes < compress.currentSize * 0.03)) {
      return {
        block: false, tone: 'warn', bytes,
        message: 'This target size may not be achievable without significant quality or content changes.',
      };
    }
    return { block: false, bytes };
  }

  async function runCompress() {
    if (busy) return;
    const model = getModel && getModel();
    if (!hasContent(model)) { setError('This document is empty — add some content first.'); return; }
    const v = validateTarget();
    if (v.block) return; // hint already explains why
    const name = (getDocName && getDocName()) || 'document';
    setBusy(true);
    setWorking('Preparing…');
    try {
      const res = await compressWord(model, {
        mode: compress.mode, targetBytes: v.bytes || 0, name,
        onProgress: (m) => setWorking(m),
      });
      downloadBlob(res.blob, res.filename);
      setBusy(false);
      renderCompressResult(res);
      trackEvent('document_export', { format: 'compress' });
      toast?.(`Exported ${res.filename}`);
    } catch (err) {
      console.error('[doc-export] compress', err);
      setBusy(false);
      setError(err && err.message ? err.message : 'Compression failed. Please try again.');
    }
  }

  function renderCompressResult(res) {
    const rows = [
      ['Original size', fmtBytes(res.originalSize)],
      res.mode === 'custom' ? ['Target size', fmtBytes(res.targetSize)] : null,
      ['Compressed size', fmtBytes(res.compressedSize)],
      ['Reduced by', `${res.reducedPct.toFixed(1)}%`],
    ].filter(Boolean);

    const isCustom = res.mode === 'custom';
    const ok = res.achieved === true;
    const statusLine = isCustom
      ? el('div', { class: `dxp__verdict ${ok ? 'is-ok' : 'is-warn'}` }, [
        el('span', { class: 'dxp__verdict-ico', html: renderIcon(ok ? 'check' : 'close'), 'aria-hidden': 'true' }),
        el('span', {}, ok ? 'Target size achieved' : 'Target size not fully achieved'),
      ])
      : el('div', { class: 'dxp__verdict is-ok' }, [
        el('span', { class: 'dxp__verdict-ico', html: renderIcon('check'), 'aria-hidden': 'true' }),
        el('span', {}, 'Compressed'),
      ]);

    const note = (isCustom && !ok)
      ? el('p', { class: 'dxp__result-note' },
        'The document could not be reduced further without significantly affecting quality or document content.')
      : null;

    statusEl()?.replaceChildren(el('div', { class: 'dxp__breakdown' }, [
      el('div', { class: 'dxp__breakdown-rows' }, rows.map(([k, val]) => el('div', { class: 'dxp__brow' }, [
        el('span', { class: 'dxp__brow-k' }, k),
        el('span', { class: 'dxp__brow-v' }, val),
      ]))),
      statusLine,
      note,
    ]));
  }

  /* --------------------------- simple tools ------------------------------ */
  async function run(tool) {
    if (busy) return;
    const model = getModel && getModel();
    if (!hasContent(model)) { setError('This document is empty — add some content first.'); return; }
    const name = (getDocName && getDocName()) || 'document';
    const base = name.replace(/\.[^.]+$/, '');
    setBusy(true);
    setWorking('Preparing…');
    try {
      const out = await tool.run({ model, name, base, onProgress: (m) => setWorking(m) });
      // A tool returns either a single { blob, filename } or, for page images, a list
      // of { blob, filename } — one file PER PAGE, each downloaded separately (no zip).
      const files = out && Array.isArray(out.files) ? out.files
        : (out && out.blob instanceof Blob ? [{ blob: out.blob, filename: out.filename }] : null);
      if (!files || !files.length) { setBusy(false); setError('Nothing was produced.'); return; }
      for (const f of files) downloadBlob(f.blob, f.filename);
      setBusy(false);
      // One export event per action, even when a tool emits many page images.
      trackEvent('document_export', { format: tool.id });
      if (files.length === 1) {
        setDone({ filename: files[0].filename, extra: out.extra });
        toast?.(`Exported ${files[0].filename}`);
      } else {
        setDone({ filename: `${files.length} page images`, extra: out.extra });
        toast?.(`Exported ${files.length} images`);
      }
    } catch (err) {
      console.error('[doc-export]', tool.id, err);
      setBusy(false);
      setError(err && err.message ? err.message : 'Something went wrong. Please try again.');
    }
  }

  /* ------------------------------ status --------------------------------- */
  function statusEl() { return overlay?.querySelector('.dxp__status'); }
  function clearStatus() { statusEl()?.replaceChildren(); }

  function setBusy(on) {
    busy = on;
    overlay?.classList.toggle('is-busy', on);
  }

  function setWorking(msg) {
    statusEl()?.replaceChildren(el('div', { class: 'dxp__working' }, [
      el('span', { class: 'dxp__spin', 'aria-hidden': 'true' }),
      el('span', {}, msg || 'Working…'),
    ]));
  }

  function setError(msg) {
    setBusy(false);
    statusEl()?.replaceChildren(el('div', { class: 'dxp__result is-error' }, [
      el('span', { class: 'dxp__result-ico', html: renderIcon('close'), 'aria-hidden': 'true' }),
      el('span', { class: 'dxp__result-txt' }, msg || 'Something went wrong. Please try again.'),
    ]));
  }

  function setDone({ filename, extra }) {
    statusEl()?.replaceChildren(el('div', { class: 'dxp__result is-ok' }, [
      el('span', { class: 'dxp__result-ico', html: renderIcon('check'), 'aria-hidden': 'true' }),
      el('span', { class: 'dxp__result-txt' }, [
        el('strong', {}, filename),
        extra ? el('span', { class: 'dxp__result-sub' }, extra) : null,
      ]),
    ]));
  }

  return {
    open,
    close,
    isOpen: () => !!overlay,
    destroy() { busy = false; close(); },
  };
}

/** A document with at least one non-empty block is worth exporting. */
function hasContent(model) {
  const blocks = model && model.blocks;
  if (!Array.isArray(blocks) || !blocks.length) return false;
  return blocks.some((b) => {
    if (b.type === 'image' || b.type === 'table') return true;
    if (b.type === 'list') return (b.items || []).some((it) => (it.runs || []).some((r) => (r.text || '').trim()));
    return (b.runs || []).some((r) => (r.text || '').trim());
  });
}
