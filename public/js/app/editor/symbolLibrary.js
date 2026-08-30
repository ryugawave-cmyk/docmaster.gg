/**
 * Math & Science Symbol Library — a floating, searchable Unicode symbol picker.
 *
 * Opened from Edit → Symbol. A self-contained, movable panel (styled to match the
 * Calculator) that never reads or writes the document model directly: it hands each
 * chosen glyph back to the editor through an `insert(char)` callback so the symbol
 * lands at the live caret without disturbing existing formatting. It offers search
 * by name, a category rail, a scrollable grid, Recently Used and Favorites (both
 * persisted in localStorage), so students, teachers, researchers and engineers can
 * find any operator, Greek letter, relation, arrow, physics/chemistry/unit glyph…
 *
 * The tiles use pointerdown/mousedown preventDefault so clicking a symbol never
 * steals the editor's selection — the caret stays put and the glyph is inserted
 * exactly where it was. Everything here is pure UI; nothing touches editor state.
 */
import { el } from '../../workspace/utils/dom.js';

/* ==========================================================================
 *  Symbol data — grouped from basic arithmetic to advanced science. Each entry
 *  is [glyph, searchName]; names drive the search box and the tile tooltip.
 * ========================================================================== */

const CATEGORIES = [
  ['Basic Arithmetic', [
    ['+', 'plus'], ['−', 'minus'], ['×', 'times multiply'], ['÷', 'divide obelus'],
    ['=', 'equals'], ['≠', 'not equal'], ['±', 'plus minus'], ['∓', 'minus plus'],
    ['·', 'dot multiplication'], ['∗', 'asterisk operator'], ['%', 'percent'], ['‰', 'per mille'],
    ['′', 'prime feet minutes'], ['″', 'double prime inches seconds'], ['⁄', 'fraction slash'],
  ]],
  ['Algebra', [
    ['a', 'variable a'], ['x', 'variable x'], ['y', 'variable y'], ['n', 'variable n'],
    ['⁻¹', 'inverse superscript minus one'], ['²', 'squared superscript two'], ['³', 'cubed superscript three'],
    ['ⁿ', 'superscript n'], ['ₙ', 'subscript n'], ['ₓ', 'subscript x'],
    ['√', 'square root radical'], ['∛', 'cube root'], ['∜', 'fourth root'],
    ['∝', 'proportional to'], ['∞', 'infinity'], ['∴', 'therefore'], ['∵', 'because'], ['∎', 'end of proof qed'],
  ]],
  ['Fractions & Powers', [
    ['½', 'one half'], ['⅓', 'one third'], ['⅔', 'two thirds'], ['¼', 'one quarter'], ['¾', 'three quarters'],
    ['⅕', 'one fifth'], ['⅖', 'two fifths'], ['⅗', 'three fifths'], ['⅘', 'four fifths'],
    ['⅙', 'one sixth'], ['⅛', 'one eighth'], ['⅜', 'three eighths'], ['⅝', 'five eighths'], ['⅞', 'seven eighths'],
    ['⁰', 'superscript zero'], ['¹', 'superscript one'], ['⁴', 'superscript four'], ['⁵', 'superscript five'],
    ['⁶', 'superscript six'], ['⁷', 'superscript seven'], ['⁸', 'superscript eight'], ['⁹', 'superscript nine'],
    ['ⁱ', 'superscript i'], ['⁺', 'superscript plus'], ['⁻', 'superscript minus'],
    ['₀', 'subscript zero'], ['₁', 'subscript one'], ['₂', 'subscript two'], ['₃', 'subscript three'],
    ['₄', 'subscript four'], ['₊', 'subscript plus'], ['₋', 'subscript minus'],
  ]],
  ['Calculus', [
    ['∫', 'integral'], ['∬', 'double integral'], ['∭', 'triple integral'],
    ['∮', 'contour integral'], ['∯', 'surface integral'], ['∰', 'volume integral'],
    ['∂', 'partial derivative'], ['∇', 'nabla del gradient'], ['′', 'prime derivative'], ['″', 'double prime'], ['‴', 'triple prime'],
    ['ⅆ', 'differential d'], ['∆', 'delta change increment'], ['dx', 'differential dx'], ['dy', 'differential dy'],
    ['lim', 'limit'], ['∑', 'summation sum'], ['∏', 'product'], ['∐', 'coproduct'],
  ]],
  ['Trigonometry', [
    ['sin', 'sine'], ['cos', 'cosine'], ['tan', 'tangent'], ['cot', 'cotangent'], ['sec', 'secant'], ['csc', 'cosecant'],
    ['sin⁻¹', 'arcsine inverse sine'], ['cos⁻¹', 'arccosine'], ['tan⁻¹', 'arctangent'],
    ['sinh', 'hyperbolic sine'], ['cosh', 'hyperbolic cosine'], ['tanh', 'hyperbolic tangent'],
    ['°', 'degree'], ['∠', 'angle'], ['∡', 'measured angle'], ['∢', 'spherical angle'],
    ['θ', 'theta angle'], ['φ', 'phi angle'], ['π', 'pi'], ['τ', 'tau'],
  ]],
  ['Geometry', [
    ['∠', 'angle'], ['∟', 'right angle'], ['⊾', 'right angle with arc'], ['⦜', 'right angle variant'],
    ['△', 'triangle'], ['▷', 'triangle right'], ['□', 'square'], ['▭', 'rectangle'], ['○', 'circle'], ['⬠', 'pentagon'], ['⬡', 'hexagon'],
    ['∥', 'parallel'], ['∦', 'not parallel'], ['⊥', 'perpendicular'], ['≅', 'congruent'], ['≌', 'all equal to'], ['∼', 'similar tilde'],
    ['°', 'degree'], ['′', 'arcminute'], ['″', 'arcsecond'], ['⌒', 'arc'], ['⊙', 'circled dot'], ['⌀', 'diameter'],
    ['π', 'pi'], ['↦', 'maps to'],
  ]],
  ['Set Theory', [
    ['∈', 'element of member'], ['∉', 'not an element of'], ['∋', 'contains as member'], ['∌', 'does not contain'],
    ['⊂', 'subset of'], ['⊃', 'superset of'], ['⊆', 'subset of or equal'], ['⊇', 'superset of or equal'],
    ['⊄', 'not a subset'], ['⊅', 'not a superset'], ['⊊', 'proper subset'], ['⊋', 'proper superset'],
    ['∪', 'union'], ['∩', 'intersection'], ['∖', 'set minus difference'], ['∅', 'empty set null'],
    ['⊕', 'direct sum'], ['⊗', 'tensor product'], ['⊎', 'multiset union'], ['×', 'cartesian product'],
    ['ℝ', 'real numbers'], ['ℚ', 'rational numbers'], ['ℤ', 'integers'], ['ℕ', 'natural numbers'],
    ['ℂ', 'complex numbers'], ['ℙ', 'primes'], ['ℍ', 'quaternions'], ['𝔽', 'field'], ['∁', 'complement'],
  ]],
  ['Logic', [
    ['∀', 'for all universal'], ['∃', 'there exists'], ['∄', 'there does not exist'],
    ['¬', 'not negation'], ['∧', 'and conjunction'], ['∨', 'or disjunction'], ['⊻', 'xor exclusive or'],
    ['⇒', 'implies'], ['⇐', 'implied by'], ['⇔', 'if and only if iff'], ['→', 'implies arrow'], ['↔', 'equivalence'],
    ['⊢', 'proves turnstile'], ['⊨', 'models entails'], ['⊤', 'true top'], ['⊥', 'false bottom'],
    ['∴', 'therefore'], ['∵', 'because'], ['≡', 'equivalent identical'], ['⊕', 'xor'], ['□', 'necessarily'], ['◇', 'possibly'],
  ]],
  ['Number Theory', [
    ['∣', 'divides'], ['∤', 'does not divide'], ['≡', 'congruent modulo'], ['≢', 'not congruent'],
    ['mod', 'modulo'], ['gcd', 'greatest common divisor'], ['lcm', 'least common multiple'],
    ['∑', 'summation'], ['∏', 'product'], ['⌊', 'floor left'], ['⌋', 'floor right'], ['⌈', 'ceiling left'], ['⌉', 'ceiling right'],
    ['ℤ', 'integers'], ['ℕ', 'natural numbers'], ['ℙ', 'primes'], ['ℵ', 'aleph cardinality'], ['ℶ', 'beth'], ['∞', 'infinity'],
    ['!', 'factorial'], ['‼', 'double factorial'], ['ϕ', 'euler totient phi'],
  ]],
  ['Statistics & Probability', [
    ['μ', 'mean mu'], ['σ', 'standard deviation sigma'], ['σ²', 'variance'], ['ρ', 'correlation rho'],
    ['x̄', 'x bar sample mean'], ['ȳ', 'y bar'], ['p̂', 'p hat estimate'], ['χ²', 'chi squared'],
    ['∑', 'summation'], ['∏', 'product'], ['∝', 'proportional to'], ['≈', 'approximately'],
    ['P', 'probability'], ['E', 'expected value'], ['Var', 'variance'], ['Cov', 'covariance'],
    ['∪', 'union'], ['∩', 'intersection'], ['∣', 'given conditional'], ['!', 'factorial'],
    ['⊥', 'independent'], ['∼', 'distributed as'], ['∞', 'infinity'], ['∅', 'empty set'], ['ν', 'degrees of freedom nu'],
  ]],
  ['Greek Letters', [
    ['α', 'alpha'], ['β', 'beta'], ['γ', 'gamma'], ['δ', 'delta'], ['ε', 'epsilon'], ['ζ', 'zeta'],
    ['η', 'eta'], ['θ', 'theta'], ['ι', 'iota'], ['κ', 'kappa'], ['λ', 'lambda'], ['μ', 'mu'],
    ['ν', 'nu'], ['ξ', 'xi'], ['ο', 'omicron'], ['π', 'pi'], ['ρ', 'rho'], ['σ', 'sigma'],
    ['τ', 'tau'], ['υ', 'upsilon'], ['φ', 'phi'], ['χ', 'chi'], ['ψ', 'psi'], ['ω', 'omega'],
    ['Α', 'capital alpha'], ['Β', 'capital beta'], ['Γ', 'capital gamma'], ['Δ', 'capital delta'],
    ['Ε', 'capital epsilon'], ['Ζ', 'capital zeta'], ['Η', 'capital eta'], ['Θ', 'capital theta'],
    ['Ι', 'capital iota'], ['Κ', 'capital kappa'], ['Λ', 'capital lambda'], ['Μ', 'capital mu'],
    ['Ν', 'capital nu'], ['Ξ', 'capital xi'], ['Ο', 'capital omicron'], ['Π', 'capital pi'],
    ['Ρ', 'capital rho'], ['Σ', 'capital sigma'], ['Τ', 'capital tau'], ['Υ', 'capital upsilon'],
    ['Φ', 'capital phi'], ['Χ', 'capital chi'], ['Ψ', 'capital psi'], ['Ω', 'capital omega ohm'],
    ['ϑ', 'theta variant'], ['ϕ', 'phi variant'], ['ϖ', 'pi variant'], ['ϵ', 'epsilon variant'], ['ϰ', 'kappa variant'],
  ]],
  ['Mathematical Operators', [
    ['+', 'plus'], ['−', 'minus'], ['×', 'multiply'], ['÷', 'divide'], ['∗', 'asterisk'], ['⋅', 'dot product'],
    ['∘', 'ring composition'], ['⊕', 'direct sum'], ['⊖', 'circled minus'], ['⊗', 'tensor'], ['⊘', 'circled slash'], ['⊙', 'circled dot'],
    ['√', 'root'], ['∛', 'cube root'], ['∜', 'fourth root'], ['∑', 'sum'], ['∏', 'product'], ['∐', 'coproduct'],
    ['∫', 'integral'], ['∂', 'partial'], ['∇', 'nabla'], ['∆', 'delta'], ['%', 'percent'], ['‰', 'permille'],
    ['⨯', 'cross product'], ['⨂', 'n-ary tensor'], ['⨁', 'n-ary sum'], ['⋀', 'n-ary and'], ['⋁', 'n-ary or'], ['⋂', 'n-ary intersection'], ['⋃', 'n-ary union'],
  ]],
  ['Relations & Comparisons', [
    ['=', 'equals'], ['≠', 'not equal'], ['≈', 'approximately equal'], ['≅', 'congruent'], ['≡', 'identical equivalent'],
    ['≢', 'not identical'], ['<', 'less than'], ['>', 'greater than'], ['≤', 'less than or equal'], ['≥', 'greater than or equal'],
    ['≪', 'much less than'], ['≫', 'much greater than'], ['≦', 'less over equal'], ['≧', 'greater over equal'],
    ['≶', 'less or greater'], ['≷', 'greater or less'], ['∝', 'proportional'], ['∼', 'similar'], ['≃', 'asymptotically equal'],
    ['≜', 'defined as'], ['≝', 'equal by definition'], ['≟', 'questioned equal'], ['≐', 'approaches limit'], ['∈', 'element of'], ['∋', 'contains'],
  ]],
  ['Integrals & Summations', [
    ['∫', 'integral'], ['∬', 'double integral'], ['∭', 'triple integral'], ['⨌', 'quadruple integral'],
    ['∮', 'contour integral'], ['∯', 'surface integral'], ['∰', 'volume integral'], ['⨑', 'clockwise integral'],
    ['∑', 'summation sum'], ['∏', 'product'], ['∐', 'coproduct'], ['⨁', 'n-ary circled plus'], ['⨂', 'n-ary circled times'],
    ['⋀', 'n-ary logical and'], ['⋁', 'n-ary logical or'], ['⋂', 'n-ary intersection'], ['⋃', 'n-ary union'], ['⨀', 'n-ary circled dot'],
  ]],
  ['Limits', [
    ['lim', 'limit'], ['→', 'approaches to'], ['∞', 'infinity'], ['−∞', 'negative infinity'],
    ['↑', 'tends up'], ['↓', 'tends down'], ['⁺', 'from the right plus'], ['⁻', 'from the left minus'],
    ['≐', 'approaches the limit'], ['≈', 'approximately'], ['∼', 'asymptotic'], ['≃', 'asymptotically equal'],
    ['sup', 'supremum'], ['inf', 'infimum'], ['max', 'maximum'], ['min', 'minimum'], ['∂', 'partial'], ['∇', 'nabla'],
  ]],
  ['Vectors & Matrices', [
    ['→', 'vector arrow'], ['⃗', 'combining vector arrow'], ['·', 'dot product'], ['×', 'cross product'], ['⊗', 'outer product'],
    ['‖', 'norm double bar'], ['∥', 'parallel norm'], ['⊥', 'orthogonal perpendicular'], ['∇', 'gradient del'],
    ['⟨', 'left angle bracket bra'], ['⟩', 'right angle bracket ket'], ['⟪', 'double angle left'], ['⟫', 'double angle right'],
    ['[', 'left bracket matrix'], [']', 'right bracket matrix'], ['⌈', 'ceiling left'], ['⌉', 'ceiling right'], ['⌊', 'floor left'], ['⌋', 'floor right'],
    ['ᵀ', 'transpose superscript T'], ['†', 'dagger conjugate transpose'], ['⁻¹', 'inverse'], ['det', 'determinant'], ['tr', 'trace'], ['⋮', 'vertical ellipsis'], ['⋯', 'horizontal ellipsis'], ['⋱', 'diagonal ellipsis'],
  ]],
  ['Differential Equations', [
    ['∂', 'partial derivative'], ['∇', 'nabla del'], ['∇²', 'laplacian'], ['Δ', 'laplace operator delta'],
    ['′', 'first derivative prime'], ['″', 'second derivative'], ['‴', 'third derivative'],
    ['ⅆ', 'differential d'], ['∫', 'integral'], ['∮', 'contour integral'], ['ẋ', 'x dot time derivative'], ['ẍ', 'x double dot'],
    ['ω', 'angular frequency omega'], ['λ', 'eigenvalue lambda'], ['φ', 'phase phi'], ['ψ', 'wavefunction psi'], ['∞', 'infinity'], ['∝', 'proportional'],
  ]],
  ['Physics', [
    ['ℏ', 'reduced planck constant h-bar'], ['ℎ', 'planck constant'], ['ℓ', 'length litre script l'],
    ['°', 'degree'], ['℃', 'degree celsius'], ['℉', 'degree fahrenheit'], ['K', 'kelvin'],
    ['Å', 'angstrom'], ['µ', 'micro'], ['Ω', 'ohm resistance'], ['λ', 'wavelength lambda'], ['ν', 'frequency nu'], ['ω', 'angular frequency'],
    ['∇', 'del operator'], ['∂', 'partial'], ['ℰ', 'electric field script e'], ['ℬ', 'magnetic field'], ['∮', 'flux integral'],
    ['ψ', 'wavefunction psi'], ['φ', 'potential phi'], ['ρ', 'density rho'], ['σ', 'conductivity sigma'], ['τ', 'time constant torque tau'],
    ['⊙', 'sun solar'], ['⊕', 'earth'], ['↯', 'lightning'], ['∞', 'infinity'], ['c', 'speed of light'], ['g', 'gravity'],
  ]],
  ['Chemistry', [
    ['→', 'reaction yields arrow'], ['⇌', 'equilibrium reversible'], ['⇋', 'equilibrium variant'], ['↑', 'gas evolved up'], ['↓', 'precipitate down'],
    ['⁺', 'positive charge cation'], ['⁻', 'negative charge anion'], ['²⁺', 'two plus charge'], ['³⁺', 'three plus charge'], ['²⁻', 'two minus charge'],
    ['°', 'standard state degree'], ['Δ', 'heat delta'], ['≡', 'triple bond'], ['⚛', 'atom'], ['⌬', 'benzene ring'],
    ['₀', 'subscript 0'], ['₁', 'subscript 1'], ['₂', 'subscript 2'], ['₃', 'subscript 3'], ['₄', 'subscript 4'],
    ['₅', 'subscript 5'], ['₆', 'subscript 6'], ['₇', 'subscript 7'], ['₈', 'subscript 8'], ['₉', 'subscript 9'],
    ['ℓ', 'liquid state'], ['·', 'radical dot hydrate'], ['⟶', 'long reaction arrow'],
  ]],
  ['Units & Measurement', [
    ['°', 'degree'], ['℃', 'celsius'], ['℉', 'fahrenheit'], ['K', 'kelvin'], ['Å', 'angstrom'],
    ['µ', 'micro'], ['Ω', 'ohm'], ['µm', 'micrometre'], ['nm', 'nanometre'], ['mm', 'millimetre'],
    ['km', 'kilometre'], ['kg', 'kilogram'], ['mol', 'mole'], ['cd', 'candela'], ['㎡', 'square metre'], ['㎥', 'cubic metre'],
    ['㎏', 'kilogram symbol'], ['㎈', 'calorie'], ['㎐', 'hertz'], ['㎑', 'kilohertz'], ['㎒', 'megahertz'], ['㎓', 'gigahertz'],
    ['㎩', 'pascal'], ['㎪', 'kilopascal'], ['㏄', 'cubic centimetre cc'], ['㏑', 'natural log ln'], ['㏒', 'log'], ['′', 'minute foot'], ['″', 'second inch'], ['%', 'percent'], ['‰', 'per mille'],
  ]],
  ['Engineering', [
    ['Ω', 'ohm resistance'], ['µ', 'micro'], ['∅', 'diameter empty'], ['⌀', 'diameter'], ['∡', 'measured angle'],
    ['≈', 'approximately'], ['∝', 'proportional'], ['∞', 'infinity'], ['Δ', 'delta change'], ['∑', 'sum'],
    ['√', 'root'], ['∫', 'integral'], ['∂', 'partial'], ['∇', 'nabla'], ['±', 'plus minus tolerance'], ['°', 'degree'],
    ['⏛', 'ground earth'], ['⎓', 'direct current dc'], ['∼', 'alternating current ac'], ['⌁', 'electric arrow'],
    ['⊕', 'exclusive or node'], ['⊗', 'cross node'], ['↯', 'fault lightning'], ['‖', 'parallel'], ['⟂', 'perpendicular'], ['ϕ', 'phase angle phi'],
  ]],
  ['Scientific Symbols', [
    ['×10ⁿ', 'scientific notation'], ['ℯ', 'euler number e'], ['∞', 'infinity'], ['∝', 'proportional to'],
    ['≈', 'approximately'], ['≡', 'identical'], ['≠', 'not equal'], ['±', 'plus minus uncertainty'], ['∓', 'minus plus'],
    ['µ', 'micro'], ['Å', 'angstrom'], ['°', 'degree'], ['′', 'prime'], ['″', 'double prime'],
    ['№', 'numero number'], ['™', 'trademark'], ['®', 'registered'], ['©', 'copyright'], ['✓', 'check tick'], ['✗', 'cross x'],
    ['★', 'star'], ['☆', 'star outline'], ['♠', 'spade'], ['♣', 'club'], ['♥', 'heart'], ['♦', 'diamond'],
  ]],
  ['Arrows & Directional Symbols', [
    ['→', 'right arrow'], ['←', 'left arrow'], ['↑', 'up arrow'], ['↓', 'down arrow'],
    ['↔', 'left right arrow'], ['↕', 'up down arrow'], ['↗', 'north east arrow'], ['↘', 'south east arrow'],
    ['↙', 'south west arrow'], ['↖', 'north west arrow'], ['⇒', 'double right arrow implies'], ['⇐', 'double left arrow'],
    ['⇑', 'double up arrow'], ['⇓', 'double down arrow'], ['⇔', 'double left right iff'], ['⇕', 'double up down'],
    ['↦', 'maps to'], ['⟶', 'long right arrow'], ['⟵', 'long left arrow'], ['⟷', 'long left right'], ['↩', 'hook left'], ['↪', 'hook right'],
    ['⇌', 'harpoons equilibrium'], ['↻', 'clockwise'], ['↺', 'anticlockwise'], ['⤴', 'arrow up curve'], ['⤵', 'arrow down curve'],
  ]],
  ['Constants & Special Symbols', [
    ['π', 'pi 3.14159'], ['τ', 'tau 6.28'], ['ℯ', 'euler e 2.718'], ['φ', 'golden ratio phi'], ['∞', 'infinity'],
    ['ℏ', 'planck reduced h-bar'], ['ℎ', 'planck constant'], ['ℵ', 'aleph'], ['∅', 'empty set'], ['ℑ', 'imaginary part'], ['ℜ', 'real part'], ['ⅈ', 'imaginary unit i'],
    ['°', 'degree'], ['′', 'prime'], ['″', 'double prime'], ['∴', 'therefore'], ['∵', 'because'], ['∎', 'qed'],
    ['…', 'ellipsis'], ['⋯', 'midline ellipsis'], ['⋮', 'vertical ellipsis'], ['⋱', 'diagonal ellipsis'], ['∣', 'such that bar'], ['‖', 'parallel norm'],
  ]],
];

