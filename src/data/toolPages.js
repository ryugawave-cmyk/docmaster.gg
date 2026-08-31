'use strict';

/**
 * Long-form, human-written content for each `/tools/<slug>` overview page.
 *
 * Every entry is keyed by the tool slug used in `data/tools.js`. The copy is
 * intentionally specific and truthful: Advance Office Doc processes files entirely in
 * the browser, so the privacy notes describe that real behaviour rather than
 * server-side promises the app does not make.
 */

// Shared, truthful privacy statement reused across tool pages. The app has no
// upload endpoints — every transform runs client-side (see ARCHITECTURE.md).
const CLIENT_PRIVACY =
  'This tool runs entirely inside your web browser. Your file is opened locally and processed on your own device — it is never uploaded to Advance Office Doc servers, and we never see, store or share its contents. When you close or refresh the tab, the working copy in memory is gone.';

const toolPages = {
  'merge-pdf': {
    lead: 'Combine several PDF files into a single, cleanly ordered document — all in your browser.',
    intro: [
      'Merge PDF lets you join two or more PDF files into one continuous document. Add your files, arrange them in the order you want, and export a single PDF you can share, print or archive.',
      'Because everything happens on your device, even large or sensitive files stay private — nothing is sent to a server to be combined.',
    ],
    capabilities: [
      'Combine multiple PDFs into one file',
      'Reorder documents before merging with drag-and-drop',
      'Keep the original page quality and text',
      'Export the result as a standard PDF',
    ],
    audience: [
      'Students combining chapters, notes or assignments into one file',
      'Professionals assembling reports, invoices or contracts',
      'Anyone who needs to send one PDF instead of several attachments',
    ],
    howTo: [
      'Open the editor and choose the PDF tools.',
      'Add the PDF files you want to combine.',
      'Drag the files into the order you want them to appear.',
      'Merge them and export the combined PDF to your device.',
    ],
    fileTypes: 'PDF files (.pdf). Password-protected PDFs must be unlocked first.',
    limitations: [
      'Very large files depend on your device’s available memory.',
      'Merging keeps existing content as-is; it does not re-flow or re-paginate text across files.',
    ],
    faq: [
      { q: 'Is there a limit on how many PDFs I can merge?', a: 'There is no fixed limit, but performance depends on your device — combining a handful of ordinary documents is fast, while dozens of very large files use more memory.' },
      { q: 'Will merging reduce the quality of my PDF?', a: 'No. Pages are carried over as they are, so text stays selectable and images keep their resolution.' },
    ],
  },

  'split-pdf': {
    lead: 'Separate a PDF into individual pages or smaller documents — privately, in your browser.',
    intro: [
      'Split PDF helps you break one PDF into the pieces you actually need. Extract a single page, pull out a range, or divide a long document into several smaller files.',
      'It is ideal when only part of a document matters — a single form, one chapter, or a section you want to share on its own.',
    ],
    capabilities: [
      'Extract specific pages or page ranges',
      'Split a large document into multiple files',
      'Preview pages before exporting',
      'Save the resulting file(s) to your device',
    ],
    audience: [
      'People who need to share just one section of a long report',
      'Anyone extracting a single form or receipt from a bundle',
      'Teams breaking large scans into manageable documents',
    ],
    howTo: [
      'Open the editor and load your PDF in the PDF tools.',
      'Select the pages or ranges you want to keep.',
      'Split the document into the parts you need.',
      'Export and save the new file(s).',
    ],
    fileTypes: 'PDF files (.pdf).',
    limitations: [
      'Splitting works on page boundaries; it does not divide the content within a single page.',
      'Encrypted PDFs need to be unlocked before they can be split.',
    ],
    faq: [
      { q: 'Can I extract just one page?', a: 'Yes — choose the single page you want and export it as its own PDF.' },
      { q: 'Do the split files keep the original formatting?', a: 'Yes. Each extracted page is preserved exactly as it appears in the source document.' },
    ],
  },

  'compress-pdf': {
    lead: 'Reduce PDF file size for easier sharing while keeping your document readable.',
    intro: [
      'Compress PDF makes large PDFs smaller so they are easier to email, upload or store. It re-encodes images and streamlines the file to cut size without turning your document into something unreadable.',
      'The whole process runs on your device, so you can compress confidential files without handing them to a third party.',
    ],
    capabilities: [
      'Shrink oversized PDFs for sharing and upload limits',
      'Balance file size against visual quality',
      'Keep text selectable where possible',
      'Export the optimised PDF locally',
    ],
    audience: [
      'Anyone hitting email or upload size limits',
      'People sharing image-heavy PDFs like scans or brochures',
      'Users who want smaller files for long-term storage',
    ],
    howTo: [
      'Open the editor and load your PDF.',
      'Choose the compression that fits your needs.',
      'Review the result to check it still looks right.',
      'Export the smaller PDF to your device.',
    ],
    fileTypes: 'PDF files (.pdf).',
    limitations: [
      'How much a file shrinks depends on its contents — image-heavy PDFs compress more than text-only ones.',
      'Strong compression can visibly reduce image sharpness; choose a lighter setting if quality matters most.',
    ],
    faq: [
      { q: 'How much smaller will my file get?', a: 'It varies. Scanned or photo-rich PDFs often shrink substantially, while documents that are mostly text may only get a little smaller.' },
      { q: 'Will compression ruin my images?', a: 'Not at moderate settings. Very aggressive compression trades quality for size, so preview the result before saving.' },
    ],
  },

  'edit-pdf': {
    lead: 'Add text, images, highlights and shapes to a PDF directly in your browser.',
    intro: [
      'Edit PDF turns a static PDF into something you can mark up and change. Add or edit text, drop in images, draw shapes, and highlight the parts that matter — then export a finished PDF.',
      'For many imported PDFs, existing text can be edited in place; some content that is baked into the page image is preserved as-is.',
    ],
    capabilities: [
      'Add and edit text on the page',
      'Insert images, shapes and highlights',
      'Annotate and mark up documents',
      'Export an updated PDF',
    ],
    audience: [
      'People filling in or correcting existing PDFs',
      'Reviewers who need to annotate and highlight',
      'Anyone adding a note, logo or image to a document',
    ],
    howTo: [
      'Open the editor and load your PDF.',
      'Use the text, image and shape tools to make your changes.',
      'Position and style each element the way you want.',
      'Export the edited PDF to your device.',
    ],
    fileTypes: 'PDF files (.pdf); images (PNG, JPG) can be placed onto pages.',
    limitations: [
      'Scanned or image-only PDFs may need OCR before their text can be edited as text.',
      'Some complex layouts keep certain content as part of the page image rather than editable text.',
    ],
    faq: [
      { q: 'Can I edit the existing text in a PDF?', a: 'Often, yes — Advance Office Doc extracts a text layer where possible so you can edit it. Content that is part of a scanned image behaves like a picture unless you run OCR.' },
      { q: 'Can I add my signature or a logo?', a: 'Yes. Use the image tool to place a signature image or logo, or use the dedicated Sign PDF tool.' },
    ],
  },

  'organize-pdf': {
    lead: 'Reorder, rotate and remove pages to arrange a PDF exactly how you want it.',
    intro: [
      'Organize PDF gives you a page-level view of your document so you can rearrange it visually. Drag pages into a new order, rotate ones that came in sideways, and delete the pages you no longer need.',
      'It is the fastest way to tidy up a scan or reshape a document before sharing it.',
    ],
    capabilities: [
      'Reorder pages with drag-and-drop',
      'Rotate individual pages',
      'Delete unwanted pages',
      'Export the reorganised PDF',
    ],
    audience: [
      'Anyone cleaning up a multi-page scan',
      'People assembling a document in the right order',
      'Users removing blank or duplicate pages',
    ],
    howTo: [
      'Open the editor and load your PDF.',
      'Drag pages to reorder them.',
      'Rotate or delete pages as needed.',
      'Export the finished PDF.',
    ],
    fileTypes: 'PDF files (.pdf).',
    limitations: [
      'Organising acts on whole pages; it does not edit the content inside a page.',
      'Very large documents are limited by your device’s memory.',
    ],
    faq: [
      { q: 'Can I rotate just one page?', a: 'Yes. Rotation applies to the pages you select, so you can fix a single sideways scan without affecting the rest.' },
      { q: 'If I delete a page, can I undo it?', a: 'Yes — use undo before exporting. Nothing is final until you export and save the file.' },
    ],
  },

  'convert-pdf': {
    lead: 'Convert PDFs to and from Word, Excel, PowerPoint, HTML and images.',
    intro: [
      'Convert PDF bridges your PDF and the formats you work in every day. Export a document to Word, Excel, PowerPoint, HTML, JPG or PNG, or bring those formats into the editor to keep working.',
      'Conversions are generated on your device using built-in converters — there is no conversion server in the loop.',
    ],
    capabilities: [
      'Export to Word (.docx), Excel (.xlsx) and PowerPoint (.pptx)',
      'Export to HTML, JPG and PNG',
      'Compress and repackage documents',
      'Keep working locally with no uploads',
    ],
    audience: [
      'People who need an editable Word or Excel version of a PDF',
      'Anyone turning a document into images for slides or the web',
      'Users moving content between office formats',
    ],
    howTo: [
      'Open the editor and load your document.',
      'Choose Export and pick the target format.',
      'Adjust any available options.',
      'Save the converted file to your device.',
    ],
    fileTypes: 'PDF in and out; export to DOCX, XLSX, PPTX, HTML, JPG, PNG.',
    limitations: [
      'Converters reconstruct a document into a new format, so very complex layouts may not map one-to-one.',
      'Converting a scanned PDF to editable text may require OCR first.',
    ],
    faq: [
      { q: 'Will my formatting survive the conversion?', a: 'Simple, well-structured documents convert cleanly. Highly complex layouts are approximated because each format represents content differently.' },
      { q: 'Are my files uploaded to convert them?', a: 'No. Conversion happens with converters that run in your browser, so files stay on your device.' },
    ],
  },

  'sign-pdf': {
    lead: 'Add a signature to your PDF without printing, scanning or emailing it around.',
    intro: [
      'Sign PDF lets you place a signature onto a document right in the editor. Draw or add a signature image, position it where it belongs, and export a signed PDF.',
      'Signing happens locally, so the document you are signing never leaves your device.',
    ],
    capabilities: [
      'Add a drawn or image-based signature',
      'Place initials, dates and text fields',
      'Position and resize your signature precisely',
      'Export a signed PDF',
    ],
    audience: [
      'Anyone signing an agreement, form or letter',
      'Freelancers and small businesses handling contracts',
      'People who want to avoid the print-sign-scan cycle',
    ],
    howTo: [
      'Open the editor and load the PDF you need to sign.',
      'Create your signature by drawing it or adding an image.',
      'Place it where it belongs and add a date if needed.',
      'Export the signed PDF.',
    ],
    fileTypes: 'PDF files (.pdf); signature images (PNG with transparency work best).',
    limitations: [
      'Advance Office Doc adds a visible signature to the document. It does not issue certificate-based digital signatures or act as a qualified e-signature authority.',
      'Whether a signature is legally binding depends on your jurisdiction and the agreement involved.',
    ],
    faq: [
      { q: 'Is this a legally binding e-signature?', a: 'It adds a visible signature to your PDF, which is widely accepted for everyday agreements. For regulated or certificate-based digital signatures, use a service designed for that purpose.' },
      { q: 'Can I reuse my signature?', a: 'You create your signature each session in the editor; because nothing is stored on our servers, it is not saved to an account.' },
    ],
  },

  'new-document': {
    lead: 'Create rich, well-formatted documents in a clean, Google Docs-style editor.',
    intro: [
      'New Document opens a full rich-text editor for writing from scratch. Structure your work with headings, lists and tables, add images and charts, set up headers and footers, and lay it out across real pages.',
      'When you are done, export to PDF, Word or HTML — all generated on your device.',
    ],
    capabilities: [
      'Write with headings, lists, tables and text formatting',
      'Insert images, shapes and editable charts',
      'Add running headers, footers and page numbers',
      'Export to PDF, Word (.docx) and HTML',
    ],
    audience: [
      'Students and writers drafting reports, essays and letters',
      'Small businesses producing proposals and documentation',
      'Anyone who wants a distraction-free document editor in the browser',
    ],
    howTo: [
      'Open the editor and start a New Document.',
      'Write your content and format it with the toolbar.',
      'Insert tables, images or charts where you need them.',
      'Export to PDF, Word or HTML when you are finished.',
    ],
    fileTypes: 'Create from scratch; import/export DOCX, export PDF and HTML.',
    limitations: [
      'The editor focuses on clear, page-based documents rather than advanced desktop publishing.',
      'Extremely large documents depend on your device’s available memory.',
    ],
    faq: [
      { q: 'Can I export my document to Word?', a: 'Yes. Documents export to Word (.docx), PDF and HTML, all produced locally in your browser.' },
      { q: 'Are tables and images supported?', a: 'Yes — you can insert tables, images, shapes and editable charts, and format them within the document.' },
    ],
  },

  'charts-graphs': {
    lead: 'Build editable bar, line and pie charts from your data and drop them into a document.',
    intro: [
      'Charts & Graphs lets you turn numbers into clear visuals inside the document editor. Choose a chart type, enter or paste your data, and place a clean, editable chart directly into your document.',
      'Charts remain editable, so you can update the underlying data and restyle them at any time.',
    ],
    capabilities: [
      'Create bar, line, pie and other common chart types',
      'Edit the chart’s data in a simple table',
      'Restyle colours and labels to match your document',
      'Export charts as part of your PDF, Word or HTML file',
    ],
    audience: [
      'Students visualising results in a report',
      'Professionals adding figures to proposals and reviews',
      'Anyone who wants charts without a separate spreadsheet app',
    ],
    howTo: [
      'Open the editor and start or open a document.',
      'Insert a chart and choose the type you want.',
      'Enter or paste your data and adjust the styling.',
      'Export the document with your chart included.',
    ],
    fileTypes: 'Charts are created inside documents; export within PDF, DOCX or HTML.',
    limitations: [
      'Charts are designed for clear presentation rather than heavy statistical analysis.',
      'Very large datasets are better summarised before charting.',
    ],
    faq: [
      { q: 'Can I edit a chart after inserting it?', a: 'Yes. Charts stay editable — reopen the data table to change values, labels or styling at any time.' },
      { q: 'Do charts export cleanly to PDF and Word?', a: 'Yes. Charts are included when you export your document to PDF, Word or HTML.' },
    ],
  },

  'excel-spreadsheet': {
    lead: 'Convert PDF tables and documents into Excel spreadsheets you can keep working with.',
    intro: [
      'Excel & Spreadsheets focuses on getting your data into a spreadsheet format. Export documents and extracted tables to Excel (.xlsx) so you can sort, calculate and analyse them in your spreadsheet app of choice.',
      'A dedicated in-browser spreadsheet editor is in active development. Today, Advance Office Doc covers the conversion and export side so you can move data out of PDFs and documents quickly.',
    ],
    capabilities: [
      'Export documents and tables to Excel (.xlsx)',
      'Move tabular data out of PDFs for analysis',
      'Keep data on your device during conversion',
      'Open the result in Excel, Google Sheets or similar',
    ],
    audience: [
      'Anyone extracting tables from a PDF into a spreadsheet',
      'People who need editable numbers instead of a flat document',
      'Users preparing data for further analysis',
    ],
    howTo: [
      'Open the editor and load your document.',
      'Choose Export and select Excel (.xlsx).',
      'Save the spreadsheet to your device.',
      'Open it in your preferred spreadsheet application.',
    ],
    fileTypes: 'Export to Excel (.xlsx). A full spreadsheet editor is on the roadmap.',
    limitations: [
      'A dedicated spreadsheet editor is not available yet — this tool focuses on conversion and export.',
      'Complex or irregular tables may need light cleanup after conversion.',
    ],
    faq: [
      { q: 'Can I edit spreadsheets directly in Advance Office Doc?', a: 'Not yet — a browser-based spreadsheet editor is in development. Today you can export to Excel and edit in your spreadsheet app.' },
      { q: 'Will my table structure be preserved?', a: 'Well-structured tables convert cleanly. Very irregular layouts may need minor adjustments after export.' },
    ],
  },

  'ai-document-tools': {
    lead: 'Assistive document features that run on-device in your browser — no cloud, no API keys.',
    intro: [
      'Advance Office Doc is built as a client-first application: where AI-assisted features are offered, they are designed to run on-device using in-browser models, not by sending your documents to an external AI service.',
      'This is a preview area. Because it runs locally, available capabilities and performance depend on your browser and device — but your documents are never uploaded to a cloud AI provider.',
    ],
    capabilities: [
      'On-device processing — no third-party AI servers involved',
      'No API keys and no account required',
      'Documents stay in your browser',
      'Features expand as on-device models mature',
    ],
    audience: [
      'Privacy-conscious users who avoid cloud AI tools',
      'People who want assistance without uploading documents',
      'Anyone curious about in-browser document intelligence',
    ],
    howTo: [
      'Open the editor and load or create a document.',
      'Open the AI tools area to see what is available.',
      'Run a feature; processing happens on your device.',
      'Review and use the result in your document.',
    ],
    fileTypes: 'Works with documents open in the editor.',
    limitations: [
      'This is an evolving preview; capabilities are more limited than large cloud AI services.',
      'On-device performance depends on your browser, hardware and available memory.',
    ],
    faq: [
      { q: 'Do you send my documents to an AI company?', a: 'No. Advance Office Doc does not use cloud AI providers or API keys — assistive features are designed to run on-device in your browser.' },
      { q: 'Why are the AI features limited?', a: 'Running models on-device keeps your data private but is more constrained than a data-centre service. We expand capabilities as in-browser models improve.' },
    ],
  },
};

/**
 * Get long-form content for a tool page.
 * @param {string} slug
 * @returns {object|undefined}
 */
function getToolPage(slug) {
  return toolPages[slug];
}

module.exports = { getToolPage, CLIENT_PRIVACY };
