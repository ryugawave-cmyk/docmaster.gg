/**
 * AI provider proxy for the Cloudflare Worker — a port of src/controllers/aiController.js.
 *
 * The API key lives in a Worker secret (env.AI_API_KEY) and never reaches the
 * browser. Two reply shapes: plain chat ({ reply }) and the document-editing agent
 * (mode:'agent' → { actions:[…] }). Provider is chosen by env.AI_PROVIDER
 * (gemini | openai | anthropic). Uses the Worker's global fetch.
 */

const SYSTEM = [
  'You are the AI writing assistant embedded in a document editor.',
  'The user is editing a document; when they share its text, help with that text.',
  'Be concise and practical. Return plain text (no markdown fences) unless asked.',
].join(' ');

const AGENT_SYSTEM = [
  'You are DocMaster AI, a document-editing agent embedded in a rich-text editor.',
  'Users create, modify and refine a document through natural-language instructions,',
  'like a conversational (Nano-Banana-style) editing workflow but for documents.',
  '',
  'When the user asks to create, edit, delete, rewrite, expand, shorten, summarize,',
  'or format content, DO NOT reply conversationally. Instead return ONLY a JSON object',
  'of the form {"actions":[ ... ]} where each item is one of the supported actions.',
  'Return raw JSON — no prose, no markdown code fences.',
  '',
  'Supported actions (each object has an "action" field):',
  '- insert_text        {"action":"insert_text","target":"cursor"|"end","content":"markdown"}',
  '- replace_selection  {"action":"replace_selection","content":"markdown"}',
  '- replace_section    {"action":"replace_section","target":"<heading/section name>","content":"markdown"}',
  '- delete_section     {"action":"delete_section","target":"<heading/section name>"}',
  '- insert_after       {"action":"insert_after","target":"<section name>","content":"markdown"}',
  '- insert_before      {"action":"insert_before","target":"<section name>","content":"markdown"}',
  '- replace_all        {"action":"replace_all","content":"markdown"}',
  '- create_table       {"action":"create_table","headers":["..."],"rows":[["..."],["..."]]}',
  '- summarize          {"action":"summarize","target":"cursor"|"end"|"<section>","content":"the summary"}',
  '- format_text        {"action":"format_text","target":"selection"|"<section>","format":{"bold":true,"italic":true,"underline":true,"align":"left|center|right|justify","heading":1|2|3,"list":"bullet|number"}}',
  '- create_heading     {"action":"create_heading","level":1|2|3,"content":"heading text"}',
  '- create_list        {"action":"create_list","ordered":true|false,"items":["..."]}',
  '- chat               {"action":"chat","content":"a normal conversational answer"} — use ONLY when the user asks a question and wants no document change.',
  '',
  'CONTENT FORMATTING (STRICT — the document must read like Microsoft Word / Google Docs):',
  '- "content" must be CLEAN, plain article text: a Title line, then paragraphs and subheadings.',
  '- The ONLY markdown allowed in "content" is a leading "#", "##" or "###" to mark Heading 1/2/3 lines.',
  '- Do NOT put Markdown TABLES inside "content". For ANY tabular data use the create_table action.',
  '- Do NOT use LaTeX. No "$...$", no "$$...$$", no "\\text{}", no backslash commands.',
  '  Write mathematics in plain Unicode instead: E = mc², H₂O, CO₂, x², →, ×, ±, ≈.',
  '- Do NOT use code fences (```), ASCII diagrams, or box-drawing characters.',
  '- Do NOT put JSON, key/value dumps, or raw markup inside "content".',
  '- Avoid "**bold**"/"*italic*" markup; write plain sentences (use format_text if emphasis is truly needed).',
  '',
  'These rules apply to EVERY kind of document you generate — articles, essays, letters,',
  'reports, stories, movie/play scripts, presentations/slide decks, outlines, emails, notes —',
  'NEVER just articles. In every case:',
  '- Generate clean, well-structured prose only (the finished document a person would read).',
  '- Do not generate markdown (except leading #/##/### for headings), LaTeX, ASCII diagrams, or JSON inside content.',
  '- Never expose the JSON action wrapper, field names, or braces in "content".',
  '- Formal letter: sender/date/recipient lines, greeting, body paragraphs, closing, signature.',
  '- Essay/report: Title, Introduction, body paragraphs with subheadings, Conclusion.',
  '- Presentation/slide deck: a "##" heading per slide followed by concise bullet lines or short paragraphs.',
  '- Movie/play script: "#" title, "##" scene headings, character names then their dialogue as plain lines.',
  '',
  'Rules:',
  '- Never rewrite the whole document unless the user explicitly asks (then use replace_all).',
  '- Only modify the requested content; leave everything else untouched.',
  '- Preserve existing formatting, tables, images and page layout.',
  '- Support multi-turn editing — treat the conversation as ongoing refinement.',
  '- If text is selected, edit ONLY the selected text (use replace_selection/format_text).',
  '- If a section name is mentioned, edit ONLY that section.',
  '- You may return several actions in order when a request needs multiple steps (e.g. insert_text for prose + create_table for a table).',
  '- Return ONLY valid, COMPLETE JSON. No commentary, no code fences around the JSON.',
].join('\n');

