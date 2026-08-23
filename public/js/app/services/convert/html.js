/**
 * PDF/document → HTML.
 *
 * Produces a clean, standalone, semantic HTML document from the reading-order
 * block stream (headings/paragraphs/lists) plus the document's discrete images
 * embedded inline as data URLs. Real, editable, copy-pasteable text — not a
 * screenshot of the pages.
 */
import { xml, buildContentModel } from './model.js';

export function modelToHtml(model, opts = {}) {
  const content = buildContentModel(model, opts.name);
  const title = xml(content.name || 'Document');

  const parts = [];
  let listOpen = false;
  const closeList = () => { if (listOpen) { parts.push('</ul>'); listOpen = false; } };

  for (const b of content.blocks) {
    if (b.type === 'bullet') {
      if (!listOpen) { parts.push('<ul>'); listOpen = true; }
      parts.push(`<li>${xml(b.text)}</li>`);
      continue;
    }
    closeList();
    if (b.type === 'heading') {
      const h = Math.min(3, Math.max(1, b.level));
      parts.push(`<h${h}>${xml(b.text)}</h${h}>`);
    } else {
      parts.push(`<p>${xml(b.text)}</p>`);
    }
  }
  closeList();

  // Append discrete images (logos, photos) after the text.
  const imgs = [];
  for (const p of content.pages) for (const im of p.images) imgs.push(im);
  if (imgs.length) {
    parts.push('<div class="images">');
    for (const im of imgs) parts.push(`<img src="${im.src}" alt="">`);
    parts.push('</div>');
  }

  if (!parts.length) parts.push('<p><em>No extractable text was found in this document.</em></p>');

  return new Blob([
    '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${title}</title>\n` +
    '<style>\n' +
    'body{font-family:Calibri,Segoe UI,Arial,sans-serif;line-height:1.5;color:#1f2937;max-width:820px;margin:2rem auto;padding:0 1.25rem}\n' +
    'h1,h2,h3{line-height:1.25;margin:1.4em 0 .5em}\nh1{font-size:1.8rem}h2{font-size:1.4rem}h3{font-size:1.15rem}\n' +
    'p{margin:0 0 .9em}\nul{margin:0 0 .9em 1.25em}\n.images{margin-top:1.5rem}\n.images img{max-width:100%;height:auto;margin:.5rem 0;border:1px solid #e5e7eb;border-radius:6px}\n' +
    '</style>\n</head>\n<body>\n' + parts.join('\n') + '\n</body>\n</html>',
  ], { type: 'text/html' });
}
