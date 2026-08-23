/**
 * PDF/document → PowerPoint (.pptx).
 *
 * A .pptx is an OOXML ZIP with a fixed scaffold (presentation + one master, one
 * layout, one theme) and a slide part per page. Each PDF page becomes a slide
 * whose text runs are placed as absolutely-positioned, editable text boxes (EMU
 * coordinates) — real text, never a flattened page image. Slide size follows the
 * first page's dimensions.
 */
import { zipBlob } from '../zip.js';
import { xml, buildContentModel, PX_TO_PT } from './model.js';

const EMU = (px) => Math.round(px * 9525);

export function modelToPptx(model, opts = {}) {
  const content = buildContentModel(model, opts.name);
  const pages = content.pages.length ? content.pages : [{ index: 0, w: content.PW, h: content.PH, runs: [] }];
  const cx = EMU(pages[0].w), cy = EMU(pages[0].h);

  const slides = pages.map((pg, i) => slideXml(pg, i + 1));

  const presentation =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    '<p:sldIdLst>' +
    pages.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('') +
    '</p:sldIdLst>' +
    `<p:sldSz cx="${cx}" cy="${cy}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;

  const presRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>' +
    pages.map((_, i) => `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('') +
    `<Relationship Id="rId${pages.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>` +
    '</Relationships>';

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
    pages.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('') +
    '</Types>';

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
    '</Relationships>';

  const entries = [
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'ppt/presentation.xml', data: presentation },
    { name: 'ppt/_rels/presentation.xml.rels', data: presRels },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: SLIDE_MASTER },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: MASTER_RELS },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: SLIDE_LAYOUT },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: LAYOUT_RELS },
    { name: 'ppt/theme/theme1.xml', data: THEME },
  ];
  slides.forEach((s, i) => {
    entries.push({ name: `ppt/slides/slide${i + 1}.xml`, data: s });
    entries.push({ name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: SLIDE_RELS });
  });

  return zipBlob(entries, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
}

function slideXml(pg, num) {
  let id = 1;
  const shapes = pg.runs.map((r) => {
    id += 1;
    const sz = Math.round(r.fontSize * PX_TO_PT * 100); // a:sz is in hundredths of a point
    const bold = r.bold ? ' b="1"' : '';
    const ital = r.italic ? ' i="1"' : '';
    const algn = r.align === 'center' ? ' algn="ctr"' : r.align === 'right' ? ' algn="r"' : ' algn="l"';
    const color = r.color || '111827';
    const paras = String(r.text).split('\n').map((line) =>
      `<a:p><a:pPr${algn}/><a:r><a:rPr lang="en-US" sz="${sz}"${bold}${ital}>` +
      `<a:solidFill><a:srgbClr val="${xml(color)}"/></a:solidFill></a:rPr>` +
      `<a:t>${xml(line)}</a:t></a:r></a:p>`).join('');
    return '<p:sp><p:nvSpPr>' +
      `<p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
      '<p:spPr>' +
      `<a:xfrm><a:off x="${EMU(r.x)}" y="${EMU(r.y)}"/><a:ext cx="${EMU(Math.max(r.w, r.fontSize))}" cy="${EMU(Math.max(r.h, r.fontSize))}"/></a:xfrm>` +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
      '</p:spPr>' +
      '<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"><a:spAutoFit/></a:bodyPr><a:lstStyle/>' +
      (paras || '<a:p/>') +
      '</p:txBody></p:sp>';
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:cSld><p:spTree>' +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    shapes +
    '</p:spTree></p:cSld><p:clrMapOvr><a:overrideClrMapping ' +
    'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" ' +
    'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr></p:sld>';
}

/* ------------------------- fixed scaffold parts -------------------------- */

const SLIDE_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
  '</Relationships>';

const MASTER_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>' +
  '</Relationships>';

const LAYOUT_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>' +
  '</Relationships>';

const EMPTY_TREE =
  '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
  '</p:spTree></p:cSld>';

const SLIDE_MASTER =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  '<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
  EMPTY_TREE +
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ' +
  'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
  '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
  '<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles>' +
  '</p:sldMaster>';

const SLIDE_LAYOUT =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  '<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">' +
  EMPTY_TREE +
  '</p:sldLayout>';

const THEME =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme">' +
  '<a:themeElements><a:clrScheme name="Office">' +
  '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>' +
  '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>' +
  '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>' +
  '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>' +
  '<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
  '<a:fmtScheme name="Office">' +
  '<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
  '<a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
  '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
  '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>' +
  '</a:fmtScheme></a:themeElements></a:theme>';