/* ==========================================================================
 *  Persisted state (Recently Used + Favorites) — survive page reloads.
 * ========================================================================== */

const LS_RECENT = 'dm.symbols.recent';
const LS_FAV = 'dm.symbols.fav';
const RECENT_MAX = 40;

function loadList(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(v) ? v.filter((s) => typeof s === 'string') : [];
  } catch { return []; }
}
function saveList(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* storage blocked — keep in-memory */ }
}

/** Look up a friendly name for a glyph (first match across categories). */
function nameFor(glyph) {
  for (const [, syms] of CATEGORIES) {
    for (const [c, n] of syms) if (c === glyph) return n;
  }
  return glyph;
}

let singleton = null;

/* ==========================================================================
 *  Panel
 * ========================================================================== */

/**
 * Open (or focus) the symbol picker.
 * @param {{ insert:(ch:string)=>void, restore?:()=>void }} api
 *   `insert` drops a glyph at the editor caret; `restore` (optional) returns the
 *   caret to the document when the panel closes.
 */
export function openSymbolLibrary(api) {
  const insert = api?.insert || (() => {});
  const restore = api?.restore;
  if (singleton) { singleton.setApi({ insert, restore }); singleton.focus(); return singleton; }

  let curInsert = insert;
  let curRestore = restore;
  let recent = loadList(LS_RECENT);
  let favs = loadList(LS_FAV);
  let activeCat = 0;         // index into CATEGORIES, or 'recent' | 'fav'
  let query = '';

  /* ---- symbol insertion ---- */
  function choose(glyph) {
    curInsert(glyph);
    recent = [glyph, ...recent.filter((g) => g !== glyph)].slice(0, RECENT_MAX);
    saveList(LS_RECENT, recent);
    // Only the Recently-Used view needs to re-flow live; other views are unaffected.
    if (!query && activeCat === 'recent') renderGrid();
  }
  function toggleFav(glyph) {
    if (favs.includes(glyph)) favs = favs.filter((g) => g !== glyph);
    else favs = [glyph, ...favs];
    saveList(LS_FAV, favs);
    renderRail();  // Favorites count in the rail
    renderGrid();  // star state / the Favorites grid itself
  }

  /* ---- grid tile ---- */
  function tile(glyph) {
    const fav = favs.includes(glyph);
    const star = el('button', {
      class: `sym__star${fav ? ' is-on' : ''}`, type: 'button', tabindex: -1,
      title: fav ? 'Remove from favorites' : 'Add to favorites', 'aria-label': 'Toggle favorite',
      onClick: (e) => { e.stopPropagation(); toggleFav(glyph); },
    }, fav ? '★' : '☆');
    const btn = el('button', {
      class: 'sym__tile', type: 'button', tabindex: -1,
      title: nameFor(glyph), 'aria-label': `Insert ${nameFor(glyph)}`,
      onClick: () => choose(glyph),
    }, [el('span', { class: 'sym__glyph' }, glyph), star]);
    // Keep the editor's caret/selection intact when a tile is clicked.
    btn.addEventListener('pointerdown', (e) => e.preventDefault());
    return btn;
  }

  /* ---- rail (categories + Recent + Favorites) ---- */
  const railEl = el('div', { class: 'sym__rail' });
  function railItem(label, key, count) {
    const on = activeCat === key;
    return el('button', {
      class: `sym__cat${on ? ' is-on' : ''}`, type: 'button', 'data-key': String(key),
      onClick: () => { activeCat = key; query = ''; searchInput.value = ''; renderRail(); renderGrid(); },
    }, [
      el('span', { class: 'sym__catname' }, label),
      count != null ? el('span', { class: 'sym__catcount' }, String(count)) : null,
    ].filter(Boolean));
  }
  function renderRail() {
    railEl.replaceChildren(
      railItem('Recently Used', 'recent', recent.length),
      railItem('Favorites', 'fav', favs.length),
      el('div', { class: 'sym__railsep' }),
      ...CATEGORIES.map(([name], i) => railItem(name, i)),
    );
  }

  /* ---- grid ---- */
  const gridTitle = el('div', { class: 'sym__gridtitle' }, '');
  const gridEl = el('div', { class: 'sym__grid' });
  function currentSymbols() {
    if (query) {
      const q = query.toLowerCase();
      const seen = new Set();
      const out = [];
      for (const [, syms] of CATEGORIES) {
        for (const [c, n] of syms) {
          if (seen.has(c)) continue;
          if (c.toLowerCase().includes(q) || n.toLowerCase().includes(q)) { out.push(c); seen.add(c); }
        }
      }
      return out;
    }
    if (activeCat === 'recent') return recent;
    if (activeCat === 'fav') return favs;
    return CATEGORIES[activeCat][1].map(([c]) => c);
  }
  function renderGrid() {
    const syms = currentSymbols();
    gridTitle.textContent = query ? `Search: “${query}” — ${syms.length} result${syms.length === 1 ? '' : 's'}`
      : activeCat === 'recent' ? 'Recently Used'
      : activeCat === 'fav' ? 'Favorites'
      : CATEGORIES[activeCat][0];
    if (!syms.length) {
      const msg = query ? 'No symbols match your search.'
        : activeCat === 'recent' ? 'No symbols used yet — click any symbol to add it here.'
        : 'No favorites yet — click the ☆ on any symbol to save it.';
      gridEl.replaceChildren(el('div', { class: 'sym__empty' }, msg));
      return;
    }
    gridEl.replaceChildren(...syms.map(tile));
  }

  /* ---- header + search ---- */
  const searchInput = el('input', {
    class: 'sym__search', type: 'text', placeholder: 'Search symbols by name…',
    'aria-label': 'Search symbols', spellcheck: 'false', autocomplete: 'off',
    onInput: (e) => { query = e.target.value.trim(); renderGrid(); },
  });
  const header = el('div', { class: 'sym__head' }, [
    el('div', { class: 'sym__title' }, 'Symbols'),
    el('div', { class: 'sym__headtools' }, [
      el('button', { class: 'sym__icon sym__close', type: 'button', title: 'Close', 'aria-label': 'Close', onClick: close }, '×'),
    ]),
  ]);

  const panel = el('div', {
    class: 'sym', role: 'dialog', 'aria-label': 'Math & Science symbols', tabindex: 0,
    onKeydown: onKey,
  }, [
    header,
    el('div', { class: 'sym__searchrow' }, [searchInput]),
    el('div', { class: 'sym__body' }, [
      railEl,
      el('div', { class: 'sym__main' }, [gridTitle, gridEl]),
    ]),
  ]);

  /* ---- keyboard (scoped: keys never reach the app's global manager) ---- */
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    // Let the search box behave normally, but keep every key local to the panel.
    e.stopPropagation();
  }

  /* ---- movable, clamped to the viewport ---- */
  const clampInView = () => {
    const r = panel.getBoundingClientRect();
    const keep = 60;
    let left = parseFloat(panel.style.left);
    let top = parseFloat(panel.style.top);
    if (Number.isNaN(left)) left = r.left;
    if (Number.isNaN(top)) top = r.top;
    left = Math.min(window.innerWidth - keep, Math.max(keep - r.width, left));
    top = Math.min(Math.max(0, window.innerHeight - 44), Math.max(0, top));
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
    panel.style.right = 'auto';
  };
  let drag = null;
  header.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.sym__icon')) return;
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
    // Hand the caret back to the document so typing resumes where it left off.
    try { curRestore?.(); } catch { /* editor may be gone — ignore */ }
  }
  function focus() { panel.focus({ preventScroll: true }); }
  function setApi(next) { curInsert = next.insert || curInsert; curRestore = next.restore || curRestore; }

  renderRail();
  renderGrid();
  document.body.appendChild(panel);
  clampInView();
  focus();

  singleton = { close, focus, setApi, element: panel };
  return singleton;
}
