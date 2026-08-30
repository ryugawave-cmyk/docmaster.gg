/**
 * Professional floating Calculator — Normal + Scientific modes.
 *
 * A self-contained, movable/resizable panel opened from Edit → Calculator. It is
 * completely independent of the document/slide: it never reads or writes the
 * model, so it can float over the editor while the user keeps the content in view.
 * The user builds an expression (with parentheses, memory and history) and
 * evaluates it with a dependency-free tokeniser → shunting-yard → RPN evaluator —
 * no `eval`, so it is safe. Scientific mode adds trig / inverse-trig / logs /
 * roots / powers / factorial / |x| / constants and a DEG·RAD switch.
 *
 * Everything here is pure UI + arithmetic; nothing touches the editor's state.
 */
import { el } from '../../workspace/utils/dom.js';

/* ==========================================================================
 *  Expression engine (pure, no DOM) — safe evaluate of a display string.
 * ========================================================================== */

const CONSTS = { PI: Math.PI, e: Math.E };
const FUNCS = new Set(['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'log', 'ln', 'sqrt', 'cbrt', 'abs', 'exp']);
// Binary/unary operator precedence; u- is unary minus, √ (sqrt) and ∛ (cbrt) are
// prefix unary, ! and % are postfix unary.
const PREC = { '+': 2, '-': 2, '*': 3, '/': 3, '^': 4, 'u-': 5, sqrt: 5, cbrt: 5, '!': 6, '%': 6 };
const RIGHT = { '^': true, 'u-': true, sqrt: true, cbrt: true };

/** Translate the pretty display string into a parseable one. `√` and `∛` are kept
 *  as-is and parsed as prefix unary operators (so `√16` needs no parentheses). */
function normaliseExpr(expr) {
  return String(expr)
    .replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-')
    .replace(/π/g, 'PI');
}

function tokenize(s) {
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ') { i += 1; continue; }
    // Number (with optional uppercase-E scientific exponent).
    if (/[0-9.]/.test(c)) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:E[+-]?\d+)?/.exec(s.slice(i));
      if (!m) throw new Error('number');
      tokens.push({ type: 'num', value: parseFloat(m[0]) });
      i += m[0].length;
      continue;
    }
    // Identifier: a function name or a constant (PI / e).
    if (/[a-zA-Z]/.test(c)) {
      const m = /^[a-zA-Z]+/.exec(s.slice(i));
      const name = m[0];
      if (FUNCS.has(name)) tokens.push({ type: 'func', value: name });
      else if (name in CONSTS) tokens.push({ type: 'const', value: name });
      else throw new Error(`unknown ${name}`);
      i += name.length;
      continue;
    }
    if ('+-*/^'.includes(c)) { tokens.push({ type: 'op', value: c }); i += 1; continue; }
    if (c === '!' || c === '%') { tokens.push({ type: 'op', value: c }); i += 1; continue; }
    // √ / ∛ are prefix unary operators (no parentheses needed): √16 → 4.
    if (c === '√' || c === '∛') { tokens.push({ type: 'op', value: c === '√' ? 'sqrt' : 'cbrt' }); i += 1; continue; }
    if (c === '(') { tokens.push({ type: 'lparen' }); i += 1; continue; }
    if (c === ')') { tokens.push({ type: 'rparen' }); i += 1; continue; }
    throw new Error(`bad char ${c}`);
  }
  return tokens;
}