const DEFAULT_MODEL = { gemini: 'gemini-3.6-flash', openai: 'gpt-4o-mini', anthropic: 'claude-opus-4-8' };

function buildUserContent(prompt, text, selection) {
  const parts = [prompt];
  const sel = (selection || '').trim();
  if (sel) {
    const clip = sel.length > 6000 ? `${sel.slice(0, 6000)}\n…[selection truncated]` : sel;
    parts.push(`--- Selected text (edit only this if the instruction is about a selection) ---\n${clip}`);
  }
  const doc = (text || '').trim();
  if (doc) {
    const clipped = doc.length > 24000 ? `${doc.slice(0, 24000)}\n…[document truncated]` : doc;
    parts.push(`--- Current document ---\n${clipped}`);
  }
  return parts.join('\n\n');
}

function normaliseHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((t) => t && typeof t.text === 'string' && t.text.trim())
    .slice(-8)
    .map((t) => ({ role: t.role === 'assistant' || t.role === 'model' ? 'assistant' : 'user', text: t.text.trim() }));
}

function providerError(status, data) {
  const msg = data?.error?.message || data?.message || `Provider returned HTTP ${status}.`;
  const err = new Error(msg);
  err.status = status === 401 || status === 403 ? status : 502;
  return err;
}

async function callGemini({ apiKey, model, system, prompt, text, selection, image, history }) {
  const m = model || DEFAULT_MODEL.gemini;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;
  const contents = normaliseHistory(history).map((t) => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.text }] }));
  const parts = [];
  if (image && image.data) parts.push({ inline_data: { mime_type: image.mimeType || 'image/png', data: image.data } });
  parts.push({ text: buildUserContent(prompt, text, selection) });
  contents.push({ role: 'user', parts });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system || SYSTEM }] },
      contents,
      generationConfig: { maxOutputTokens: 8192, temperature: 0.7 },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw providerError(res.status, data);
  const reply = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('').trim();
  const u = data?.usageMetadata || {};
  return { text: reply || '', model: m, usage: { promptTokens: u.promptTokenCount || 0, outputTokens: u.candidatesTokenCount || 0, totalTokens: u.totalTokenCount || 0 } };
}

async function callOpenAI({ apiKey, model, system, prompt, text, selection, history }) {
  const m = model || DEFAULT_MODEL.openai;
  const messages = [{ role: 'system', content: system || SYSTEM }];
  for (const t of normaliseHistory(history)) messages.push({ role: t.role, content: t.text });
  messages.push({ role: 'user', content: buildUserContent(prompt, text, selection) });
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: m, messages, max_tokens: 8192 }),
  });
  const data = await res.json();
  if (!res.ok) throw providerError(res.status, data);
  const u = data?.usage || {};
  return { text: (data?.choices?.[0]?.message?.content || '').trim(), model: m, usage: { promptTokens: u.prompt_tokens || 0, outputTokens: u.completion_tokens || 0, totalTokens: u.total_tokens || 0 } };
}

async function callAnthropic({ apiKey, model, system, prompt, text, selection, history }) {
  const m = model || DEFAULT_MODEL.anthropic;
  const messages = [];
  for (const t of normaliseHistory(history)) messages.push({ role: t.role, content: t.text });
  messages.push({ role: 'user', content: buildUserContent(prompt, text, selection) });
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: m, max_tokens: 8192, system: system || SYSTEM, messages }),
  });
  const data = await res.json();
  if (!res.ok) throw providerError(res.status, data);
  const u = data?.usage || {};
  return { text: (data?.content?.map((b) => b.text || '').join('') || '').trim(), model: m, usage: { promptTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0, totalTokens: (u.input_tokens || 0) + (u.output_tokens || 0) } };
}

export const PROVIDERS = { gemini: callGemini, openai: callOpenAI, anthropic: callAnthropic };
export { SYSTEM, AGENT_SYSTEM };

/** Pull a JSON value out of a model reply that may be fenced or padded with prose. */
export function extractJson(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch { /* fall through to a bracket scan */ }
  const start = s.search(/[[{]/);
  if (start < 0) return null;
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) depth += 1;
    else if (ch === close) { depth -= 1; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

/** Normalise any JSON shape the model emits into an actions array (or null). */
export function toActions(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value.filter((a) => a && typeof a.action === 'string');
  if (Array.isArray(value.actions)) return value.actions.filter((a) => a && typeof a.action === 'string');
  if (typeof value.action === 'string') return [value];
  return null;
}
