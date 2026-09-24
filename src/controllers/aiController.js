'use strict';

const config = require('../config');
const creditsService = require('../services/credits');
const creditStore = require('../services/creditStore');
const creditsConfig = require('../config/credits');

/**
 * AI Assistant proxy (LOCAL / server-side).
 *
 * The browser never holds the API key. The document editor's assistant POSTs
 * { prompt, text } to /api/ai/chat; this controller forwards the request to the
 * configured provider using the key from the server environment (config.ai) and
 * returns { reply }. Swapping providers is a `.env` change (AI_PROVIDER), not a
 * code change on the client.
 *
 * Two shapes of reply:
 *   - plain chat (default)        → { reply: "<text>" }
 *   - document agent (mode:agent) → { actions: [ { action, ... } ] }, i.e. a list
 *     of structured edits the editor executes on the page (create/replace/delete/
 *     format sections, tables, lists…). This is the "DocMaster AI" editing agent —
 *     conversational, Nano-Banana-style, but for documents.
 *
 * Supported providers: gemini (default), openai, anthropic. Uses Node's global
 * fetch (Node 18+). Kept deliberately small — this is a testing bridge, not a
 * production gateway (that would live in the Cloudflare Worker at /api/ai/*).
 */

// System instruction for plain conversational replies.
const SYSTEM = [
  'You are the AI writing assistant embedded in a document editor.',
  'The user is editing a document; when they share its text, help with that text.',
  'Be concise and practical. Return plain text (no markdown fences) unless asked.',
].join(' ');

// System instruction for the document-EDITING agent. It turns natural-language
// instructions into a JSON action list the editor executes on the live page.
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

// Default model per provider when AI_MODEL is not set in the environment.
const DEFAULT_MODEL = {
  gemini: 'gemini-3.6-flash',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-opus-4-8',
};

/** Compose the user turn: the instruction plus the current document + selection
 *  so the agent can target sections and edit selected text precisely. */
function buildUserContent(prompt, text, selection) {
  const parts = [prompt];
  const sel = (selection || '').trim();
  if (sel) {
    const clip = sel.length > 6000 ? `${sel.slice(0, 6000)}\n…[selection truncated]` : sel;
    parts.push(`--- Selected text (edit only this if the instruction is about a selection) ---\n${clip}`);
  }
  const doc = (text || '').trim();
  if (doc) {
    // Cap the document context so a huge doc can't blow past request limits.
    const clipped = doc.length > 24000 ? `${doc.slice(0, 24000)}\n…[document truncated]` : doc;
    parts.push(`--- Current document ---\n${clipped}`);
  }
  return parts.join('\n\n');
}

/** Normalise the client's short conversation history into provider-neutral turns.
 *  Each turn is { role: 'user'|'assistant', text }. Capped so requests stay small. */
function normaliseHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((t) => t && typeof t.text === 'string' && t.text.trim())
    .slice(-8)
    .map((t) => ({ role: t.role === 'assistant' || t.role === 'model' ? 'assistant' : 'user', text: t.text.trim() }));
}

async function callGemini({ apiKey, model, system, prompt, text, selection, image, history }) {
  const m = model || DEFAULT_MODEL.gemini;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;
  const contents = normaliseHistory(history).map((t) => ({
    role: t.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: t.text }],
  }));
  // Multimodal: prepend the uploaded document image so the model can read/recreate it.
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
      // A full article wrapped in a JSON action needs headroom; too small a cap
      // truncates the JSON so it can't be parsed (was dumping raw JSON into the doc).
      generationConfig: { maxOutputTokens: 8192, temperature: 0.7 },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw providerError(res.status, data);
  const reply = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('').trim();
  const u = data?.usageMetadata || {};
  return {
    text: reply || '',
    model: m,
    usage: {
      promptTokens: u.promptTokenCount || 0,
      outputTokens: u.candidatesTokenCount || 0,
      totalTokens: u.totalTokenCount || 0,
    },
  };
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
  return {
    text: (data?.choices?.[0]?.message?.content || '').trim(),
    model: m,
    usage: {
      promptTokens: u.prompt_tokens || 0,
      outputTokens: u.completion_tokens || 0,
      totalTokens: u.total_tokens || 0,
    },
  };
}