function toRPN(tokens) {
  const out = [];
  const ops = [];
  let prev = null; // 'val' | 'op' | '(' | 'func'
  for (const t of tokens) {
    if (t.type === 'num' || t.type === 'const') { out.push(t); prev = 'val'; continue; }
    if (t.type === 'func') { ops.push(t); prev = 'func'; continue; }
    if (t.type === 'lparen') { ops.push(t); prev = '('; continue; }
    if (t.type === 'rparen') {
      while (ops.length && ops[ops.length - 1].type !== 'lparen') out.push(ops.pop());
      if (!ops.length) throw new Error('mismatched )');
      ops.pop();
      if (ops.length && ops[ops.length - 1].type === 'func') out.push(ops.pop());
      prev = 'val';
      continue;
    }
    // operator
    let op = t.value;
    if ((op === '-' || op === '+') && (prev === null || prev === 'op' || prev === '(' || prev === 'func')) {
      if (op === '+') { prev = 'op'; continue; }   // unary plus is a no-op
      op = 'u-';
    }
    while (ops.length) {
      const top = ops[ops.length - 1];
      if (top.type === 'func') { out.push(ops.pop()); continue; }
      if (top.type === 'op') {
        const better = RIGHT[op] ? PREC[op] < PREC[top.value] : PREC[op] <= PREC[top.value];
        if (better) { out.push(ops.pop()); continue; }
      }
      break;
    }
    ops.push({ type: 'op', value: op });
    prev = (op === '!' || op === '%') ? 'val' : 'op';
  }
  while (ops.length) {
    const top = ops.pop();
    if (top.type === 'lparen') throw new Error('mismatched (');
    out.push(top);
  }
  return out;
}

function factorial(n) {
  if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) return NaN;
  let r = 1;
  for (let k = 2; k <= n; k += 1) r *= k;
  return r;
}

function applyFunc(name, a, deg) {
  const toRad = deg ? Math.PI / 180 : 1;
  const fromRad = deg ? 180 / Math.PI : 1;
  switch (name) {
    case 'sin': return Math.sin(a * toRad);
    case 'cos': return Math.cos(a * toRad);
    case 'tan': return Math.tan(a * toRad);
    case 'asin': return Math.asin(a) * fromRad;
    case 'acos': return Math.acos(a) * fromRad;
    case 'atan': return Math.atan(a) * fromRad;
    case 'log': return Math.log10(a);
    case 'ln': return Math.log(a);
    case 'sqrt': return Math.sqrt(a);
    case 'cbrt': return Math.cbrt(a);
    case 'abs': return Math.abs(a);
    case 'exp': return Math.exp(a);
    default: return NaN;
  }
}

function evalRPN(rpn, deg) {
  const st = [];
  for (const t of rpn) {
    if (t.type === 'num') { st.push(t.value); continue; }
    if (t.type === 'const') { st.push(CONSTS[t.value]); continue; }
    if (t.type === 'func') { st.push(applyFunc(t.value, st.pop(), deg)); continue; }
    const o = t.value;
    if (o === 'u-') { st.push(-st.pop()); continue; }
    if (o === 'sqrt') { st.push(Math.sqrt(st.pop())); continue; }
    if (o === 'cbrt') { st.push(Math.cbrt(st.pop())); continue; }
    if (o === '!') { st.push(factorial(st.pop())); continue; }
    if (o === '%') { st.push(st.pop() / 100); continue; }
    const b = st.pop();
    const a = st.pop();
    st.push(o === '+' ? a + b : o === '-' ? a - b : o === '*' ? a * b
      : o === '/' ? a / b : o === '^' ? Math.pow(a, b) : NaN);
  }
  if (st.length !== 1) throw new Error('bad expression');
  return st[0];
}

/** Evaluate a display expression → number, or null if it isn't valid. Auto-closes
 *  any unbalanced opening parentheses so a mid-typing preview still resolves. */
function evaluate(expr, deg) {
  const raw = String(expr).trim();
  if (!raw) return null;
  try {
    let s = normaliseExpr(raw);
    const opens = (s.match(/\(/g) || []).length;
    const closes = (s.match(/\)/g) || []).length;
    if (opens > closes) s += ')'.repeat(opens - closes);
    const v = evalRPN(toRPN(tokenize(s)), deg);
    return typeof v === 'number' && !Number.isNaN(v) ? v : null;
  } catch {
    return null;
  }
}

