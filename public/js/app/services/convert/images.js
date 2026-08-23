/**
 * PDF/document → images (JPG / PNG).
 *
 * Rasterises each page with the SAME compositor the PDF export uses
 * (renderPageCanvas), so the images match the edited document exactly. A single
 * page downloads as one image; multiple pages are bundled into a ZIP
 * (page-1.jpg, page-2.jpg, …).
 *
 * @returns {Promise<{ blob:Blob, filename:string }>}
 */
import { renderPageCanvas } from '../../editor/pdfExport.js';
import { zipBlob, dataURLToBytes } from '../zip.js';

const QUALITY = { screen: { scale: 1.5, q: 0.85 }, high: { scale: 2.5, q: 0.95 } };

export async function modelToImages(model, opts = {}) {
  const format = opts.format === 'png' ? 'png' : 'jpg';
  const mime = format === 'png' ? 'image/png' : 'image/jpeg';
  const preset = QUALITY[opts.resolution] || QUALITY.screen;
  const base = (opts.name || 'document').replace(/\.[^.]+$/, '');
  const onProgress = opts.onProgress || (() => {});

  const pages = model.pages || [];
  const dataUrls = [];
  for (let i = 0; i < pages.length; i += 1) {
    const { canvas } = await renderPageCanvas(pages[i], model, preset.scale);
    dataUrls.push(canvas.toDataURL(mime, preset.q));
    onProgress(i + 1, pages.length);
  }

  if (dataUrls.length === 0) throw new Error('No pages to export.');

  if (dataUrls.length === 1) {
    return { blob: new Blob([dataURLToBytes(dataUrls[0])], { type: mime }), filename: `${base}.${format}` };
  }

  const entries = dataUrls.map((url, i) => ({ name: `page-${i + 1}.${format}`, data: dataURLToBytes(url) }));
  return { blob: zipBlob(entries), filename: `${base}-images.zip` };
}