async function callAnthropic({ apiKey, model, system, prompt, text, selection, history }) {
  const m = model || DEFAULT_MODEL.anthropic;
  const messages = [];
  for (const t of normaliseHistory(history)) messages.push({ role: t.role, content: t.text });
  messages.push({ role: 'user', content: buildUserContent(prompt, text, selection) });
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: m,
      max_tokens: 8192,
      system: system || SYSTEM,
      messages,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw providerError(res.status, data);
  const u = data?.usage || {};
  return {
    text: (data?.content?.map((b) => b.text || '').join('') || '').trim(),
    model: m,
    usage: {
      promptTokens: u.input_tokens || 0,
      outputTokens: u.output_tokens || 0,
      totalTokens: (u.input_tokens || 0) + (u.output_tokens || 0),
    },
  };
}

const PROVIDERS = { gemini: callGemini, openai: callOpenAI, anthropic: callAnthropic };

/** Normalise an upstream provider failure into an Error with a status + message. */
function providerError(status, data) {
  const msg = data?.error?.message || data?.message || `Provider returned HTTP ${status}.`;
  const err = new Error(msg);
  err.status = status === 401 || status === 403 ? status : 502;
  return err;
}

/** Pull a JSON value out of a model reply that may be fenced or padded with prose.
 *  Returns the parsed value, or null when nothing JSON-shaped is found. */