/** Human-friendly number formatting: trims FP noise, uses exponential for extremes. */
function fmt(n) {
  if (n === null || n === undefined) return '';
  if (!Number.isFinite(n)) return n > 0 ? '∞' : '-∞';
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e15 || abs < 1e-9) return n.toExponential(9).replace(/\.?0+e/i, 'e').replace('e', 'E');
  const rounded = Math.round(n * 1e12) / 1e12;
  return String(rounded);
}

/* ==========================================================================
 *  Session state (persists while the page is open, like a real calc app).
 * ========================================================================== */

let singleton = null;                 // the currently-open panel controller
const history = [];                   // { expr, result } — newest last
let memory = 0;

/* ==========================================================================
 *  Panel
 * ========================================================================== */

export function openCalculator() {
  if (singleton) { singleton.focus(); return singleton; }

  let expr = '';
  let justEvaluated = false;          // last action was '=' → next digit starts fresh
  let deg = true;                     // DEG (true) / RAD (false)
  let mode = 'normal';                // 'normal' | 'scientific'
  let showHistory = false;

  /* ---- display ---- */
  const exprEl = el('div', { class: 'calc__expr', 'aria-live': 'polite' }, '0');
  const previewEl = el('div', { class: 'calc__preview' }, '');
  const memBadge = el('span', { class: 'calc__badge', hidden: true }, 'M');
  const angBadge = el('span', { class: 'calc__badge calc__badge--ang' }, 'DEG');
  const copyBtn = el('button', {
    class: 'calc__copy', type: 'button', title: 'Copy result', 'aria-label': 'Copy result',
    onClick: copyResult,
  }, '⧉');

  function render() {
    exprEl.textContent = expr || '0';
    exprEl.scrollLeft = exprEl.scrollWidth;
    if (justEvaluated) { previewEl.textContent = ''; } else {
      const v = evaluate(expr, deg);
      previewEl.textContent = v === null ? '' : `= ${fmt(v)}`;
    }
    memBadge.hidden = !memory;
    angBadge.textContent = deg ? 'DEG' : 'RAD';
  }

  /* ---- input handling ---- */
  // kind: num | const | binop | postfix | func | paren | dot | exp
  function feed(tok, kind) {
    if (justEvaluated) {
      justEvaluated = false;
      if (kind === 'num' || kind === 'const' || kind === 'dot') expr = '';
      else if (kind === 'func' || kind === 'prefix') { expr = tok + expr; render(); return; }   // apply to the result, e.g. sin(<result> or √<result>
      else if (kind === 'paren' && tok === '(') expr = '';
      // binop / postfix / exp keep the result as the running operand
    }
    expr += tok;
    render();
  }
  function clearAll() { expr = ''; justEvaluated = false; render(); }
  function backspace() {
    if (justEvaluated) { justEvaluated = false; }
    expr = expr.slice(0, -1);
    render();
  }
  function toggleSign() {
    justEvaluated = false;
    const wrapped = /\(-(\d*\.?\d+(?:E[+-]?\d+)?)\)$/.exec(expr);
    if (wrapped) { expr = expr.slice(0, wrapped.index) + wrapped[1]; render(); return; }
    const num = /(\d*\.?\d+(?:E[+-]?\d+)?)$/.exec(expr);
    if (num) { expr = `${expr.slice(0, num.index)}(-${num[1]})`; render(); return; }
    // Nothing to negate yet → start a negative.
    expr += '-';
    render();
  }
  function equals() {
    const v = evaluate(expr, deg);
    if (v === null) { previewEl.textContent = 'Error'; return; }
    const out = fmt(v);
    history.push({ expr, result: out });
    if (history.length > 100) history.shift();
    expr = out;
    justEvaluated = true;
    render();
    renderHistory();
  }
  function currentValue() {
    if (justEvaluated) return evaluate(expr, deg);
    return evaluate(expr, deg);
  }
  async function copyResult() {
    const v = currentValue();
    const text = v === null ? (expr || '') : fmt(v);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.classList.add('is-copied');
      setTimeout(() => copyBtn.classList.remove('is-copied'), 900);
    } catch { /* clipboard blocked — silently ignore */ }
  }

  /* ---- memory ---- */
  function memClear() { memory = 0; render(); }
  function memRecall() { const s = fmt(memory); feed(s, 'num'); }
  function memAdd() { const v = currentValue(); if (v !== null) { memory += v; render(); } }
  function memSub() { const v = currentValue(); if (v !== null) { memory -= v; render(); } }

  /* ---- keypad definitions ----
   * Each key: { t: label, k: kind|action, tok?, cls? }. `k` is either a token
   * "kind" (fed into the expression) or a named action handled in press().     */
  const NUM = (d) => ({ t: d, k: 'num', tok: d, cls: 'num' });
  const OP = (t, tok, cls) => ({ t, k: 'binop', tok, cls: cls || 'op' });
  const FN = (t, tok) => ({ t, k: 'func', tok, cls: 'fn' });
  const PRE = (t, tok) => ({ t, k: 'prefix', tok, cls: 'fn' });   // e.g. √ / ∛ — no bracket
  const POST = (t, tok) => ({ t, k: 'postfix', tok, cls: 'fn' });
  const ACT = (t, act, cls) => ({ t, k: act, cls });

  // Scientific rows (shown only in Scientific mode), 5 columns.
  const paren = (t) => ({ t, k: 'paren', tok: t, cls: 'util' });
  const konst = (t) => ({ t, k: 'const', tok: t, cls: 'fn' });
  const dot = () => ({ t: '.', k: 'dot', tok: '.', cls: 'num' });

  // Normal mode — a compact 4-column pad: numbers, basic operators, parentheses,
  // percent, sign, backspace/clear and the memory row.
  const baseKeys = () => [
    ACT('MC', 'memClear', 'mem'), ACT('MR', 'memRecall', 'mem'), ACT('M+', 'memAdd', 'mem'), ACT('M−', 'memSub', 'mem'),
    ACT('C', 'clear', 'util'), ACT('⌫', 'back', 'util'), paren('('), paren(')'),
    NUM('7'), NUM('8'), NUM('9'), OP('÷', '÷'),
    NUM('4'), NUM('5'), NUM('6'), OP('×', '×'),
    NUM('1'), NUM('2'), NUM('3'), OP('−', '−'),
    ACT('±', 'sign', 'util'), NUM('0'), dot(), OP('+', '+'),
    POST('%', '%'), ACT('=', 'equals', 'eq wide'),
  ];
  // Scientific mode — ONE wide 7-column landscape grid so every key is visible at
  // once (no scrolling / cut-off). Scientific functions fill the left 3 columns,
  // the standard number/operator pad the right 4, and '=' spans the last 4 cells.
  const sciKeys = () => [
    FN('sin', 'sin('), FN('cos', 'cos('), FN('tan', 'tan('), ACT('MC', 'memClear', 'mem'), ACT('MR', 'memRecall', 'mem'), ACT('M+', 'memAdd', 'mem'), ACT('M−', 'memSub', 'mem'),
    FN('sin⁻¹', 'asin('), FN('cos⁻¹', 'acos('), FN('tan⁻¹', 'atan('), ACT('C', 'clear', 'util'), ACT('⌫', 'back', 'util'), paren('('), paren(')'),
    FN('ln', 'ln('), FN('log', 'log('), PRE('√', '√'), NUM('7'), NUM('8'), NUM('9'), OP('÷', '÷'),
    POST('x²', '^2'), POST('x³', '^3'), POST('xʸ', '^'), NUM('4'), NUM('5'), NUM('6'), OP('×', '×'),
    PRE('∛', '∛'), POST('1/x', '^(-1)'), POST('n!', '!'), NUM('1'), NUM('2'), NUM('3'), OP('−', '−'),
    konst('π'), konst('e'), ACT('EXP', 'exp10', 'fn'), ACT('±', 'sign', 'util'), NUM('0'), dot(), OP('+', '+'),
    ACT(deg ? 'DEG' : 'RAD', 'toggleAngle', 'fn mode'), FN('|x|', 'abs('), POST('%', '%'), ACT('=', 'equals', 'eq wide4'),
  ];

  function press(key) {
    switch (key.k) {
      case 'clear': clearAll(); break;
      case 'back': backspace(); break;
      case 'sign': toggleSign(); break;
      case 'equals': equals(); break;
      case 'toggleAngle': deg = !deg; render(); break;
      case 'exp10': feed('E', 'exp'); break;
      case 'memClear': memClear(); break;
      case 'memRecall': memRecall(); break;
      case 'memAdd': memAdd(); break;
      case 'memSub': memSub(); break;
      default: feed(key.tok, key.k); break;   // num/const/binop/postfix/func/paren/dot
    }
    panel.focus({ preventScroll: true });
  }

  const sciPad = el('div', { class: 'calc__keys calc__keys--sci7' });
  const basePad = el('div', { class: 'calc__keys calc__keys--base' });
  function renderKeys() {
    const sci = mode === 'scientific';
    sciPad.replaceChildren(...sciKeys().map(keyButton));
    basePad.replaceChildren(...baseKeys().map(keyButton));
    // Only one pad is shown per mode — the scientific grid already contains the
    // full number/operator pad, so the separate base pad is hidden in Scientific.
    sciPad.hidden = !sci;
    basePad.hidden = sci;
  }
  function keyButton(key) {
    const mods = key.cls.split(/\s+/).filter(Boolean).map((c) => `calc__key--${c}`).join(' ');
    return el('button', {
      class: `calc__key ${mods}`, type: 'button', tabindex: -1, onClick: () => press(key),
    }, key.t);
  }

  /* ---- history ---- */
  const historyList = el('div', { class: 'calc__histlist' });
  const historyWrap = el('div', { class: 'calc__history', hidden: true }, [
    el('div', { class: 'calc__histhead' }, [
      el('span', {}, 'History'),
      el('button', {
        class: 'calc__histclear', type: 'button', onClick: () => { history.length = 0; renderHistory(); },
      }, 'Clear'),
    ]),
    historyList,
  ]);
  function renderHistory() {
    if (!showHistory) return;
    if (!history.length) {
      historyList.replaceChildren(el('div', { class: 'calc__histempty' }, 'No calculations yet.'));
      return;
    }
    // Newest first; clicking a row drops its result back into the expression.
    historyList.replaceChildren(...[...history].reverse().map((h) => el('button', {
      class: 'calc__histrow', type: 'button', title: 'Use this result',
      onClick: () => { justEvaluated = true; expr = h.result; render(); panel.focus({ preventScroll: true }); },
    }, [
      el('span', { class: 'calc__histexpr' }, h.expr),
      el('span', { class: 'calc__histres' }, `= ${h.result}`),
    ])));
  }

  /* ---- mode switch + header ---- */
  const modeBtns = ['normal', 'scientific'].map((m) => el('button', {
    class: `calc__mode${m === mode ? ' is-on' : ''}`, type: 'button', 'data-mode': m,
    onClick: () => setMode(m),
  }, m === 'normal' ? 'Normal' : 'Scientific'));
  function setMode(m) {
    mode = m;
    for (const b of modeBtns) b.classList.toggle('is-on', b.dataset.mode === m);
    panel.classList.toggle('calc--sci', m === 'scientific');
    // DEG/RAD only matters for trig, which lives in Scientific mode — hide the
    // angle badge in Normal so it stays a plain calculator.
    angBadge.hidden = m !== 'scientific';
    renderKeys();
  }
  const histToggle = el('button', {
    class: 'calc__icon', type: 'button', title: 'Calculation history', 'aria-label': 'Toggle history',
    onClick: () => {
      showHistory = !showHistory;
      historyWrap.hidden = !showHistory;
      histToggle.classList.toggle('is-on', showHistory);
      renderHistory();
    },
  }, '🕘');

  const header = el('div', { class: 'calc__head' }, [
    el('div', { class: 'calc__title' }, 'Calculator'),
    el('div', { class: 'calc__modes', role: 'tablist', 'aria-label': 'Calculator mode' }, modeBtns),
    el('div', { class: 'calc__headtools' }, [
      histToggle,
      el('button', { class: 'calc__icon calc__close', type: 'button', title: 'Close', 'aria-label': 'Close', onClick: close }, '×'),
    ]),
  ]);

  const panel = el('div', {
    class: 'calc', role: 'dialog', 'aria-label': 'Calculator', tabindex: 0,
    onKeydown: onKey,
  }, [
    header,
    el('div', { class: 'calc__display' }, [
      el('div', { class: 'calc__badges' }, [memBadge, angBadge]),
      exprEl,
      el('div', { class: 'calc__displayfoot' }, [previewEl, copyBtn]),
    ]),
    sciPad,
    basePad,
    historyWrap,
  ]);

  /* ---- keyboard (scoped to the panel; never reaches the document) ---- */
  function onKey(e) {
    // Stop everything from bubbling to the app's global keyboard manager so the
    // calculator can't disturb the document even while it holds focus.
    const k = e.key;
    let handled = true;
    if (/^[0-9]$/.test(k)) feed(k, 'num');
    else if (k === '.') feed('.', 'dot');
    else if (k === '+') feed('+', 'binop');
    else if (k === '-') feed('−', 'binop');
    else if (k === '*') feed('×', 'binop');
    else if (k === '/') { e.preventDefault(); feed('÷', 'binop'); }
    else if (k === '^') feed('^', 'binop');
    else if (k === '(' || k === ')') feed(k, 'paren');
    else if (k === '%') feed('%', 'postfix');
    else if (k === '!') feed('!', 'postfix');
    else if (k === 'Enter' || k === '=') { e.preventDefault(); equals(); }
    else if (k === 'Backspace') backspace();
    else if (k === 'Escape') close();
    else handled = false;
    if (handled) { e.stopPropagation(); }
  }

  /* ---- movable + resizable, clamped to the viewport ---- */
  const clampInView = () => {
    const r = panel.getBoundingClientRect();
    const keep = 52;
    const headH = header.offsetHeight || 48;
    let left = parseFloat(panel.style.left);
    let top = parseFloat(panel.style.top);
    if (Number.isNaN(left)) left = r.left;
    if (Number.isNaN(top)) top = r.top;
    left = Math.min(window.innerWidth - keep, Math.max(keep - r.width, left));
    top = Math.min(Math.max(0, window.innerHeight - headH), Math.max(0, top));
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
    panel.style.right = 'auto';
  };
  let drag = null;
  header.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.calc__icon, .calc__mode')) return;
    const r = panel.getBoundingClientRect();
    panel.style.left = `${r.left}px`;
    panel.style.top = `${r.top}px`;
    panel.style.right = 'auto';
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    panel.classList.add('is-dragging');
    header.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });
  header.addEventListener('pointermove', (e) => {
    if (!drag) return;
    panel.style.left = `${e.clientX - drag.dx}px`;
    panel.style.top = `${e.clientY - drag.dy}px`;
    clampInView();
  });
  const endDrag = (e) => {
    if (!drag) return;
    drag = null;
    panel.classList.remove('is-dragging');
    header.releasePointerCapture?.(e.pointerId);
  };
  header.addEventListener('pointerup', endDrag);
  header.addEventListener('pointercancel', endDrag);
  const onResize = () => clampInView();
  window.addEventListener('resize', onResize);

  function close() {
    window.removeEventListener('resize', onResize);
    panel.remove();
    if (singleton && singleton.element === panel) singleton = null;
  }
  function focus() { panel.focus({ preventScroll: true }); }

  setMode(mode);
  renderKeys();
  render();
  renderHistory();
  document.body.appendChild(panel);
  clampInView();
  focus();

  singleton = { close, focus, element: panel };
  return singleton;
}