function extractJson(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  // Strip a leading ```json / ``` fence if the model wrapped its output.
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch { /* fall through to a bracket scan */ }
  // Otherwise grab the first balanced {...} or [...] span and try that. The scan is
  // STRING-AWARE: braces inside a JSON string value (e.g. LaTeX "\\text{}") must not
  // be counted, or the depth maths breaks and we mis-slice the object.
  const start = s.search(/[[{]/);
  if (start < 0) return null;
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) depth += 1;
    else if (ch === close) { depth -= 1; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

/** Normalise any of the JSON shapes the model might emit into an actions array:
 *  a bare array, { actions: [...] }, or a single { action, ... } object. */
function toActions(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value.filter((a) => a && typeof a.action === 'string');
  if (Array.isArray(value.actions)) return value.actions.filter((a) => a && typeof a.action === 'string');
  if (typeof value.action === 'string') return [value];
  return null;
}

exports.chat = async (req, res) => {
  // By the time we get here the credit middleware has: confirmed AI is enabled,
  // validated the payload, identified req.user, and RESERVED credits (req.credit).
  const prompt = req.body.prompt.trim();
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  const selection = typeof req.body?.selection === 'string' ? req.body.selection : '';
  const history = req.body?.history;
  const agent = req.body?.mode === 'agent';
  // Optional document image (base64) for the "recreate as editable" flow.
  const img = req.body?.image;
  const image = img && typeof img.data === 'string' && img.data
    ? { mimeType: typeof img.mimeType === 'string' ? img.mimeType : 'image/png', data: img.data }
    : null;

  const provider = PROVIDERS[config.ai.provider];
  if (!provider) {
    // Reserved credits are refunded — the request never reached a model.
    const credits = creditsService.refundFailed(req.user, req.credit, 'unknown_provider');
    return res.status(500).json({ error: `Unknown AI_PROVIDER "${config.ai.provider}".`, credits });
  }

  // --- Provider call: ONLY a genuine provider failure here refunds credits. ---
  let result;
  try {
    result = await provider({
      apiKey: config.ai.apiKey,
      model: config.ai.model,
      system: agent ? AGENT_SYSTEM : SYSTEM,
      prompt, text, selection, image, history,
    });
  } catch (err) {
    // The AI call failed — the user received nothing, so refund the reservation.
    console.error('[AI proxy] request failed:', err.message);
    const credits = creditsService.refundFailed(req.user, req.credit, 'ai_request_failed');
    return res.status(err.status || 502).json({ error: err.message || 'AI request failed.', credits });
  }

  // --- Settlement: the model DID respond, so the request is delivered. Logging /
  // ledger errors here must NEVER refund a request the user actually received.
  // (Separated from the provider try/catch above so a finalize failure can't fall
  // through into the refund path.)
  const raw = result.text;
  let credits;
  try {
    credits = creditsService.finalize(req.user, {
      action: req.credit.action,
      cost: req.credit.cost,
      model: result.model,
      usage: result.usage,
    });
  } catch (err) {
    // Best-effort audit only: the charge already stands (deducted at reserve time);
    // report the post-deduction balance and do NOT refund a delivered response.
    console.error('[AI proxy] usage settlement failed (response still delivered):', err.message);
    credits = req.credit.balanceAfter;
  }

  // What this request actually cost — surfaced so the client can show
  // "N credits used · M remaining" and which task it was billed as.
  const charged = req.credit.cost;
  const action = req.credit.action;
  const actionLabel = creditsConfig.getActionLabel(action);
  const meta = { provider: config.ai.provider, credits, charged, action, actionLabel };

  if (agent) {
    // Parse the structured edit list. If the model didn't return JSON, hand the
    // raw text back so the client can degrade gracefully (insert it as content).
    const actions = toActions(extractJson(raw));
    if (actions && actions.length) return res.json({ actions, ...meta });
    // Couldn't parse a complete action list (often a truncated JSON reply). Flag it
    // so the client shows a friendly retry message and NEVER inserts the raw JSON.
    const looksJson = /^\s*[[{]/.test(raw || '') || /"action"\s*:/.test(raw || '');
    if (looksJson) return res.json({ error: 'The AI response was incomplete — please try again.', incomplete: true, ...meta });
    return res.json({ reply: raw || 'The model returned an empty response.', ...meta });
  }
  return res.json({ reply: raw || 'The model returned an empty response.', ...meta });
};

/**
 * Estimate the credit cost of a request BEFORE running it, so the UI can show
 * "This action will use approximately N credits." Uses the same server-side
 * resolver as the real charge, so the estimate always equals the actual cost.
 * Reads the balance too, so the client knows if the user can afford it.
 */
exports.estimate = (req, res) => {
  const resolved = creditsConfig.resolveTask({ prompt: req.body?.prompt, action: req.body?.action });
  if (!resolved.ok) {
    return res.status(400).json({ error: `Unknown AI action "${resolved.action}".`, code: 'UNKNOWN_ACTION' });
  }
  const account = creditStore.getAccount(req.user.id, req.user.email);
  return res.json({
    action: resolved.action,
    actionLabel: creditsConfig.getActionLabel(resolved.action),
    cost: resolved.cost,
    credits: account.credits,
    plan: account.plan,
    sufficient: account.credits >= resolved.cost,
  });
};

/**
 * The task/price catalogue for the "AI Credit Usage" info modal. No auth or
 * deduction — it's public business info shown on the Pricing page and AI panel.
 */
exports.creditInfo = (_req, res) => {
  return res.json(creditsConfig.creditInfo());
};

/**
 * Read-only balance for the header credit badge. Identifies the caller (attachUser
 * middleware) and returns their current balance + plan. This does NOT deduct,
 * refund, or otherwise change credit logic — it only reads the wallet.
 */
exports.credits = (req, res) => {
  const account = creditStore.getAccount(req.user.id, req.user.email);
  const plan = creditsConfig.getPlan(account.plan);
  return res.json({
    credits: account.credits,
    plan: account.plan,
    planLabel: plan.label,
    monthlyCredits: plan.monthlyCredits,
    resetAt: account.resetAt || null,      // when the balance next refills (ISO)
    resetDays: creditsConfig.RESET_INTERVAL_DAYS,
  });
};
