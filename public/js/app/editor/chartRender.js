/**
 * Chart render engine for the DOC editor's **Professional Library** (charts &
 * graphs). Pure + dependency-free: a structured chart spec → a self-contained
 * SVG string. The SVG is what a chart figure shows (crisp/vector) and what the
 * exporters rasterise; the spec itself is stored on the figure (data-chart) so the
 * chart stays a REAL editable object (Edit Data / colours / type all mutate the
 * spec and re-render). This is entirely separate from the Shapes system.
 *
 * Chart spec (all plain, serialisable data):
 *   {
 *     type,                       // one of TYPE_META keys
 *     title,
 *     categories: string[],       // axis / slice labels
 *     series: [ { name, values:number[], color? } ],
 *     colors: string[],           // per-POINT colours (pie/funnel/waterfall)
 *     width, height, rotation,
 *     options: {
 *       showTitle, showLegend, legendPos, showDataLabels, showPercentLabels,
 *       showAxis, showGridlines, background, borderColor, borderWidth, shadow,
 *       opacity, gradient, palette,
 *       threeD: { depth, rotation, perspective, explode, spacing }
 *     }
 *   }
 */

export const PALETTES = {
  office: ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47', '#264478', '#9E480E', '#636363', '#997300'],
  colorful: ['#5B9BD5', '#ED7D31', '#A5A5A5', '#FFC000', '#4472C4', '#70AD47', '#255E91', '#9E480E'],
  vivid: ['#2563EB', '#7C3AED', '#059669', '#EA580C', '#DC2626', '#0891B2', '#DB2777', '#CA8A04'],
  pastel: ['#8FAADC', '#F4B183', '#C9C9C9', '#FFD966', '#A9D18E', '#B4A7D6', '#F6B6C6', '#9CC3E5'],
  slate: ['#334155', '#475569', '#64748B', '#94A3B8', '#0F766E', '#1D4ED8', '#7E22CE', '#B91C1C'],
  forest: ['#2F6B3C', '#4E9A51', '#8BC34A', '#C5E1A5', '#1B5E20', '#66BB6A', '#A5D6A7', '#33691E'],
};
export const PALETTE_IDS = Object.keys(PALETTES);

/** type id → family + flags the renderer switches on. */
export const TYPE_META = {
  pie: { family: 'pie', label: 'Pie' },
  pie3d: { family: 'pie', d3: true, label: '3D Pie' },
  pieExploded: { family: 'pie', explode: true, label: 'Exploded Pie' },
  pieExploded3d: { family: 'pie', explode: true, d3: true, label: '3D Exploded Pie' },
  doughnut: { family: 'pie', doughnut: true, label: 'Doughnut' },
  doughnut3d: { family: 'pie', doughnut: true, d3: true, label: '3D Doughnut' },
  doughnutExploded: { family: 'pie', doughnut: true, explode: true, label: 'Exploded Doughnut' },
  doughnutExploded3d: { family: 'pie', doughnut: true, explode: true, d3: true, label: '3D Exploded Doughnut' },

  column: { family: 'bar', label: 'Column' },
  columnClustered: { family: 'bar', clustered: true, label: 'Clustered Column' },
  columnStacked: { family: 'bar', stacked: true, label: 'Stacked Column' },
  column100: { family: 'bar', stacked: true, pct: true, label: '100% Stacked Column' },
  column3d: { family: 'bar', d3: true, label: '3D Column' },
  columnClustered3d: { family: 'bar', clustered: true, d3: true, label: '3D Clustered Column' },
  columnStacked3d: { family: 'bar', stacked: true, d3: true, label: '3D Stacked Column' },
  column1003d: { family: 'bar', stacked: true, pct: true, d3: true, label: '3D 100% Stacked Column' },

  bar: { family: 'bar', horizontal: true, label: 'Horizontal Bar' },
  barClustered: { family: 'bar', horizontal: true, clustered: true, label: 'Clustered Bar' },
  barStacked: { family: 'bar', horizontal: true, stacked: true, label: 'Stacked Bar' },
  bar100: { family: 'bar', horizontal: true, stacked: true, pct: true, label: '100% Stacked Bar' },
  bar3d: { family: 'bar', horizontal: true, d3: true, label: '3D Bar' },
  barClustered3d: { family: 'bar', horizontal: true, clustered: true, d3: true, label: '3D Clustered Bar' },
  barStacked3d: { family: 'bar', horizontal: true, stacked: true, d3: true, label: '3D Stacked Bar' },

  line: { family: 'line', label: 'Line' },
  lineMarkers: { family: 'line', markers: true, label: 'Line with Markers' },
  lineSmooth: { family: 'line', smooth: true, label: 'Smooth Line' },
  lineStacked: { family: 'line', stacked: true, label: 'Stacked Line' },
  lineArea: { family: 'area', label: 'Area Line' },
  line3d: { family: 'line', d3: true, markers: true, label: '3D Line' },

  area: { family: 'area', label: 'Area' },
  areaStacked: { family: 'area', stacked: true, label: 'Stacked Area' },
  area100: { family: 'area', stacked: true, pct: true, label: '100% Stacked Area' },
  area3d: { family: 'area', d3: true, label: '3D Area' },

  scatter: { family: 'scatter', label: 'Scatter' },
  scatterLines: { family: 'scatter', lines: true, label: 'Scatter with Lines' },
  bubble: { family: 'scatter', bubble: true, label: 'Bubble' },
  scatter3d: { family: 'scatter', d3: true, label: '3D Scatter' },

  radar: { family: 'radar', label: 'Radar' },
  funnel: { family: 'funnel', label: 'Funnel' },
  funnel3d: { family: 'funnel', d3: true, label: '3D Funnel' },
  waterfall: { family: 'waterfall', label: 'Waterfall' },
  waterfall3d: { family: 'waterfall', d3: true, label: '3D Waterfall' },
  combo: { family: 'combo', label: 'Combination Chart' },
  combo3d: { family: 'combo', d3: true, label: '3D Combination Chart' },

  /* ---- Financial ---- */
  candlestick: { family: 'candlestick', label: 'Candlestick' },
  candlestick3d: { family: 'candlestick', d3: true, label: '3D Candlestick' },
  ohlc: { family: 'candlestick', ohlc: true, label: 'OHLC' },
  ohlc3d: { family: 'candlestick', ohlc: true, d3: true, label: '3D OHLC' },
  highLowClose: { family: 'candlestick', hlc: true, label: 'High-Low-Close' },
  stockVolume: { family: 'candlestick', volume: true, label: 'Stock Volume' },
  stockVolume3d: { family: 'candlestick', volume: true, d3: true, label: '3D Stock Volume' },
  financialCombo: { family: 'combo', label: 'Financial Combo' },
  financialCombo3d: { family: 'combo', d3: true, label: '3D Financial Combo' },

  /* ---- Business ---- */
  gauge: { family: 'gauge', label: 'Gauge' },
  gauge3d: { family: 'gauge', d3: true, label: '3D Gauge' },
  kpi: { family: 'kpi', label: 'KPI Card' },
  kpi3d: { family: 'kpi', d3: true, label: '3D KPI Card' },
  bullet: { family: 'bullet', label: 'Bullet Chart' },
  bullet3d: { family: 'bullet', d3: true, label: '3D Bullet Chart' },
  progress: { family: 'bullet', progress: true, label: 'Progress / Target' },
  progress3d: { family: 'bullet', progress: true, d3: true, label: '3D Progress / Target' },
  pareto: { family: 'pareto', label: 'Pareto Chart' },
  pareto3d: { family: 'pareto', d3: true, label: '3D Pareto Chart' },
  pipeline: { family: 'funnel', pipeline: true, label: 'Sales Pipeline' },
  comparison: { family: 'bar', clustered: true, label: 'Comparison Chart' },
  comparison3d: { family: 'bar', clustered: true, d3: true, label: '3D Comparison Chart' },

  /* ---- Statistical ---- */
  histogram: { family: 'histogram', label: 'Histogram' },
  histogram3d: { family: 'histogram', d3: true, label: '3D Histogram' },
  boxplot: { family: 'boxplot', label: 'Box & Whisker' },
  heatmap: { family: 'heatmap', label: 'Heatmap' },
  scatterMatrix: { family: 'matrix', label: 'Scatter Matrix' },

  /* ---- Hierarchy ---- */
  treemap: { family: 'treemap', label: 'Treemap' },
  treemap3d: { family: 'treemap', d3: true, label: '3D Treemap' },
  sunburst: { family: 'sunburst', label: 'Sunburst' },
  tree: { family: 'tree', label: 'Hierarchy / Tree' },

  /* ---- Project management ---- */
  gantt: { family: 'gantt', label: 'Gantt Chart' },
  gantt3d: { family: 'gantt', d3: true, label: '3D Gantt Chart' },
  timeline: { family: 'timeline', label: 'Timeline' },
  milestone: { family: 'timeline', milestone: true, label: 'Milestone Chart' },
  projectProgress: { family: 'bullet', progress: true, label: 'Project Progress' },
  projectProgress3d: { family: 'bullet', progress: true, d3: true, label: '3D Project Progress' },
  projectStatus: { family: 'pie', doughnut: true, label: 'Project Status' },
};

// Families whose data is per-POINT (one value per row, per-point colours) — used by the
// Colors popover, the legend, and the adaptive data editor to show a Value+Color grid.
export const PER_POINT_FAMILIES = ['pie', 'funnel', 'waterfall', 'treemap', 'sunburst', 'pareto', 'gauge'];

/** The Professional Library panel's categorised catalogue. */
export const CHART_CATALOG = [
  { id: 'pie', name: 'Pie & Doughnut', items: ['pie', 'pie3d', 'pieExploded', 'pieExploded3d', 'doughnut', 'doughnut3d', 'doughnutExploded', 'doughnutExploded3d'] },
  { id: 'column', name: 'Column', items: ['column', 'columnClustered', 'columnStacked', 'column100', 'column3d', 'columnClustered3d', 'columnStacked3d', 'column1003d'] },
  { id: 'bar', name: 'Bar', items: ['bar', 'barClustered', 'barStacked', 'bar100', 'bar3d', 'barClustered3d', 'barStacked3d'] },
  { id: 'line', name: 'Line', items: ['line', 'lineMarkers', 'lineSmooth', 'lineStacked', 'lineArea', 'line3d'] },
  { id: 'area', name: 'Area', items: ['area', 'areaStacked', 'area100', 'area3d'] },
  { id: 'scatter', name: 'Scatter', items: ['scatter', 'scatterLines', 'bubble', 'scatter3d'] },
  { id: 'financial', name: 'Financial', items: ['candlestick', 'candlestick3d', 'ohlc', 'ohlc3d', 'highLowClose', 'stockVolume', 'stockVolume3d', 'waterfall', 'waterfall3d', 'financialCombo', 'financialCombo3d'] },
  { id: 'business', name: 'Business', items: ['funnel', 'funnel3d', 'gauge', 'gauge3d', 'kpi', 'kpi3d', 'bullet', 'bullet3d', 'progress', 'progress3d', 'combo', 'combo3d', 'pareto', 'pareto3d', 'pipeline', 'comparison', 'comparison3d'] },
  { id: 'statistical', name: 'Statistical', items: ['histogram', 'histogram3d', 'boxplot', 'bubble', 'radar', 'heatmap', 'scatterMatrix'] },
  { id: 'hierarchy', name: 'Hierarchy', items: ['treemap', 'treemap3d', 'sunburst', 'tree'] },
  { id: 'project', name: 'Project', items: ['gantt', 'gantt3d', 'timeline', 'milestone', 'projectProgress', 'projectProgress3d', 'projectStatus'] },
  { id: 'other', name: 'Other', items: ['radar', 'funnel', 'waterfall', 'combo'] },
];

export const chartTypeLabel = (id) => (TYPE_META[id] && TYPE_META[id].label) || id;

/* --------------------------- default sample data -------------------------- */

const DEFAULT_OPTIONS = () => ({
  showTitle: true, showLegend: true, legendPos: 'bottom',
  showDataLabels: false, showPercentLabels: false, showCatLabels: true,
  showAxis: true, showAxisTitles: false, axisTitleX: 'Category', axisTitleY: 'Value',
  showGridlines: true, valueUnit: '',
  // Value-axis scale: Auto (0 → nice max, 5 ticks) by default. When axisAuto is false
  // the user's min / max / interval drive the scale; decimals + thousands + label size
  // control how the tick numbers are formatted and sized.
  axisAuto: true, axisMin: null, axisMax: null, axisStep: null,
  axisDecimals: null, axisThousands: false, axisLabelSize: 10,
  background: '#ffffff', borderColor: '#e2e8f0', borderWidth: 1,
  shadow: false, opacity: 1, gradient: false, palette: 'office',
  threeD: { depth: 16, rotation: 25, perspective: 0, explode: 0, spacing: 0 },
});

// Representative sample data per NEW family (2D & 3D variants share the key). Each keeps
// the universal shape { categories[], series[{name,values}] } so the data editor, colours,
// type-switching, hotspots/labels and serialization all work unchanged.
const FAMILY_SAMPLE = {
  candlestick: () => ({ width: 540, height: 340, categories: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    series: [{ name: 'Open', values: [100, 104, 102, 108, 107] }, { name: 'High', values: [106, 107, 110, 112, 113] },
      { name: 'Low', values: [99, 101, 100, 106, 105] }, { name: 'Close', values: [104, 102, 108, 107, 111] },
      { name: 'Volume', values: [1200, 1500, 900, 1700, 1400] }], colors: [],
    options: { showAxis: true, showGridlines: true, showDataLabels: false, showCatLabels: true } }),
  gauge: () => ({ width: 400, height: 300, categories: ['Actual', 'Target', 'Minimum', 'Maximum'],
    series: [{ name: 'Value', values: [72, 85, 0, 100] }], colors: [],
    options: { showDataLabels: false, showCatLabels: false } }),
  kpi: () => ({ width: 360, height: 220, title: 'Revenue', categories: ['Current', 'Previous'],
    series: [{ name: 'Value', values: [128000, 102000] }], colors: [],
    options: { showTitle: true, showDataLabels: false, showCatLabels: false } }),
  bullet: () => ({ width: 480, height: 250, categories: ['Revenue', 'Profit', 'Orders'],
    series: [{ name: 'Actual', values: [72, 58, 80] }, { name: 'Target', values: [85, 60, 75] }, { name: 'Max', values: [100, 100, 100] }], colors: [],
    options: { showCatLabels: true, showDataLabels: true } }),
  pareto: () => ({ width: 540, height: 340, categories: ['Defect A', 'Defect B', 'Defect C', 'Defect D', 'Defect E'],
    series: [{ name: 'Count', values: [45, 30, 15, 7, 3] }], colors: [],
    options: { showAxis: true, showGridlines: true, showCatLabels: true, showDataLabels: true } }),
  histogram: () => ({ width: 520, height: 320, categories: [],
    series: [{ name: 'Data', values: [4, 7, 8, 5, 6, 9, 7, 6, 8, 10, 5, 7, 6, 8, 7, 9, 6, 5, 8, 7, 11, 4, 9, 6] }], colors: [],
    options: { showAxis: true, showGridlines: true, showCatLabels: true, showDataLabels: false, bins: 6 } }),
  boxplot: () => ({ width: 500, height: 320, categories: ['Group A', 'Group B', 'Group C'],
    series: [{ name: 'Min', values: [10, 14, 8] }, { name: 'Q1', values: [20, 24, 18] }, { name: 'Median', values: [30, 32, 28] }, { name: 'Q3', values: [42, 44, 40] }, { name: 'Max', values: [55, 52, 58] }], colors: [],
    options: { showAxis: true, showGridlines: true, showCatLabels: true, showDataLabels: false } }),
  heatmap: () => ({ width: 520, height: 320, categories: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    series: [{ name: 'Morning', values: [3, 5, 2, 6, 4] }, { name: 'Noon', values: [6, 8, 5, 9, 7] }, { name: 'Evening', values: [4, 6, 3, 7, 5] }], colors: [],
    options: { showCatLabels: true, showDataLabels: true } }),
  matrix: () => ({ width: 460, height: 420, categories: ['1', '2', '3', '4', '5', '6'],
    series: [{ name: 'Revenue', values: [10, 20, 15, 25, 18, 30] }, { name: 'Profit', values: [12, 18, 22, 15, 28, 20] }], colors: [],
    options: { showAxis: true, showGridlines: true, showCatLabels: false } }),
  treemap: () => ({ width: 480, height: 340, categories: ['Product A', 'Product B', 'Product C', 'Product D', 'Product E'],
    series: [{ name: 'Revenue', values: [45, 25, 15, 10, 5] }], colors: [],
    options: { showCatLabels: true, showDataLabels: true } }),
  sunburst: () => ({ width: 440, height: 400, categories: ['North', 'South', 'East', 'West'],
    series: [{ name: 'Region', values: [40, 30, 20, 10] }, { name: 'Growth', values: [25, 20, 18, 12] }], colors: [],
    options: { showCatLabels: true } }),
  tree: () => ({ width: 540, height: 320, title: 'Company', categories: ['Sales', 'Marketing', 'Engineering', 'Support'],
    series: [{ name: 'Headcount', values: [8, 5, 12, 6] }], colors: [],
    options: { showTitle: true, showCatLabels: true, showDataLabels: true } }),
  gantt: () => ({ width: 580, height: 320, categories: ['Planning', 'Design', 'Development', 'Testing', 'Launch'],
    series: [{ name: 'Start', values: [0, 2, 5, 10, 13] }, { name: 'End', values: [3, 6, 12, 14, 15] }, { name: 'Progress', values: [100, 80, 50, 20, 0] }], colors: [],
    options: { showAxis: true, showGridlines: true, showCatLabels: true, showDataLabels: false } }),
  timeline: () => ({ width: 580, height: 220, categories: ['Kickoff', 'Prototype', 'Beta', 'Release', 'Review'],
    series: [{ name: 'Day', values: [1, 20, 45, 70, 90] }], colors: [], options: { showCatLabels: true } }),
};
// Reused-family types that want their own domain data instead of the generic family sample.
const SPECIAL_SAMPLE = {
  pipeline: () => ({ width: 460, height: 340, categories: ['Visitors', 'Leads', 'Qualified', 'Proposals', 'Customers'],
    series: [{ name: 'Count', values: [10000, 4200, 2100, 900, 500] }], colors: [], options: { showCatLabels: true, showDataLabels: true } }),
  comparison: () => ({ width: 520, height: 320, categories: ['Q1', 'Q2', 'Q3', 'Q4'],
    series: [{ name: 'This Year', values: [120, 150, 170, 200] }, { name: 'Last Year', values: [100, 130, 150, 160] }], colors: [],
    options: { showAxis: true, showGridlines: true, showCatLabels: true } }),
  projectStatus: () => ({ width: 420, height: 340, categories: ['Completed', 'In Progress', 'At Risk', 'Not Started'],
    series: [{ name: 'Tasks', values: [18, 7, 3, 5] }], colors: [], options: { showCatLabels: true, showPercentLabels: true, showDataLabels: false } }),
  financialCombo: () => ({ width: 520, height: 320, categories: ['Jan', 'Feb', 'Mar', 'Apr'],
    series: [{ name: 'Volume', values: [120, 150, 170, 200] }, { name: 'Price', values: [20, 28, 24, 32] }], colors: [],
    options: { showAxis: true, showGridlines: true, showCatLabels: true } }),
  projectProgress: () => ({ width: 500, height: 280, categories: ['Design', 'Development', 'Testing', 'Launch'],
    series: [{ name: 'Actual', values: [100, 70, 40, 10] }, { name: 'Target', values: [100, 100, 100, 100] }, { name: 'Max', values: [100, 100, 100, 100] }], colors: [],
    options: { showCatLabels: true, showDataLabels: true } }),
};

/** Strip a sample chart down to a BLANK template — no category names, no values, no
 *  title text — while preserving structure/colours. Scatter/bubble keep their numeric X
 *  column (that's data, not a label). Renderers show neutral placeholder geometry until
 *  the user types their own data in Edit Data, so EVERY chart type behaves like the pie. */
function blankTemplate(spec, fam) {
  const scatter = fam === 'scatter';
  return {
    ...spec,
    categories: (spec.categories || []).map((c, i) => (scatter ? String(i + 1) : '')),
    series: (spec.series || []).map((s) => ({ ...s, values: (s.values || []).map(() => null) })),
  };
}

/** A ready-to-insert chart: a BLANK template (no sample text/numbers) that renders as
 *  neutral placeholder geometry and fills in live as the user enters data. Use
 *  sampleChart() when you want representative example data (e.g. picker thumbnails). */
export function defaultChart(typeId) {
  const fam = (TYPE_META[typeId] || TYPE_META.pie).family;
  return blankTemplate(sampleChart(typeId), fam);
}

/** The representative example data for a type (what defaultChart blanks out). */
export function sampleChart(typeId) {
  const meta = TYPE_META[typeId] || TYPE_META.pie;
  const fam = meta.family;
  const o = DEFAULT_OPTIONS();
  // Names + Values are ON by default (the "Show" ticks in the data editor start checked)
  // so the moment the user types a category name / value it appears on the chart. A blank
  // insert still looks clean because empty names don't render and unfilled placeholder
  // cells draw no number. Title, legend and axis titles stay off (clutter); everything is
  // individually toggleable in the Elements panel.
  Object.assign(o, {
    showTitle: false, showLegend: false,
    showCatLabels: true, showDataLabels: true, showPercentLabels: false,
    showAxis: false, showAxisTitles: false, showGridlines: false,
  });
  // Cartesian families read as a real chart only WITH their frame — an axis
  // baseline + value gridlines — so bars/lines/points sit on a grid instead of
  // floating. Turn those on by default for the plotted families (matching the
  // Professional Library preview tiles); radial/flow types (pie, funnel, radar,
  // gauge, …) have no cartesian axis and stay clean.
  const CARTESIAN = ['bar', 'line', 'area', 'scatter', 'combo', 'waterfall', 'candlestick', 'pareto', 'histogram', 'boxplot'];
  if (CARTESIAN.includes(fam)) { o.showAxis = true; o.showGridlines = true; }
  const base = { type: typeId, title: chartTypeLabel(typeId), options: o, rotation: 0 };

  // New library families (and a few reused-family types) carry their own representative
  // sample data + sensible option overrides. Everything below shares the ONE model, so
  // each stays fully editable / type-switchable. 2D and 3D variants share the same key.
  const sampleKey = typeId.replace(/3d$/, '');
  const sample = (SPECIAL_SAMPLE[typeId] || SPECIAL_SAMPLE[sampleKey] || FAMILY_SAMPLE[fam]);
  if (sample) {
    const s = sample();
    if (s.options) Object.assign(o, s.options);
    return { ...base, width: s.width || 480, height: s.height || 320, title: s.title != null ? s.title : base.title,
      categories: s.categories, series: s.series, colors: s.colors || [] };
  }

  if (fam === 'pie' || fam === 'funnel' || fam === 'waterfall') {
    if (fam === 'funnel') {
      return { ...base, width: 460, height: 320, categories: ['Awareness', 'Interest', 'Consideration', 'Intent', 'Purchase'],
        series: [{ name: 'Stage', values: [100, 72, 55, 34, 20] }], colors: [] };
    }
    if (fam === 'waterfall') {
      return { ...base, width: 520, height: 320, categories: ['Start', 'Q1', 'Q2', 'Q3', 'Q4'],
        series: [{ name: 'Change', values: [50, 20, -12, 18, -8] }], colors: [] };
    }
    return { ...base, width: 420, height: 340, categories: ['Category A', 'Category B', 'Category C', 'Category D', 'Category E'],
      series: [{ name: 'Series 1', values: [50, 12.5, 12.5, 12.5, 12.5] }], colors: [] };
  }
  if (fam === 'scatter') {
    if (meta.bubble) {
      return { ...base, width: 480, height: 320, categories: ['1', '2', '3', '4', '5', '6'],
        series: [{ name: 'Y', values: [15, 30, 22, 40, 28, 46] }, { name: 'Size', values: [10, 24, 16, 30, 12, 22] }], colors: [] };
    }
    return { ...base, width: 480, height: 320, categories: ['1', '2', '3', '4', '5', '6'],
      series: [{ name: 'Series 1', values: [12, 28, 20, 35, 25, 44] }], colors: [] };
  }
  if (fam === 'radar') {
    return { ...base, width: 420, height: 360, categories: ['Speed', 'Power', 'Range', 'Cost', 'Weight'],
      series: [{ name: 'Model A', values: [80, 60, 70, 50, 65] }, { name: 'Model B', values: [55, 80, 60, 70, 50] }], colors: [] };
  }
  if (fam === 'combo') {
    return { ...base, width: 520, height: 320, categories: ['Q1', 'Q2', 'Q3', 'Q4'],
      series: [{ name: 'Revenue', values: [120, 150, 170, 200] }, { name: 'Growth %', values: [20, 28, 24, 32] }], colors: [] };
  }
  // bar / line / area families
  const wide = fam === 'bar' && meta.horizontal ? 460 : 520;
  return { ...base, width: wide, height: 320, categories: ['Q1', 'Q2', 'Q3', 'Q4'],
    series: [{ name: 'Series 1', values: [45, 62, 58, 74] }, { name: 'Series 2', values: [30, 41, 50, 48] }], colors: [] };
}

/* -------------------------------- helpers --------------------------------- */

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const sum = (a) => a.reduce((x, y) => x + (Number(y) || 0), 0);
const num = (v) => (Number.isFinite(+v) ? +v : 0);

/** Ensure every spec field exists (older/partial specs stay valid). */
export function normalizeChart(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const o = { ...DEFAULT_OPTIONS(), ...(c.options || {}) };
  o.threeD = { ...DEFAULT_OPTIONS().threeD, ...(c.options && c.options.threeD || {}) };
  const type = TYPE_META[c.type] ? c.type : 'pie';
  // Pie/doughnut slice labels are off by default (the legend already names slices);
  // cartesian category axis labels stay on. Respect an explicit saved choice.
  if (TYPE_META[type].family === 'pie' && !(c.options && 'showCatLabels' in c.options)) o.showCatLabels = false;
  return {
    type,
    title: c.title || '',
    categories: Array.isArray(c.categories) ? c.categories.map((x) => (x == null ? '' : String(x))) : [],
    series: Array.isArray(c.series) && c.series.length
      // Empty cells stay null (not 0) so a fresh/blank chart shows no numbers and the
      // data editor renders an empty field the user can fill in; renderers coerce null→0.
      ? c.series.map((s) => ({ name: s.name || 'Series', values: (s.values || []).map((v) => (v == null || v === '' ? null : num(v))), color: s.color || null }))
      : [{ name: 'Series 1', values: [], color: null }],
    colors: Array.isArray(c.colors) ? c.colors.slice() : [],
    // Per-point custom text annotations, keyed by point id ("p{i}" for pie-like,
    // "s{si}p{pi}" for cartesian). Lets a user click a bar/slice and type their own
    // label/number. Kept in the ONE model so it round-trips like all other data.
    pointLabels: (c.pointLabels && typeof c.pointLabels === 'object' && !Array.isArray(c.pointLabels)) ? { ...c.pointLabels } : {},
    width: c.width || 480, height: c.height || 320, rotation: c.rotation || 0,
    options: o,
  };
}

/* Per-point annotation helpers (used by every family renderer):
 *  - chartHot: record a clickable hotspot (SVG coords) so the editor can hit-test.
 *  - chartLabel: draw the user's custom flat/horizontal label at a point (with a white
 *    halo so it stays legible on any bar/slice colour). Empty label → nothing drawn. */
const chartHot = (g, id, x, y) => { if (g && g.hot) g.hot.push({ id, x: n2(x), y: n2(y) }); };
// Flat, horizontal, halo'd text so it stays legible on any bar/slice colour (2D or 3D).
const chartText = (x, y, txt) => `<text x="${n2(x)}" y="${n2(y)}" font-size="12" text-anchor="middle" dominant-baseline="middle" fill="#111827" font-weight="700" paint-order="stroke" stroke="#ffffff" stroke-width="3.4" stroke-linejoin="round">${esc(String(txt))}</text>`;
const chartLabel = (c, id, x, y) => {
  const t = c.pointLabels && c.pointLabels[id];
  return (t == null || t === '') ? '' : chartText(x, y, t);
};
// A placeholder value (an unfilled cell) drives geometry but must NEVER draw a data label.
const isPh = (v) => v != null && typeof v === 'object' && v.__ph === true;
// The uniform per-point label for EVERY chart type: a user's custom text wins, else the
// data value when Data Labels is on. Same call in every renderer → consistent behaviour.
const ptLabel = (c, o, id, x, y, value) => {
  const t = c.pointLabels && c.pointLabels[id];
  if (t != null && t !== '') return chartText(x, y, t);
  if (o.showDataLabels && value != null && value !== '' && !isPh(value) && Number.isFinite(+value)) return chartText(x, y, `${n2(value)}${o.valueUnit || ''}`);
  return '';
};

function polar(cx, cy, r, deg) {
  const a = (deg - 90) * Math.PI / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}
function arc(cx, cy, r, a0, a1) {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z`;
}
function donutArc(cx, cy, r, ri, a0, a1) {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  const [ix1, iy1] = polar(cx, cy, ri, a1);
  const [ix0, iy0] = polar(cx, cy, ri, a0);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} L ${ix1} ${iy1} A ${ri} ${ri} 0 ${large} 0 ${ix0} ${iy0} Z`;
}
function niceMax(v) {
  if (v <= 0) return 10;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag * Math.ceil(v / (step * mag));
}

/**
 * Resolve the value-axis scale from the options + the data range.
 *  • Auto (default): min 0 → a "nice" rounded max, 5 ticks — unchanged behaviour.
 *  • Custom: the user's min / max / interval, validated so the chart never breaks
 *    (max forced above min, tick count derived from the interval and clamped so the
 *    labels stay legible / don't overlap).
 * Returns { min, max, ticks }.
 */
export function axisScale(o, dataMax, dataMin = 0) {
  o = o || {};
  if (o.axisAuto === false) {
    let min = Number(o.axisMin); if (!Number.isFinite(min)) min = 0;
    let max = Number(o.axisMax);
    if (!Number.isFinite(max) || max <= min) max = Math.max(niceMax(Math.max(dataMax, 1)), min + 1);
    const step = Number(o.axisStep);
    let ticks = (Number.isFinite(step) && step > 0) ? Math.round((max - min) / step) : 5;
    ticks = Math.max(1, Math.min(20, ticks));
    return { min, max, ticks };
  }
  return { min: Math.min(0, dataMin), max: niceMax(Math.max(1, dataMax)), ticks: 5 };
}

/** The value-axis scale for a series-based cartesian chart (line/area/combo). Honours
 *  Auto vs Custom via axisScale; a 100% chart is fixed 0–100. Returns { min, max,
 *  ticks, span }. */
function seriesScale(o, c, { stacked = false, pct = false } = {}) {
  if (pct) return { min: 0, max: 100, ticks: 5, span: 100 };
  const dataMax = stacked
    ? Math.max(1, ...(c.categories || []).map((_, ci) => sum(c.series.map((s) => s.values[ci] || 0))))
    : Math.max(1, ...c.series.flatMap((s) => (s.values || []).map((v) => Math.abs(v))));
  const s = axisScale(o, dataMax);
  return { ...s, span: (s.max - s.min) || 1 };
}

/** Format an axis tick number per the options (decimal places + optional thousands
 *  grouping). Falls back to the compact default when no format is set. */
function fmtAxisVal(v, o) {
  o = o || {};
  let n = Number(v); if (!Number.isFinite(n)) n = 0;
  const d = Number(o.axisDecimals);
  let s = (Number.isFinite(d) && d >= 0) ? n.toFixed(Math.min(6, d)) : String(n2(n));
  if (o.axisThousands) {
    const [ip, fp] = s.split('.');
    s = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fp != null ? `.${fp}` : '');
  }
  return s;
}
function textEl(x, y, str, { size = 12, anchor = 'middle', fill = '#334155', weight = 400 } = {}) {
  return `<text x="${n2(x)}" y="${n2(y)}" font-size="${size}" text-anchor="${anchor}" fill="${fill}" font-weight="${weight}" dominant-baseline="middle">${esc(str)}</text>`;
}
function darken(hex, amt = 0.18) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = Math.max(0, Math.round(((n >> 16) & 255) * (1 - amt)));
  const g = Math.max(0, Math.round(((n >> 8) & 255) * (1 - amt)));
  const b = Math.max(0, Math.round((n & 255) * (1 - amt)));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

const seriesColor = (c, i, pal) => c.series[i] && c.series[i].color ? c.series[i].color : pal[i % pal.length];
const pointColor = (c, i, pal) => (c.colors && c.colors[i]) || pal[i % pal.length];

/* --------------------------------- render --------------------------------- */

/** Render a chart spec to a standalone SVG string. */
export function renderChartSvg(rawChart, opts = {}) {
  const { width, height } = opts;
  const c = normalizeChart(rawChart);
  const W = Math.max(120, Math.round(width || c.width || 480));
  const H = Math.max(100, Math.round(height || c.height || 320));
  const o = c.options;
  const pal = PALETTES[o.palette] || PALETTES.office;
  const meta = TYPE_META[c.type] || TYPE_META.pie;
  // When the output is cropped to the content (opts.view), the full-canvas border
  // rect would only bleed in as a stray partial line (e.g. its top edge floating
  // above the plot). Suppress that frame while cropping — the document charts and
  // exports use it, so no cropped chart shows the leftover line.
  const cropping = !!(opts.view && opts.view.w > 0 && opts.view.h > 0);

  // Unfilled cells (null) mean "not typed yet" — NOT zero. Render them as a light, equal
  // placeholder so the chart stays whole while the user fills it in: a pie keeps all its
  // slices (instead of collapsing to one full-circle disc the moment a single value is
  // entered), bars/points don't vanish, and a blank insert is visible/editable. The
  // placeholder scales to a quarter of the largest real value so it's always visible but
  // never dominates the values you HAVE typed; an EXPLICIT 0 stays a real zero. While any
  // placeholder is in play the data isn't complete, so numeric value labels are held back
  // (no placeholder numbers leak onto the chart). Fully-typed data renders exactly as-is.
  const reals = [];
  for (const s of c.series) for (const v of (s.values || [])) if (v != null && Number.isFinite(+v) && +v !== 0) reals.push(Math.abs(+v));
  const ph = reals.length ? Math.max(...reals) * 0.25 : 6;
  const baseRows = Math.max(c.categories.length, ...c.series.map((s) => (s.values || []).length), 0);
  const rows = reals.length ? baseRows : Math.max(baseRows, 4); // a fresh/blank chart shows ≥4 placeholder points
  // A placeholder cell is a Number that ACTS like `ph` for every geometry/maths op but carries
  // a flag so label code (isPh) skips it. That's the fix for "I add a value but it won't show":
  // a value you HAVE typed draws its label normally, while the cells you haven't reached yet
  // stay as silent placeholder slices/bars (no collapse, and no fake numbers on them).
  const mkPh = () => Object.assign(new Number(ph), { __ph: true });
  c.series = c.series.map((s) => {
    const vals = (s.values || []).slice();
    for (let i = 0; i < rows; i += 1) { if (vals[i] == null) vals[i] = mkPh(); }
    return { ...s, values: vals };
  });
  while (c.categories.length < rows) c.categories.push('');

  const defs = [];
  if (o.gradient) {
    // A subtle top-lit gradient re-tinted per colour via CSS-less <linearGradient>.
    // We bake one per used colour on demand (see fillOf).
  }
  const usedGrad = new Map();
  const fillOf = (color) => {
    if (!o.gradient) return color;
    if (!usedGrad.has(color)) {
      const id = `g${usedGrad.size}`;
      usedGrad.set(color, id);
      defs.push(`<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${lighten(color, 0.22)}"/><stop offset="1" stop-color="${color}"/></linearGradient>`);
    }
    return `url(#${usedGrad.get(color)})`;
  };
  if (o.shadow) {
    defs.push('<filter id="csh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#0f172a" flood-opacity="0.18"/></filter>');
  }

  // ---- true-3D shading helpers (only used by d3 chart types) --------------
  // Per-colour lighting gradients: the TOP/lit face is a lightened tint, the
  // vertical SIDE walls are darkened so extrusions read as solid, shaded volume
  // (spec: top vs side must differ; side walls darker than top). Cached per
  // colour+kind so a chart adds only a handful of <defs>.
  const grad3dCache = new Map();
  const grad3d = (color, kind) => {
    const key = `${kind}|${color}`;
    if (grad3dCache.has(key)) return grad3dCache.get(key);
    const id = `s3${grad3dCache.size}`;
    let body;
    switch (kind) {
      case 'top': body = `<linearGradient id="${id}" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" stop-color="${lighten(color, 0.34)}"/><stop offset="1" stop-color="${lighten(color, 0.10)}"/></linearGradient>`; break;
      case 'side': body = `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${darken(color, 0.26)}"/><stop offset="1" stop-color="${darken(color, 0.48)}"/></linearGradient>`; break;
      case 'sideDark': body = `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${darken(color, 0.40)}"/><stop offset="1" stop-color="${darken(color, 0.58)}"/></linearGradient>`; break;
      case 'frontV': body = `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${lighten(color, 0.16)}"/><stop offset="1" stop-color="${darken(color, 0.08)}"/></linearGradient>`; break;
      case 'frontH': body = `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${lighten(color, 0.16)}"/><stop offset="1" stop-color="${darken(color, 0.10)}"/></linearGradient>`; break;
      case 'sphere': body = `<radialGradient id="${id}" cx="0.35" cy="0.30" r="0.75"><stop offset="0" stop-color="${lighten(color, 0.52)}"/><stop offset="0.55" stop-color="${color}"/><stop offset="1" stop-color="${darken(color, 0.34)}"/></radialGradient>`; break;
      default: body = `<linearGradient id="${id}"><stop offset="0" stop-color="${color}"/></linearGradient>`;
    }
    defs.push(body);
    const url = `url(#${id})`;
    grad3dCache.set(key, url);
    return url;
  };
  // Soft blurred contact shadow, added once per chart when any 3D body needs it.
  let blurAdded = false;
  const ensureBlur = () => {
    if (blurAdded) return; blurAdded = true;
    defs.push('<filter id="c3blur" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="3.2"/></filter>');
  };

  const parts = [];
  parts.push(`<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="7" fill="${o.background || 'none'}"${o.borderWidth && !cropping ? ` stroke="${o.borderColor}" stroke-width="${o.borderWidth}"` : ''}/>`);

  let top = 12, bottom = H - 12, left = 14, right = W - 14;
  if (o.showTitle && c.title) {
    parts.push(textEl(W / 2, top + 8, c.title, { size: Math.min(16, Math.max(12, W / 34)), weight: 700, fill: '#1e293b' }));
    top += 26;
  }

  // Legend items (per-point families → one per point; else → per series).
  const pieLike = PER_POINT_FAMILIES.includes(meta.family);
  const legend = [];
  if (o.showLegend) {
    if (pieLike) c.categories.forEach((lab, i) => legend.push({ label: lab, color: pointColor(c, i, pal) }));
    else c.series.forEach((s, i) => legend.push({ label: s.name, color: seriesColor(c, i, pal) }));
  }
  const legendPos = o.legendPos || 'bottom';
  let legendBox = null;
  let legendRows = null; // pre-computed wrapped rows for top/bottom legends
  if (legend.length) {
    if (legendPos === 'right') {
      legendBox = { x: right - 108, y: top, w: 108, h: bottom - top }; right -= 116;
    } else {
      // A horizontal legend WRAPS onto as many rows as it needs, so no item is ever
      // clipped off the right edge (e.g. "Category E" on a 5-slice pie). Reserve the
      // exact height the wrapped legend needs before the plot area is measured.
      const availW = right - left;
      legendRows = legendLayout(legend, availW);
      const h = legendRows.length * 16;
      if (legendPos === 'top') { legendBox = { x: left, y: top, w: availW, h }; top += h + 8; }
      else { legendBox = { x: left, y: bottom - h, w: availW, h }; bottom -= h + 8; }
    }
  }

  // Cartesian charts reserve bands ONLY for the elements that are actually shown, so
  // hiding an element immediately reclaims its space (no empty gaps). Category/value
  // tick labels sit ~14px past the plot; axis titles get their own outer band.
  const cartesian = ['bar', 'line', 'area', 'scatter', 'combo', 'waterfall', 'candlestick', 'pareto', 'histogram', 'boxplot', 'gantt', 'timeline', 'matrix'].includes(meta.family);
  if (cartesian && (o.showCatLabels || o.showAxis)) bottom -= 16; // tick-label band
  // Reserve a LEFT band for the labels that sit on the left edge — the numeric value
  // scale (vertical charts) or the category names (horizontal bars) — anchored to the
  // right of the axis. Without it a multi-character label ("1.6", "1000", "Category 2")
  // renders past the canvas edge and its leading characters are clipped.
  if (cartesian) {
    if (meta.horizontal && o.showCatLabels) left += 42;      // category names on the left
    else if (!meta.horizontal && o.showAxis) left += 30;     // numeric value scale on the left
  }
  if (cartesian && o.showAxisTitles) { bottom -= 15; top += 14; } // X title below, Y title above

  const plot = { x: left, y: top, w: Math.max(20, right - left), h: Math.max(20, bottom - top) };
  // If a hotspots array is passed in, renderers record each data point's click target
  // into it (SVG coords) so the editor can map a click → the point the user annotated.
  const g = { fillOf, pal, shadow: o.shadow, grad3d, ensureBlur, hot: Array.isArray(opts.hotspots) ? opts.hotspots : null };
  let body = '';
  try {
    switch (meta.family) {
      case 'pie': body = renderPie(c, meta, plot, g, o); break;
      case 'bar': body = renderBar(c, meta, plot, g, o); break;
      case 'line': body = renderLine(c, meta, plot, g, o); break;
      case 'area': body = renderArea(c, meta, plot, g, o); break;
      case 'scatter': body = renderScatter(c, meta, plot, g, o); break;
      case 'radar': body = renderRadar(c, meta, plot, g, o); break;
      case 'funnel': body = renderFunnel(c, meta, plot, g, o); break;
      case 'waterfall': body = renderWaterfall(c, meta, plot, g, o); break;
      case 'combo': body = renderCombo(c, meta, plot, g, o); break;
      case 'candlestick': body = renderCandle(c, meta, plot, g, o); break;
      case 'gauge': body = renderGauge(c, meta, plot, g, o); break;
      case 'kpi': body = renderKpi(c, meta, plot, g, o); break;
      case 'bullet': body = renderBullet(c, meta, plot, g, o); break;
      case 'pareto': body = renderPareto(c, meta, plot, g, o); break;
      case 'histogram': body = renderHistogram(c, meta, plot, g, o); break;
      case 'boxplot': body = renderBox(c, meta, plot, g, o); break;
      case 'heatmap': body = renderHeatmap(c, meta, plot, g, o); break;
      case 'matrix': body = renderMatrix(c, meta, plot, g, o); break;
      case 'treemap': body = renderTreemap(c, meta, plot, g, o); break;
      case 'sunburst': body = renderSunburst(c, meta, plot, g, o); break;
      case 'tree': body = renderTree(c, meta, plot, g, o); break;
      case 'gantt': body = renderGantt(c, meta, plot, g, o); break;
      case 'timeline': body = renderTimeline(c, meta, plot, g, o); break;
      default: body = renderPie(c, meta, plot, g, o);
    }
  } catch { body = textEl(W / 2, H / 2, 'Chart', { fill: '#94a3b8' }); }

  parts.push(body);
  if (legendBox) parts.push(legendPos === 'right' ? renderLegend(legend, legendBox, 'right') : renderLegendRows(legendRows, legendBox));

  // The decorative full-canvas background rect stays OUTSIDE the measurable content
  // group, so a caller can `getBBox()` the `.chart-content` group to learn the tight
  // bounds of the actual graphic (chart body + legend) and crop the object to it —
  // that's how an inserted chart fits its content instead of a large empty box.
  const bg = parts[0];
  const contentG = `<g class="chart-content">${parts.slice(1).join('')}</g>`;
  const inner = `${defs.length ? `<defs>${defs.join('')}</defs>` : ''}${bg}${contentG}`;
  const wrap = o.opacity < 1 ? `<g opacity="${n2(o.opacity)}">${inner}</g>` : inner;
  // `opts.view` crops the output to a sub-rectangle (the measured content box); the
  // SVG is then emitted at `outW`×`outH` so the picture fills the object with no
  // surrounding dead space. Without it, behaviour is unchanged (full W×H canvas).
  const v = opts.view && opts.view.w > 0 && opts.view.h > 0 ? opts.view : null;
  const vb = v ? `${n2(v.x)} ${n2(v.y)} ${n2(v.w)} ${n2(v.h)}` : `0 0 ${W} ${H}`;
  const outW = Math.max(1, Math.round(v ? (opts.outW || v.w) : W));
  const outH = Math.max(1, Math.round(v ? (opts.outH || v.h) : H));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}" viewBox="${vb}" font-family="Inter, Arial, sans-serif">${wrap}</svg>`;
}

function lighten(hex, amt = 0.2) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const mix = (ch) => Math.round(ch + (255 - ch) * amt);
  const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

// A vertical (right-side) legend. Clips over-long labels; wraps to the next line
// and stops when it runs out of vertical room.
function renderLegend(items, box) {
  const out = [];
  let y = box.y + 6;
  for (const it of items) {
    out.push(`<rect x="${box.x}" y="${y - 5}" width="11" height="11" rx="2" fill="${it.color}"/>`);
    out.push(textEl(box.x + 16, y + 1, clip(it.label, 12), { size: 11, anchor: 'start', fill: '#475569' }));
    y += 18;
    if (y > box.y + box.h) break;
  }
  return out.join('');
}

// Lay a horizontal legend out into rows that each fit within `maxW` (wrapping), so
// nothing overflows the chart. A single label wider than a row is clipped to fit.
const LEG = { sw: 11, iconGap: 4, itemGap: 14, cw: 5.9, lineH: 16 };
function legendLayout(items, maxW) {
  const { sw, iconGap, itemGap, cw } = LEG;
  const measure = (label) => sw + iconGap + Math.ceil(String(label).length * cw);
  const rows = [];
  let row = [], rowW = 0;
  for (const raw of items) {
    let label = raw.label == null ? '' : String(raw.label);
    let w = measure(label);
    if (w > maxW) { // a lone label too wide for the whole row → clip it
      const budget = Math.max(3, Math.floor((maxW - sw - iconGap) / cw));
      label = clip(label, budget); w = measure(label);
    }
    if (row.length && rowW + itemGap + w > maxW) { rows.push({ items: row, width: rowW }); row = []; rowW = 0; }
    if (row.length) rowW += itemGap;
    row.push({ label, color: raw.color, w });
    rowW += w;
  }
  if (row.length) rows.push({ items: row, width: rowW });
  return rows;
}
function renderLegendRows(rows, box) {
  if (!rows) return '';
  const { sw, iconGap, itemGap, lineH } = LEG;
  const out = [];
  rows.forEach((r, ri) => {
    let x = box.x + Math.max(0, (box.w - r.width) / 2);
    const y = box.y + lineH * ri + lineH / 2;
    for (const it of r.items) {
      out.push(`<rect x="${n2(x)}" y="${n2(y - 5.5)}" width="${sw}" height="${sw}" rx="2" fill="${it.color}"/>`);
      out.push(textEl(x + sw + iconGap, y, it.label, { size: 11, anchor: 'start', fill: '#475569' }));
      x += it.w + itemGap;
    }
  });
  return out.join('');
}
const clip = (s, n) => { s = String(s); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

/* ---- pie / doughnut (+ exploded, +3D) ---- */
// The 3D path builds a genuinely extruded, tilted solid: a soft cast shadow, then
// front-facing side walls (shaded darker, per slice, so colours are preserved with
// auto-generated dark variants), then the lit top faces. Depth is proportional to
// the radius and scaled by options.threeD.depth; tilt by options.threeD.perspective.
// The flat 2D path is unchanged. Both share the label pass below.
function renderPie(c, meta, plot, g, o) {
  const values = (c.series[0] && c.series[0].values) || [];
  const total = sum(values) || 1;
  const cx = plot.x + plot.w / 2;
  const d3 = !!meta.d3;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ky = d3 ? clamp(0.60 - (o.threeD.perspective || 0) * 0.12, 0.42, 0.72) : 1; // vertical squash for the tilt
  const r = Math.min(plot.w / 2, (plot.h / (d3 ? 1.7 : 1)) / 2) * (d3 ? 0.92 : 0.86);
  const ry = r * ky;
  const ri = meta.doughnut ? r * 0.56 : 0;
  const riy = ri * ky;
  const depthFactor = clamp((o.threeD.depth || 16) / 16, 0.5, 2.5);
  const depth = d3 ? Math.max(12, Math.round(r * 0.34 * depthFactor)) : 0;
  const explodeAmt = meta.explode ? Math.max(10, r * (0.08 + (o.threeD.explode || 0) * 0.14)) : (o.threeD.explode ? r * o.threeD.explode * 0.14 : 0);
  const cy = plot.y + plot.h / 2 - depth / 2;
  const out = [];

  // Rotation spins the whole pie (start-angle offset); slice spacing opens an angular
  // gap on each side of every slice. Both drive the DRAWN angles (da0..da1) while the
  // raw angles/mid still position explode offsets and labels. Works for 2D and 3D.
  const spin = o.threeD.rotation || 0;
  const gap = Math.max(0, o.threeD.spacing || 0) * 5;
  let a = spin;
  const slices = values.map((v, i) => {
    const frac = (Number(v) || 0) / total;
    const a0 = a; const a1 = a + frac * 360; a = a1;
    const gp = (a1 - a0) > gap * 2.2 ? gap : 0;
    return { i, v, a0, a1, da0: a0 + gp, da1: a1 - gp, mid: (a0 + a1) / 2, color: pointColor(c, i, g.pal) };
  });

  const cxy = (mid) => {
    if (!explodeAmt) return [cx, cy];
    const [dx, dy] = polar(0, 0, explodeAmt, mid);
    return [cx + dx, cy + dy * ky];
  };
  // Point on the tilted (squashed) ellipse. deg: 0 = top, 90 = right, 180 = bottom.
  const ell = (ecx, ecy, rr, rry, deg) => { const t = (deg - 90) * Math.PI / 180; return [ecx + rr * Math.cos(t), ecy + rry * Math.sin(t)]; };

  if (!d3) {
    // -------- flat 2D pie / doughnut (unchanged) --------
    for (const s of slices) {
      if (s.a1 - s.a0 < 0.05) continue;
      const [ecx, ecy] = cxy(s.mid);
      const path = meta.doughnut ? donutArc(ecx, ecy, r, ri, s.da0, s.da1) : arc(ecx, ecy, r, s.da0, s.da1);
      out.push(`<path d="${path}" fill="${g.fillOf(s.color)}" stroke="#ffffff" stroke-width="1.5"${g.shadow ? ' filter="url(#csh)"' : ''}/>`);
    }
  } else {
    // -------- true 3D pie / doughnut --------
    const step = 4; // angular stepping (deg) for the extruded walls
    // 1) soft cast shadow on the floor beneath the solid
    g.ensureBlur();
    out.push(`<ellipse cx="${n2(cx)}" cy="${n2(cy + depth + ry * 0.24)}" rx="${n2(r * 1.06)}" ry="${n2(ry * 0.72)}" fill="#0b1220" opacity="0.18" filter="url(#c3blur)"/>`);
    // 2) outer side wall — only the front-facing rim (screen deg 90..270), per slice
    for (const s of slices) {
      if (s.a1 - s.a0 < 0.2) continue;
      const [ecx, ecy] = cxy(s.mid);
      const sideFill = g.grad3d(s.color, 'side');
      for (let d = s.da0; d < s.da1; d += step) {
        const d1 = Math.min(s.da1, d + step); const m = ((((d + d1) / 2) % 360) + 360) % 360;
        if (!(m > 90 && m < 270)) continue;
        const [x0, y0] = ell(ecx, ecy, r, ry, d); const [x1, y1] = ell(ecx, ecy, r, ry, d1);
        out.push(`<path d="M ${n2(x0)} ${n2(y0)} L ${n2(x1)} ${n2(y1)} L ${n2(x1)} ${n2(y1 + depth)} L ${n2(x0)} ${n2(y0 + depth)} Z" fill="${sideFill}"/>`);
      }
    }
    // 3) inner hole wall (doughnut) — the FAR rim descends visibly into the hole
    if (meta.doughnut) {
      for (const s of slices) {
        if (s.a1 - s.a0 < 0.2) continue;
        const [ecx, ecy] = cxy(s.mid);
        const innerFill = g.grad3d(s.color, 'sideDark');
        for (let d = s.da0; d < s.da1; d += step) {
          const d1 = Math.min(s.da1, d + step); const m = ((((d + d1) / 2) % 360) + 360) % 360;
          if (m > 90 && m < 270) continue;
          const [x0, y0] = ell(ecx, ecy, ri, riy, d); const [x1, y1] = ell(ecx, ecy, ri, riy, d1);
          out.push(`<path d="M ${n2(x0)} ${n2(y0)} L ${n2(x1)} ${n2(y1)} L ${n2(x1)} ${n2(y1 + depth)} L ${n2(x0)} ${n2(y0 + depth)} Z" fill="${innerFill}"/>`);
        }
      }
    }
    // 4) lit top faces — per slice, crisp white separators
    for (const s of slices) {
      if (s.a1 - s.a0 < 0.05) continue;
      const [ecx, ecy] = cxy(s.mid);
      const large = (s.da1 - s.da0 > 180) ? 1 : 0;
      const [ox0, oy0] = ell(ecx, ecy, r, ry, s.da0); const [ox1, oy1] = ell(ecx, ecy, r, ry, s.da1);
      let path;
      if (meta.doughnut) {
        const [ix1, iy1] = ell(ecx, ecy, ri, riy, s.da1); const [ix0, iy0] = ell(ecx, ecy, ri, riy, s.da0);
        path = `M ${n2(ox0)} ${n2(oy0)} A ${n2(r)} ${n2(ry)} 0 ${large} 1 ${n2(ox1)} ${n2(oy1)} L ${n2(ix1)} ${n2(iy1)} A ${n2(ri)} ${n2(riy)} 0 ${large} 0 ${n2(ix0)} ${n2(iy0)} Z`;
      } else {
        path = `M ${n2(ecx)} ${n2(ecy)} L ${n2(ox0)} ${n2(oy0)} A ${n2(r)} ${n2(ry)} 0 ${large} 1 ${n2(ox1)} ${n2(oy1)} Z`;
      }
      out.push(`<path d="${path}" fill="${g.grad3d(s.color, 'top')}" stroke="#ffffff" stroke-width="1.4" stroke-linejoin="round"/>`);
    }
    // 5) faint glossy highlight on the lit surface
    out.push(`<ellipse cx="${n2(cx - r * 0.24)}" cy="${n2(cy - ry * 0.42)}" rx="${n2(r * 0.5)}" ry="${n2(ry * 0.3)}" fill="#ffffff" opacity="0.12"/>`);
  }

  // Slice labels (category name and/or value/percent) — each independently toggled,
  // flat/horizontal text at the slice mid-radius, shared by 2D and 3D.
  if (o.showCatLabels || o.showDataLabels || o.showPercentLabels) {
    for (const s of slices) {
      if (s.a1 - s.a0 < 12) continue;
      const [ecx, ecy] = cxy(s.mid);
      const lr = meta.doughnut ? (r + ri) / 2 : r * 0.6;
      const [lx, ly0] = polar(ecx, ecy, lr, s.mid);
      const ly = ecy + (ly0 - ecy) * ky;
      const pct = ((Number(s.v) || 0) / total * 100);
      const showVal = !isPh(s.v); // an unfilled placeholder slice draws its name but no value/percent
      const dataTxt = (o.showPercentLabels && showVal) ? `${n2(pct)}%` : (o.showDataLabels && showVal ? `${n2(s.v)}${o.valueUnit || ''}` : '');
      const catTxt = o.showCatLabels ? clip(c.categories[s.i] || '', 14) : '';
      if (catTxt && dataTxt) {
        out.push(textEl(lx, ly - 6, catTxt, { size: 10, weight: 700, fill: '#ffffff' }));
        out.push(textEl(lx, ly + 7, dataTxt, { size: 10, weight: 600, fill: '#ffffff' }));
      } else if (catTxt || dataTxt) {
        out.push(textEl(lx, ly, catTxt || dataTxt, { size: 11, weight: 700, fill: '#ffffff' }));
      }
    }
  }
  // Per-slice hotspots + custom user labels (click a slice → type text/number).
  for (const s of slices) {
    if (s.a1 - s.a0 < 0.05) continue;
    const [ecx, ecy] = cxy(s.mid);
    const lr = meta.doughnut ? (r + ri) / 2 : r * 0.58;
    const [lx, ly0] = polar(ecx, ecy, lr, s.mid);
    const ly = ecy + (ly0 - ecy) * ky;
    const id = `p${s.i}`;
    chartHot(g, id, lx, ly);
    out.push(chartLabel(c, id, lx, ly));
  }
  return out.join('');
}

/* ---- shared cartesian frame (bar/line/area/scatter/combo) ---- */
// Each layer is independently toggled: gridlines (showGrid), axis lines + value scale
// (showAxis), category tick labels (showCat), and axis titles (titles.show). All text
// is flat/horizontal — including the Y-axis title, kept horizontal above the axis.
function axisFrame(plot, { xLabels, yMax, yMin = 0, showAxis, showGrid, showCat = true, horizontal = false, ticks = 5, titles = null, o = null }) {
  const out = [];
  const { x, y, w, h } = plot;
  // Tick numbers honour the custom number format (decimals / thousands) and label
  // font size when options are supplied; otherwise the compact default is used.
  const fmt = (v) => (o ? fmtAxisVal(v, o) : n2(v));
  const lblSize = (o && Number(o.axisLabelSize) > 0) ? Number(o.axisLabelSize) : 10;
  if (showGrid || showAxis) {
    for (let t = 0; t <= ticks; t += 1) {
      const val = yMin + (yMax - yMin) * (t / ticks);
      if (horizontal) {
        const gx = x + (w * t) / ticks;
        if (showGrid) out.push(`<line x1="${n2(gx)}" y1="${y}" x2="${n2(gx)}" y2="${y + h}" stroke="#eef2f7" stroke-width="1"/>`);
        if (showAxis) out.push(textEl(gx, y + h + 12, fmt(val), { size: lblSize, fill: '#94a3b8' }));
      } else {
        const gy = y + h - (h * t) / ticks;
        if (showGrid) out.push(`<line x1="${x}" y1="${n2(gy)}" x2="${x + w}" y2="${n2(gy)}" stroke="#eef2f7" stroke-width="1"/>`);
        if (showAxis) out.push(textEl(x - 6, gy, fmt(val), { size: lblSize, anchor: 'end', fill: '#94a3b8' }));
      }
    }
  }
  if (showAxis) {
    out.push(`<line x1="${x}" y1="${y + h}" x2="${x + w}" y2="${y + h}" stroke="#cbd5e1" stroke-width="1"/>`);
    out.push(`<line x1="${x}" y1="${y}" x2="${x}" y2="${y + h}" stroke="#cbd5e1" stroke-width="1"/>`);
  }
  if (showCat) {
    const n = xLabels.length;
    xLabels.forEach((lab, i) => {
      if (horizontal) {
        const ly = y + h - (h * (i + 0.5)) / n;
        out.push(textEl(x - 6, ly, clip(lab, 12), { size: 10, anchor: 'end', fill: '#64748b' }));
      } else {
        const lx = x + (w * (i + 0.5)) / n;
        out.push(textEl(lx, y + h + 12, clip(lab, 10), { size: 10, fill: '#64748b' }));
      }
    });
  }
  if (titles && titles.show) {
    if (titles.x) out.push(textEl(x + w / 2, y + h + (showCat ? 28 : 15), clip(titles.x, 40), { size: 11, weight: 700, fill: '#475569' }));
    if (titles.y) out.push(textEl(x - 2, y - 9, clip(titles.y, 24), { size: 11, weight: 700, anchor: 'start', fill: '#475569' }));
  }
  return out.join('');
}
// Shared axis-label/title options pulled from the chart spec (keeps call sites tidy).
const axisTitlesOf = (o) => ({ show: o.showAxisTitles, x: o.axisTitleX, y: o.axisTitleY });

/* ---- column / bar ---- */
function renderBar(c, meta, plot, g, o) {
  const horizontal = !!meta.horizontal;
  const stacked = !!meta.stacked;
  const pct = !!meta.pct;
  const cats = c.categories;
  const nSeries = c.series.length;
  const out = [];
  const axisLen = horizontal ? plot.w : plot.h;

  // Value-axis scale (Auto → 0…niceMax; Custom → the user's min/max/interval). A 100%
  // stacked chart is always 0–100 by definition, so it opts out of custom scaling.
  const dataMax = stacked
    ? Math.max(1, ...cats.map((_, ci) => sum(c.series.map((s) => s.values[ci] || 0))))
    : Math.max(1, ...c.series.flatMap((s) => s.values.map((v) => Math.abs(v))));
  const sc = (stacked && pct) ? { min: 0, max: 100, ticks: 5 } : axisScale(o, dataMax);
  const yMax = sc.max, yMin = sc.min, span = (sc.max - sc.min) || 1;
  // A bar's height as a fraction of the plot: zero-based scales keep the original
  // magnitude look; a custom min>0 makes bars rise from that floor.
  const barFrac = (v) => (yMin > 0
    ? Math.max(0, Math.min(1, (v - yMin) / span))
    : Math.min(1, Math.abs(v) / (yMax || 1)));
  out.push(axisFrame(plot, { xLabels: cats, yMax, yMin, ticks: sc.ticks, o, showAxis: o.showAxis, showGrid: o.showGridlines, showCat: o.showCatLabels, titles: axisTitlesOf(o), horizontal }));

  const slot = (horizontal ? plot.h : plot.w) / Math.max(1, cats.length);
  // Substantial, size-proportional extrusion (capped to the slot so bars never collide).
  const depth = meta.d3 ? Math.max(10, Math.min((o.threeD.depth || 16) * 0.9, slot * 0.42)) : 0;
  const groupW = slot * 0.7;

  // Each bar records a hotspot (front-face centre) + optional custom label, so a user
  // can click that exact bar and type their own text/number on it.
  const annos = [];
  const annotate = (si, ci, x, y, w, h) => {
    const id = `s${si}p${ci}`;
    chartHot(g, id, x + w / 2, y + h / 2);
    // Label reads the RAW cell (so a placeholder/unfilled bar draws no number) — geometry
    // above already used the coerced value for the bar size.
    const raw = c.series[si] && c.series[si].values[ci];
    const dxo = depth ? depth / 2 : 0;
    // Placement: a stacked segment keeps its number centred inside the segment; a
    // plain column/bar puts it just OUTSIDE the bar — above the top (columns) or past
    // the end (bars) — on the white plot, so multi-digit numbers and custom text read
    // cleanly instead of being squeezed inside a narrow bar. Clamped to the plot so a
    // full-height/near-edge bar keeps its label just inside instead of spilling out.
    let lx = x + w / 2 + dxo;
    let ly = y + h / 2 - dxo;
    if (!stacked) {
      if (horizontal) {
        const end = x + w;
        lx = end + 15 + dxo;
        if (lx > plot.x + plot.w - 4) lx = Math.max(x + 15, end - 15) + dxo; // near right edge → inside
      } else {
        const top = y - (depth || 0);
        ly = top - 9;
        if (ly < plot.y + 9) ly = y + 13; // near the ceiling → just inside the top
      }
    }
    annos.push(ptLabel(c, o, id, lx, ly, raw));
  };

  cats.forEach((cat, ci) => {
    const total = pct ? (sum(c.series.map((s) => s.values[ci] || 0)) || 1) : 1;
    let acc = 0;
    const barW = stacked ? groupW : groupW / nSeries;
    c.series.forEach((s, si) => {
      let v = Number(s.values[ci]) || 0;
      const color = seriesColor(c, si, g.pal);
      if (stacked) {
        const val = pct ? (v / total) * 100 : v;
        const len = (val / yMax) * axisLen;
        if (horizontal) {
          const yc = plot.y + plot.h - slot * (ci + 0.5) - groupW / 2;
          const x0 = plot.x + (acc / yMax) * axisLen;
          out.push(bar3d(x0, yc, len, groupW, color, depth, false, g, o)); annotate(si, ci, x0, yc, len, groupW, v);
        } else {
          const xc = plot.x + slot * (ci + 0.5) - groupW / 2;
          const y0 = plot.y + plot.h - (acc / yMax) * axisLen - len;
          out.push(bar3d(xc, y0, groupW, len, color, depth, true, g, o)); annotate(si, ci, xc, y0, groupW, len, v);
        }
        acc += val;
      } else {
        const len = barFrac(v) * axisLen;
        if (horizontal) {
          const yc = plot.y + plot.h - slot * (ci + 0.5) - groupW / 2 + si * barW;
          out.push(bar3d(plot.x, yc, len, barW * 0.86, color, depth, false, g, o)); annotate(si, ci, plot.x, yc, len, barW * 0.86, v);
        } else {
          const xc = plot.x + slot * (ci + 0.5) - groupW / 2 + si * barW;
          const y0 = plot.y + plot.h - len;
          out.push(bar3d(xc, y0, barW * 0.86, len, color, depth, true, g, o)); annotate(si, ci, xc, y0, barW * 0.86, len, v);
        }
      }
    });
  });
  out.push(annos.join('')); // data values + custom labels, centred on each bar
  return out.join('');
}
// A single 3D box: extruded up-and-back with a lit top face, a darker side face and
// a gradient front face (vertical or horizontal to match column/bar orientation),
// plus a soft contact shadow so the box clearly sits on the plot floor.
// The extruded faces themselves carry the depth (no per-bar cast shadow — that would
// float mid-column on stacked bars, and Office 3D bars sit on a floor, not a shadow).
function bar3d(x, y, w, h, color, depth, vertical, g, o) {
  const sh = g.shadow ? ' filter="url(#csh)"' : '';
  if (!depth) return `<rect x="${n2(x)}" y="${n2(y)}" width="${n2(w)}" height="${n2(h)}" rx="1.5" fill="${g.fillOf(color)}"${sh}/>`;
  const d = depth;
  const topP = `<path d="M ${n2(x)} ${n2(y)} l ${n2(d)} ${n2(-d)} l ${n2(w)} 0 l ${n2(-d)} ${n2(d)} Z" fill="${g.grad3d(color, 'top')}"/>`;
  const sideP = `<path d="M ${n2(x + w)} ${n2(y)} l ${n2(d)} ${n2(-d)} l 0 ${n2(h)} l ${n2(-d)} ${n2(d)} Z" fill="${g.grad3d(color, 'side')}"/>`;
  const face = `<rect x="${n2(x)}" y="${n2(y)}" width="${n2(w)}" height="${n2(h)}" fill="${g.grad3d(color, vertical ? 'frontV' : 'frontH')}"/>`;
  const edge = `<rect x="${n2(x)}" y="${n2(y)}" width="${n2(w)}" height="1.4" fill="rgba(255,255,255,0.4)"/>`;
  return `<g${sh}>${sideP}${topP}${face}${edge}</g>`;
}

/* ---- line ---- */
function renderLine(c, meta, plot, g, o) {
  if (meta.d3) return renderLine3d(c, meta, plot, g, o);
  const cats = c.categories;
  const stacked = !!meta.stacked;
  const out = [];
  const cum = cats.map(() => 0);
  const sc = seriesScale(o, c, { stacked });
  const yMax = sc.max, yMin = sc.min, span = sc.span;
  out.push(axisFrame(plot, { xLabels: cats, yMax, yMin, ticks: sc.ticks, o, showAxis: o.showAxis, showGrid: o.showGridlines, showCat: o.showCatLabels, titles: axisTitlesOf(o) }));
  const px = (i) => plot.x + (plot.w * (i + 0.5)) / Math.max(1, cats.length);
  const py = (v) => plot.y + plot.h - ((v - yMin) / span) * plot.h;
  c.series.forEach((s, si) => {
    const color = seriesColor(c, si, g.pal);
    const pts = cats.map((_, i) => {
      const v = (Number(s.values[i]) || 0) + (stacked ? cum[i] : 0);
      if (stacked) cum[i] = v;
      return [px(i), py(v)];
    });
    const d = meta.smooth ? smoothPath(pts) : pts.map((p, i) => `${i ? 'L' : 'M'} ${n2(p[0])} ${n2(p[1])}`).join(' ');
    out.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`);
    if (meta.markers) pts.forEach((p) => out.push(`<circle cx="${n2(p[0])}" cy="${n2(p[1])}" r="3.4" fill="#fff" stroke="${color}" stroke-width="2"/>`));
    pts.forEach((p, i) => { const id = `s${si}p${i}`; chartHot(g, id, p[0], p[1]); out.push(ptLabel(c, o, id, p[0], p[1] - 13, s.values[i])); });
  });
  return out.join('');
}
function smoothPath(pts) {
  if (pts.length < 2) return pts.map((p, i) => `${i ? 'L' : 'M'} ${n2(p[0])} ${n2(p[1])}`).join(' ');
  let d = `M ${n2(pts[0][0])} ${n2(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${n2(c1x)} ${n2(c1y)}, ${n2(c2x)} ${n2(c2y)}, ${n2(p2[0])} ${n2(p2[1])}`;
  }
  return d;
}

/* ---- 3D line: each series is an extruded ribbon (front line + depth top strip) ---- */
function renderLine3d(c, meta, plot, g, o) {
  const cats = c.categories;
  const stacked = !!meta.stacked;
  const out = [];
  const cum = cats.map(() => 0);
  const sc = seriesScale(o, c, { stacked });
  const yMin = sc.min, span = sc.span;
  out.push(axisFrame(plot, { xLabels: cats, yMax: sc.max, yMin, ticks: sc.ticks, o, showAxis: o.showAxis, showGrid: o.showGridlines, showCat: o.showCatLabels, titles: axisTitlesOf(o) }));
  const depth = Math.max(10, (o.threeD.depth || 16) * 0.7);
  const dx = depth * 0.8, dy = -depth * 0.8;
  const px = (i) => plot.x + (plot.w * (i + 0.5)) / Math.max(1, cats.length);
  const py = (v) => plot.y + plot.h - ((v - yMin) / span) * plot.h;
  c.series.forEach((s, si) => {
    const color = seriesColor(c, si, g.pal);
    const pts = cats.map((_, i) => {
      const v = (Number(s.values[i]) || 0) + (stacked ? cum[i] : 0);
      if (stacked) cum[i] = v;
      return [px(i), py(v)];
    });
    const back = pts.map((p) => [p[0] + dx, p[1] + dy]);
    // The ribbon's top surface: the band swept between the front and back polylines.
    let band = pts.map((p, i) => `${i ? 'L' : 'M'} ${n2(p[0])} ${n2(p[1])}`).join(' ');
    for (let i = back.length - 1; i >= 0; i -= 1) band += ` L ${n2(back[i][0])} ${n2(back[i][1])}`;
    out.push(`<path d="${band} Z" fill="${g.grad3d(color, 'top')}" fill-opacity="0.95"/>`);
    out.push(`<path d="${back.map((p, i) => `${i ? 'L' : 'M'} ${n2(p[0])} ${n2(p[1])}`).join(' ')}" fill="none" stroke="${lighten(color, 0.25)}" stroke-width="1.4"/>`);
    out.push(`<path d="${pts.map((p, i) => `${i ? 'L' : 'M'} ${n2(p[0])} ${n2(p[1])}`).join(' ')}" fill="none" stroke="${darken(color, 0.06)}" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>`);
    if (meta.markers) pts.forEach((p) => out.push(`<circle cx="${n2(p[0])}" cy="${n2(p[1])}" r="3.4" fill="${g.grad3d(color, 'sphere')}" stroke="#fff" stroke-width="1"/>`));
    pts.forEach((p, i) => { const id = `s${si}p${i}`; chartHot(g, id, p[0], p[1]); out.push(ptLabel(c, o, id, p[0] + dx / 2, p[1] + dy / 2 - 12, s.values[i])); });
  });
  return out.join('');
}

/* ---- area ---- */
function renderArea(c, meta, plot, g, o) {
  if (meta.d3) return renderArea3d(c, meta, plot, g, o);
  const cats = c.categories;
  const stacked = !!meta.stacked;
  const pct = !!meta.pct;
  const out = [];
  const sc = seriesScale(o, c, { stacked, pct });
  const yMax = sc.max, yMin = sc.min, span = sc.span;
  out.push(axisFrame(plot, { xLabels: cats, yMax, yMin, ticks: sc.ticks, o, showAxis: o.showAxis, showGrid: o.showGridlines, showCat: o.showCatLabels, titles: axisTitlesOf(o) }));
  const px = (i) => plot.x + (plot.w * (i + 0.5)) / Math.max(1, cats.length);
  const py = (v) => plot.y + plot.h - ((v - yMin) / span) * plot.h;
  const cum = cats.map(() => 0);
  c.series.forEach((s, si) => {
    const color = seriesColor(c, si, g.pal);
    const base = cats.map((_, i) => cum[i]);
    const tops = cats.map((_, i) => {
      const raw = Number(s.values[i]) || 0;
      const val = stacked ? (pct ? (raw / (sum(c.series.map((ss) => ss.values[i] || 0)) || 1)) * 100 : raw) : raw;
      cum[i] += val;
      return cum[i];
    });
    let d = tops.map((v, i) => `${i ? 'L' : 'M'} ${n2(px(i))} ${n2(py(v))}`).join(' ');
    for (let i = cats.length - 1; i >= 0; i -= 1) d += ` L ${n2(px(i))} ${n2(py(stacked ? base[i] : yMin))}`;
    d += ' Z';
    out.push(`<path d="${d}" fill="${g.fillOf(color)}" fill-opacity="${stacked ? 0.9 : 0.55}" stroke="${color}" stroke-width="2"/>`);
    tops.forEach((v, i) => { const id = `s${si}p${i}`; chartHot(g, id, px(i), py(v)); out.push(ptLabel(c, o, id, px(i), py(v) - 12, s.values[i])); });
  });
  return out.join('');
}

/* ---- 3D area: each series is an extruded slab (back face, top strip, side cap, lit front) ---- */
function renderArea3d(c, meta, plot, g, o) {
  const cats = c.categories;
  const stacked = !!meta.stacked;
  const pct = !!meta.pct;
  const out = [];
  const sc = seriesScale(o, c, { stacked, pct });
  const yMin = sc.min, span = sc.span;
  out.push(axisFrame(plot, { xLabels: cats, yMax: sc.max, yMin, ticks: sc.ticks, o, showAxis: o.showAxis, showGrid: o.showGridlines, showCat: o.showCatLabels, titles: axisTitlesOf(o) }));
  const depth = Math.max(12, (o.threeD.depth || 16) * 0.8);
  const dx = depth * 0.8, dy = -depth * 0.8;
  const px = (i) => plot.x + (plot.w * (i + 0.5)) / Math.max(1, cats.length);
  const py = (v) => plot.y + plot.h - ((v - yMin) / span) * plot.h;
  const base = plot.y + plot.h;
  const cum = cats.map(() => 0);
  g.ensureBlur();
  c.series.forEach((s, si) => {
    const color = seriesColor(c, si, g.pal);
    const b = cats.map((_, i) => cum[i]);
    const tops = cats.map((_, i) => {
      const raw = Number(s.values[i]) || 0;
      const val = stacked ? (pct ? (raw / (sum(c.series.map((ss) => ss.values[i] || 0)) || 1)) * 100 : raw) : raw;
      cum[i] += val;
      return cum[i];
    });
    const front = tops.map((v, i) => [px(i), py(v)]);
    const baseFront = cats.map((_, i) => [px(i), stacked ? py(b[i]) : base]);
    const off = (p) => [p[0] + dx, p[1] + dy];
    const back = front.map(off);
    const backBase = baseFront.map(off);
    const li = front.length - 1;
    // back face (darkest, drawn first)
    let dBack = back.map((p, i) => `${i ? 'L' : 'M'} ${n2(p[0])} ${n2(p[1])}`).join(' ');
    for (let i = backBase.length - 1; i >= 0; i -= 1) dBack += ` L ${n2(backBase[i][0])} ${n2(backBase[i][1])}`;
    out.push(`<path d="${dBack} Z" fill="${darken(color, 0.32)}"/>`);
    // top strip along the crest (lit)
    let strip = front.map((p, i) => `${i ? 'L' : 'M'} ${n2(p[0])} ${n2(p[1])}`).join(' ');
    for (let i = front.length - 1; i >= 0; i -= 1) strip += ` L ${n2(back[i][0])} ${n2(back[i][1])}`;
    out.push(`<path d="${strip} Z" fill="${g.grad3d(color, 'top')}"/>`);
    // right-end side cap
    out.push(`<path d="M ${n2(front[li][0])} ${n2(front[li][1])} L ${n2(back[li][0])} ${n2(back[li][1])} L ${n2(backBase[li][0])} ${n2(backBase[li][1])} L ${n2(baseFront[li][0])} ${n2(baseFront[li][1])} Z" fill="${g.grad3d(color, 'side')}"/>`);
    // lit front face
    let df = front.map((p, i) => `${i ? 'L' : 'M'} ${n2(p[0])} ${n2(p[1])}`).join(' ');
    for (let i = baseFront.length - 1; i >= 0; i -= 1) df += ` L ${n2(baseFront[i][0])} ${n2(baseFront[i][1])}`;
    out.push(`<path d="${df} Z" fill="${g.grad3d(color, 'frontV')}" fill-opacity="0.96" stroke="${darken(color, 0.08)}" stroke-width="1"/>`);
    front.forEach((p, i) => { const id = `s${si}p${i}`; chartHot(g, id, p[0], p[1]); out.push(ptLabel(c, o, id, p[0] + dx / 2, p[1] + dy / 2 - 10, s.values[i])); });
  });
  return out.join('');
}

/* ---- scatter / bubble ---- */
function renderScatter(c, meta, plot, g, o) {
  const cats = c.categories;
  const d3 = !!meta.d3;
  const out = [];
  const xs = cats.map((v, i) => (Number.isFinite(+v) ? +v : i + 1));
  const xMax = niceMax(Math.max(1, ...xs));
  const ySeries = c.series[0] ? c.series[0].values : [];
  const scY = axisScale(o, Math.max(1, ...ySeries.map((v) => Math.abs(v))));
  const yMax = scY.max, yMin = scY.min, ySpan = (scY.max - scY.min) || 1;
  out.push(axisFrame(plot, { xLabels: cats, yMax, yMin, ticks: scY.ticks, o, showAxis: o.showAxis, showGrid: o.showGridlines, showCat: o.showCatLabels, titles: axisTitlesOf(o) }));
  const px = (v) => plot.x + (v / xMax) * plot.w;
  const py = (v) => plot.y + plot.h - ((v - yMin) / ySpan) * plot.h;
  const color = seriesColor(c, 0, g.pal);
  const pts = xs.map((x, i) => [px(x), py(Number(ySeries[i]) || 0)]);
  if (meta.lines) out.push(`<path d="${pts.map((p, i) => `${i ? 'L' : 'M'} ${n2(p[0])} ${n2(p[1])}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2"/>`);
  const sizeS = meta.bubble && c.series[1] ? c.series[1].values : null;
  const sMax = sizeS ? Math.max(1, ...sizeS.map((v) => Math.abs(v))) : 1;
  if (d3) g.ensureBlur();
  pts.forEach((p, i) => {
    const r = sizeS ? 4 + (Math.abs(Number(sizeS[i]) || 0) / sMax) * 16 : (d3 ? 6.5 : 4.5);
    if (d3) {
      // Shaded sphere sitting on a soft contact shadow — reads as a 3D marker.
      out.push(`<ellipse cx="${n2(p[0])}" cy="${n2(p[1] + r * 0.92)}" rx="${n2(r * 0.9)}" ry="${n2(r * 0.32)}" fill="#0b1220" opacity="0.16" filter="url(#c3blur)"/>`);
      out.push(`<circle cx="${n2(p[0])}" cy="${n2(p[1])}" r="${n2(r)}" fill="${g.grad3d(color, 'sphere')}" stroke="${darken(color, 0.2)}" stroke-width="0.6"/>`);
      out.push(`<ellipse cx="${n2(p[0] - r * 0.3)}" cy="${n2(p[1] - r * 0.32)}" rx="${n2(r * 0.32)}" ry="${n2(r * 0.22)}" fill="#ffffff" opacity="0.5"/>`);
    } else {
      out.push(`<circle cx="${n2(p[0])}" cy="${n2(p[1])}" r="${n2(r)}" fill="${g.fillOf(color)}" fill-opacity="${sizeS ? 0.6 : 0.9}" stroke="${darken(color)}" stroke-width="1"/>`);
    }
    const id = `s0p${i}`; chartHot(g, id, p[0], p[1]); out.push(ptLabel(c, o, id, p[0], p[1] - r - 10, ySeries[i]));
  });
  return out.join('');
}

/* ---- radar ---- */
function renderRadar(c, meta, plot, g, o) {
  const cats = c.categories;
  const n = cats.length || 1;
  const cx = plot.x + plot.w / 2, cy = plot.y + plot.h / 2;
  const r = Math.min(plot.w, plot.h) / 2 * 0.82;
  const out = [];
  const yMax = niceMax(Math.max(1, ...c.series.flatMap((s) => s.values.map((v) => Math.abs(v)))));
  const rings = 4;
  for (let t = 1; t <= rings; t += 1) {
    const rr = (r * t) / rings;
    const poly = cats.map((_, i) => polar(cx, cy, rr, (360 * i) / n)).map((p) => `${n2(p[0])},${n2(p[1])}`).join(' ');
    out.push(`<polygon points="${poly}" fill="none" stroke="#e2e8f0" stroke-width="1"/>`);
  }
  cats.forEach((lab, i) => {
    const [ax, ay] = polar(cx, cy, r, (360 * i) / n);
    out.push(`<line x1="${cx}" y1="${cy}" x2="${n2(ax)}" y2="${n2(ay)}" stroke="#e2e8f0" stroke-width="1"/>`);
    if (o.showCatLabels) {
      const [lx, ly] = polar(cx, cy, r + 12, (360 * i) / n);
      out.push(textEl(lx, ly, clip(lab, 10), { size: 10, fill: '#64748b' }));
    }
  });
  c.series.forEach((s, si) => {
    const color = seriesColor(c, si, g.pal);
    const verts = cats.map((_, i) => polar(cx, cy, r * (Number(s.values[i]) || 0) / yMax, (360 * i) / n));
    out.push(`<polygon points="${verts.map((p) => `${n2(p[0])},${n2(p[1])}`).join(' ')}" fill="${color}" fill-opacity="0.22" stroke="${color}" stroke-width="2"/>`);
    verts.forEach((p, i) => { const id = `s${si}p${i}`; chartHot(g, id, p[0], p[1]); out.push(ptLabel(c, o, id, p[0], p[1] - 10, s.values[i])); });
  });
  return out.join('');
}

/* ---- funnel ---- */
function renderFunnel(c, meta, plot, g, o) {
  const cats = c.categories;
  const vals = (c.series[0] && c.series[0].values) || [];
  const maxV = Math.max(1, ...vals.map((v) => Math.abs(v)));
  const out = [];
  const n = vals.length || 1;
  const rowH = plot.h / n;
  const cx = plot.x + plot.w / 2;
  const wOf = (v) => (Math.abs(v) / maxV) * plot.w * 0.9;
  for (let i = 0; i < n; i += 1) {
    const y0 = plot.y + rowH * i + 4;
    const y1 = plot.y + rowH * (i + 1) - 4;
    const w0 = wOf(vals[i]);
    const w1 = wOf(i + 1 < n ? vals[i + 1] : vals[i]);
    const color = pointColor(c, i, g.pal);
    if (meta.d3) {
      // Extruded 3D slab: front face + darker bottom edge + side, for real depth.
      const d = Math.max(9, (o.threeD.depth || 16) * 0.7), dx = d * 0.9, dy = -d * 0.7;
      out.push(`<path d="M ${n2(cx - w0 / 2)} ${n2(y0)} l ${n2(dx)} ${n2(dy)} l ${n2(w0)} 0 l ${n2(-dx)} ${n2(-dy)} Z" fill="${g.grad3d(color, 'top')}"/>`);
      out.push(`<path d="M ${n2(cx + w0 / 2)} ${n2(y0)} l ${n2(dx)} ${n2(dy)} L ${n2(cx + w1 / 2 + dx)} ${n2(y1 + dy)} l ${n2(-dx)} ${n2(-dy)} Z" fill="${g.grad3d(color, 'side')}"/>`);
      out.push(`<path d="M ${n2(cx - w0 / 2)} ${n2(y0)} L ${n2(cx + w0 / 2)} ${n2(y0)} L ${n2(cx + w1 / 2)} ${n2(y1)} L ${n2(cx - w1 / 2)} ${n2(y1)} Z" fill="${g.grad3d(color, 'frontV')}"/>`);
    } else {
      out.push(`<path d="M ${n2(cx - w0 / 2)} ${n2(y0)} L ${n2(cx + w0 / 2)} ${n2(y0)} L ${n2(cx + w1 / 2)} ${n2(y1)} L ${n2(cx - w1 / 2)} ${n2(y1)} Z" fill="${g.fillOf(color)}"/>`);
    }
    // Stage/value text is independently toggleable (Category Labels / Data Labels).
    const parts = [];
    if (o.showCatLabels) parts.push(clip(cats[i] || '', 14));
    if ((o.showDataLabels || o.showPercentLabels) && !isPh(vals[i])) parts.push(`${n2(vals[i])}${o.valueUnit || ''}`);
    if (parts.length) out.push(textEl(cx, (y0 + y1) / 2, parts.join('  '), { size: 11, weight: 600, fill: '#fff' }));
    const id = `p${i}`; chartHot(g, id, cx, (y0 + y1) / 2); out.push(chartLabel(c, id, cx, (y0 + y1) / 2));
  }
  return out.join('');
}

/* ---- waterfall ---- */
function renderWaterfall(c, meta, plot, g, o) {
  const cats = c.categories;
  const deltas = (c.series[0] && c.series[0].values) || [];
  const out = [];
  let run = 0; const points = [];
  deltas.forEach((d, i) => { const start = i === 0 ? 0 : run; run += d; points.push({ start: i === 0 ? 0 : start, end: run, delta: d, first: i === 0 }); });
  const wvals = points.flatMap((p) => [p.start, p.end]);
  const sc = axisScale(o, Math.max(1, ...wvals), Math.min(0, ...wvals));
  const yMin = sc.min, span = (sc.max - sc.min) || 1;
  out.push(axisFrame(plot, { xLabels: cats, yMax: sc.max, yMin, ticks: sc.ticks, o, showAxis: o.showAxis, showGrid: o.showGridlines, showCat: o.showCatLabels, titles: axisTitlesOf(o) }));
  const slot = plot.w / Math.max(1, points.length);
  const bw = slot * 0.6;
  const py = (v) => plot.y + plot.h - ((v - yMin) / span) * plot.h;
  points.forEach((p, i) => {
    const x = plot.x + slot * (i + 0.5) - bw / 2;
    const top = py(Math.max(p.start, p.end));
    const h = Math.abs(py(p.start) - py(p.end));
    // Semantic default (start=grey, rise=green, fall=red) but a user-picked colour
    // (Colors popover / data editor) overrides it, so waterfall is fully editable too.
    const color = (c.colors && c.colors[i]) || (p.first ? '#64748b' : (p.delta >= 0 ? '#70AD47' : '#C00000'));
    const bh = Math.max(1, h);
    if (meta.d3) out.push(bar3d(x, top, bw, bh, color, Math.max(9, (o.threeD.depth || 16) * 0.7), true, g, o));
    else out.push(`<rect x="${n2(x)}" y="${n2(top)}" width="${n2(bw)}" height="${n2(bh)}" fill="${g.fillOf(color)}" rx="1"/>`);
    const id = `s0p${i}`; chartHot(g, id, x + bw / 2, top + bh / 2); out.push(ptLabel(c, o, id, x + bw / 2, top + bh / 2, p.delta));
  });
  return out.join('');
}

/* ---- combination (column + line) ---- */
function renderCombo(c, meta, plot, g, o) {
  const cats = c.categories;
  const out = [];
  const colSeries = c.series.filter((_, i) => i === 0);
  const lineSeries = c.series.filter((_, i) => i > 0);
  const sc = seriesScale(o, c);
  const yMax = sc.max, yMin = sc.min, span = sc.span;
  out.push(axisFrame(plot, { xLabels: cats, yMax, yMin, ticks: sc.ticks, o, showAxis: o.showAxis, showGrid: o.showGridlines, showCat: o.showCatLabels, titles: axisTitlesOf(o) }));
  const slot = plot.w / Math.max(1, cats.length);
  const bw = slot * 0.5;
  colSeries.forEach((s, si) => {
    const color = seriesColor(c, si, g.pal);
    cats.forEach((_, ci) => {
      const v = Number(s.values[ci]) || 0;
      const len = Math.max(0, Math.min(1, (v - yMin) / span)) * plot.h;
      const bx = plot.x + slot * (ci + 0.5) - bw / 2; const by = plot.y + plot.h - len;
      if (meta.d3) out.push(bar3d(bx, by, bw, len, color, Math.max(9, (o.threeD.depth || 16) * 0.7), true, g, o));
      else out.push(`<rect x="${n2(bx)}" y="${n2(by)}" width="${n2(bw)}" height="${n2(len)}" fill="${g.fillOf(color)}" rx="1.5"/>`);
      const id = `s${si}p${ci}`; chartHot(g, id, bx + bw / 2, by + len / 2); out.push(ptLabel(c, o, id, bx + bw / 2, by + len / 2, s.values[ci]));
    });
  });
  const px = (i) => plot.x + slot * (i + 0.5);
  const py = (v) => plot.y + plot.h - ((v - yMin) / span) * plot.h;
  lineSeries.forEach((s, si) => {
    const color = seriesColor(c, si + 1, g.pal);
    const pts = cats.map((_, i) => [px(i), py(Number(s.values[i]) || 0)]);
    out.push(`<path d="${pts.map((p, i) => `${i ? 'L' : 'M'} ${n2(p[0])} ${n2(p[1])}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2.6" stroke-linejoin="round"/>`);
    pts.forEach((p) => out.push(`<circle cx="${n2(p[0])}" cy="${n2(p[1])}" r="3.2" fill="#fff" stroke="${color}" stroke-width="2"/>`));
    pts.forEach((p, i) => { const id = `s${si + 1}p${i}`; chartHot(g, id, p[0], p[1]); out.push(ptLabel(c, o, id, p[0], p[1] - 13, s.values[i])); });
  });
  return out.join('');
}

/* ======================================================================== *
 *  Extended professional library — Financial / Business / Statistical /     *
 *  Hierarchy / Project families. All reuse the SAME model + helpers (axis,   *
 *  bar3d, grad3d, ptLabel/chartHot for editable per-point labels), so every  *
 *  new chart is fully data-driven, colour/label editable, 2D↔3D switchable.  *
 * ======================================================================== */

// Blend two hex colours (t: 0→a, 1→b) — used for heatmap intensity.
function mixColor(a, b, t) {
  const pa = /^#?([0-9a-f]{6})$/i.exec(a), pb = /^#?([0-9a-f]{6})$/i.exec(b);
  if (!pa || !pb) return b;
  const na = parseInt(pa[1], 16), nb = parseInt(pb[1], 16);
  const mix = (sh) => Math.round(((na >> sh) & 255) * (1 - t) + ((nb >> sh) & 255) * t);
  return `#${((mix(16) << 16) | (mix(8) << 8) | mix(0)).toString(16).padStart(6, '0')}`;
}
const fmtNum = (v) => { v = Number(v) || 0; const a = Math.abs(v); return a >= 1000 ? `${n2(v / 1000)}k` : `${n2(v)}`; };
// Compact slice-and-dice treemap layout (proportional rects, leaf order preserved).
function squarify(values, x, y, w, h) {
  const out = [];
  const rec = (vals, X, Y, W, H) => {
    if (!vals.length) return;
    if (vals.length === 1) { out.push({ x: X, y: Y, w: W, h: H }); return; }
    const t = vals.reduce((a, b) => a + b, 0) || 1;
    let acc = 0, idx = 0;
    for (; idx < vals.length - 1; idx += 1) { if (acc + vals[idx] >= t / 2) break; acc += vals[idx]; }
    // Clamp so BOTH halves keep at least one item — otherwise b is empty, a is the whole
    // list, and rec() recurses on the same vals/box forever (stack overflow). Guards any
    // distribution, including a dominant last value or near-equal placeholder data.
    idx = Math.min(vals.length - 1, Math.max(1, idx + 1));
    const a = vals.slice(0, idx), b = vals.slice(idx);
    const fa = a.reduce((p, q) => p + q, 0) / t;
    if (W >= H) { rec(a, X, Y, W * fa, H); rec(b, X + W * fa, Y, W * (1 - fa), H); }
    else { rec(a, X, Y, W, H * fa); rec(b, X, Y + H * fa, W, H * (1 - fa)); }
  };
  rec(values, x, y, w, h);
  return out;
}

/* ---- candlestick / OHLC / high-low-close / stock volume (+3D) ---- */
function renderCandle(c, meta, plot, g, o) {
  const cats = c.categories;
  const col = (i) => (c.series[i] && c.series[i].values) || [];
  const open = col(0), high = col(1), low = col(2), close = col(3), vol = col(4);
  const n = cats.length || open.length || 1;
  const out = [];
  const volMode = !!meta.volume;
  const priceH = volMode ? plot.h * 0.66 : plot.h;
  const pricePlot = { x: plot.x, y: plot.y, w: plot.w, h: priceH };
  const lows = low.map(num).filter(Number.isFinite), highs = high.map(num).filter(Number.isFinite);
  // Price axis auto-fits to the data's low→high band (not zero-based — that's how
  // financial charts read). A custom range overrides it via the shared scale.
  const dataLo = Math.min(...lows, ...open.map(num), ...close.map(num));
  const dataHi = Math.max(1, ...highs, ...open.map(num), ...close.map(num));
  let yMin, yMax, ticks = 5;
  if (o.axisAuto === false) { const sc = axisScale(o, dataHi, dataLo); yMin = sc.min; yMax = sc.max; ticks = sc.ticks; }
  else { yMin = Math.floor(dataLo * 0.98); yMax = niceMax(dataHi); }
  out.push(axisFrame(pricePlot, { xLabels: cats, yMin, yMax, ticks, o, showAxis: o.showAxis, showGrid: o.showGridlines, showCat: o.showCatLabels && !volMode, titles: axisTitlesOf(o) }));
  const slot = pricePlot.w / n, bw = slot * 0.5;
  const py = (v) => pricePlot.y + pricePlot.h - ((num(v) - yMin) / ((yMax - yMin) || 1)) * pricePlot.h;
  const UP = '#22a06b', DN = '#e04f5f';
  const depth = meta.d3 ? Math.max(8, (o.threeD.depth || 16) * 0.55) : 0;
  for (let i = 0; i < n; i += 1) {
    const xc = pricePlot.x + slot * (i + 0.5);
    const O = num(open[i]), H = num(high[i]), L = num(low[i]), C = num(close[i]);
    const color = (c.colors && c.colors[i]) || (C >= O ? UP : DN);
    out.push(`<line x1="${n2(xc)}" y1="${n2(py(H))}" x2="${n2(xc)}" y2="${n2(py(L))}" stroke="${darken(color, 0.1)}" stroke-width="1.4"/>`);
    if (meta.ohlc || meta.hlc) {
      if (meta.ohlc) out.push(`<line x1="${n2(xc - bw / 2)}" y1="${n2(py(O))}" x2="${n2(xc)}" y2="${n2(py(O))}" stroke="${color}" stroke-width="2.2"/>`);
      out.push(`<line x1="${n2(xc)}" y1="${n2(py(C))}" x2="${n2(xc + bw / 2)}" y2="${n2(py(C))}" stroke="${color}" stroke-width="2.2"/>`);
    } else {
      const yTop = py(Math.max(O, C)), bh = Math.max(2, Math.abs(py(O) - py(C)));
      if (depth) out.push(bar3d(xc - bw / 2, yTop, bw, bh, color, depth, true, g, o));
      else out.push(`<rect x="${n2(xc - bw / 2)}" y="${n2(yTop)}" width="${n2(bw)}" height="${n2(bh)}" fill="${g.fillOf(color)}" rx="1"/>`);
    }
    const id = `s0p${i}`; chartHot(g, id, xc, py((H + L) / 2)); out.push(ptLabel(c, o, id, xc, py(H) - 10, C));
  }
  if (volMode) {
    const vp = { x: plot.x, y: plot.y + priceH + 8, w: plot.w, h: plot.h - priceH - 8 };
    const vMax = niceMax(Math.max(1, ...vol.map((v) => Math.abs(num(v)))));
    for (let i = 0; i < n; i += 1) {
      const xc = vp.x + slot * (i + 0.5), vh = (num(vol[i]) / vMax) * vp.h;
      const color = num(close[i]) >= num(open[i]) ? UP : DN;
      if (depth) out.push(bar3d(xc - bw / 2, vp.y + vp.h - vh, bw, vh, color, depth * 0.6, true, g, o));
      else out.push(`<rect x="${n2(xc - bw / 2)}" y="${n2(vp.y + vp.h - vh)}" width="${n2(bw)}" height="${n2(vh)}" fill="${color}" fill-opacity="0.7" rx="1"/>`);
    }
    if (o.showCatLabels) cats.forEach((lab, i) => out.push(textEl(vp.x + slot * (i + 0.5), vp.y + vp.h + 12, clip(lab, 8), { size: 10, fill: '#64748b' })));
  }
  return out.join('');
}

/* ---- gauge (min / max / value / target, +3D ring) ---- */
function renderGauge(c, meta, plot, g, o) {
  const v = (c.series[0] && c.series[0].values) || [];
  const actual = num(v[0]), target = num(v[1]), lo = num(v[2]), hi = num(v[3]) || 100;
  const out = [];
  const cx = plot.x + plot.w / 2, cy = plot.y + plot.h * 0.74;
  const r = Math.min(plot.w / 2, plot.h * 0.9) * 0.9, ri = r * 0.62;
  const frac = (val) => Math.max(0, Math.min(1, (val - lo) / ((hi - lo) || 1)));
  const ang = (val) => -90 + frac(val) * 180;
  const band = (d0, d1, fill, rr = r, rri = ri) => `<path d="${donutArc(cx, cy, rr, rri, d0, d1)}" fill="${fill}"/>`;
  const color = seriesColor(c, 0, g.pal);
  const depth = meta.d3 ? Math.max(8, (o.threeD.depth || 16) * 0.5) : 0;
  if (depth) { g.ensureBlur(); out.push(`<ellipse cx="${n2(cx)}" cy="${n2(cy + depth)}" rx="${n2(r)}" ry="${n2(r * 0.16)}" fill="#0b1220" opacity="0.16" filter="url(#c3blur)"/>`); out.push(`<path d="${donutArc(cx, cy + depth, r, ri, -90, 90)}" fill="${darken(color, 0.4)}"/>`); }
  out.push(band(-90, 90, '#eef2f7'));                       // track
  out.push(band(-90, ang(actual), depth ? g.grad3d(color, 'top') : g.fillOf(color))); // value
  // target marker
  const [tx0, ty0] = polar(cx, cy, ri - 3, ang(target)), [tx1, ty1] = polar(cx, cy, r + 3, ang(target));
  out.push(`<line x1="${n2(tx0)}" y1="${n2(ty0)}" x2="${n2(tx1)}" y2="${n2(ty1)}" stroke="#0f172a" stroke-width="2.5"/>`);
  // needle + hub
  const [nx, ny] = polar(cx, cy, r * 0.92, ang(actual));
  out.push(`<line x1="${n2(cx)}" y1="${n2(cy)}" x2="${n2(nx)}" y2="${n2(ny)}" stroke="#334155" stroke-width="3" stroke-linecap="round"/>`);
  out.push(`<circle cx="${n2(cx)}" cy="${n2(cy)}" r="6" fill="#334155"/>`);
  // flat centre value + endpoints
  out.push(`<text x="${n2(cx)}" y="${n2(cy - r * 0.28)}" font-size="${Math.min(30, r * 0.34)}" text-anchor="middle" fill="#0f172a" font-weight="800">${esc(fmtNum(actual) + (o.valueUnit || ''))}</text>`);
  out.push(textEl(cx - r, cy + 16, fmtNum(lo), { size: 10, fill: '#94a3b8' }));
  out.push(textEl(cx + r, cy + 16, fmtNum(hi), { size: 10, fill: '#94a3b8' }));
  const id = 's0p0'; chartHot(g, id, cx, cy - r * 0.28); out.push(chartLabel(c, id, cx, cy - r * 0.28));
  return out.join('');
}

/* ---- KPI card (value / label / comparison / trend, +3D panel) ---- */
function renderKpi(c, meta, plot, g, o) {
  const v = (c.series[0] && c.series[0].values) || [];
  const cur = num(v[0]), prev = num(v[1]);
  const delta = prev ? ((cur - prev) / Math.abs(prev)) * 100 : 0, rising = delta >= 0;
  const color = seriesColor(c, 0, g.pal);
  const out = [];
  const pad = 16, x = plot.x + pad, y = plot.y + pad, w = plot.w - 2 * pad, h = plot.h - 2 * pad;
  if (meta.d3) { g.ensureBlur(); out.push(`<ellipse cx="${n2(x + w / 2)}" cy="${n2(y + h + 6)}" rx="${n2(w * 0.46)}" ry="6" fill="#0b1220" opacity="0.16" filter="url(#c3blur)"/>`); out.push(`<rect x="${n2(x + 6)}" y="${n2(y + 8)}" width="${n2(w)}" height="${n2(h)}" rx="14" fill="${darken(color, 0.3)}"/>`); }
  out.push(`<rect x="${n2(x)}" y="${n2(y)}" width="${n2(w)}" height="${n2(h)}" rx="14" fill="${meta.d3 ? g.grad3d(color, 'top') : '#ffffff'}" stroke="${lighten(color, 0.25)}" stroke-width="1.5"/>`);
  out.push(`<rect x="${n2(x)}" y="${n2(y)}" width="6" height="${n2(h)}" rx="3" fill="${color}"/>`);
  const label = c.title || (c.series[0] && c.series[0].name) || 'KPI';
  out.push(textEl(x + 22, y + 26, clip(label, 26), { size: 13, anchor: 'start', fill: meta.d3 ? '#e2e8f0' : '#64748b', weight: 600 }));
  out.push(`<text x="${n2(x + 22)}" y="${n2(y + h * 0.56)}" font-size="${Math.min(46, h * 0.34)}" text-anchor="start" fill="${meta.d3 ? '#ffffff' : '#0f172a'}" font-weight="800">${esc(fmtNum(cur) + (o.valueUnit || ''))}</text>`);
  const dcol = rising ? '#16a34a' : '#dc2626';
  out.push(`<text x="${n2(x + 22)}" y="${n2(y + h - 20)}" font-size="13.5" text-anchor="start" fill="${dcol}" font-weight="700">${rising ? '▲' : '▼'} ${n2(Math.abs(delta))}%  vs ${fmtNum(prev)}</text>`);
  const id = 's0p0'; chartHot(g, id, x + w / 2, y + h / 2); out.push(chartLabel(c, id, x + w / 2, y + h * 0.56));
  return out.join('');
}

/* ---- bullet / progress-target (+3D) ---- */
function renderBullet(c, meta, plot, g, o) {
  const cats = c.categories; const n = cats.length || 1;
  const actual = (c.series[0] && c.series[0].values) || [], target = (c.series[1] && c.series[1].values) || [], maxS = (c.series[2] && c.series[2].values) || [];
  const out = [];
  const rowH = plot.h / n, barH = Math.min(26, rowH * 0.42);
  const labelW = Math.min(110, plot.w * 0.28), x0 = plot.x + labelW, trackW = plot.w - labelW - 12;
  const depth = meta.d3 ? Math.max(7, (o.threeD.depth || 16) * 0.5) : 0;
  const color = seriesColor(c, 0, g.pal);
  for (let i = 0; i < n; i += 1) {
    const cy = plot.y + rowH * (i + 0.5), by = cy - barH / 2;
    const mx = maxS[i] != null ? num(maxS[i]) : Math.max(num(actual[i]), num(target[i])) * 1.25 || 100;
    const wOf = (val) => (num(val) / (mx || 1)) * trackW;
    out.push(`<rect x="${n2(x0)}" y="${n2(by - 3)}" width="${n2(trackW)}" height="${n2(barH + 6)}" rx="3" fill="#eef2f7"/>`);
    out.push(`<rect x="${n2(x0)}" y="${n2(by - 3)}" width="${n2(trackW * 0.6)}" height="${n2(barH + 6)}" rx="3" fill="#e2e8f0"/>`);
    out.push(`<rect x="${n2(x0)}" y="${n2(by - 3)}" width="${n2(trackW * 0.3)}" height="${n2(barH + 6)}" rx="3" fill="#d7dee8"/>`);
    if (depth) out.push(bar3d(x0, by, wOf(actual[i]), barH, color, depth, false, g, o));
    else out.push(`<rect x="${n2(x0)}" y="${n2(by)}" width="${n2(wOf(actual[i]))}" height="${n2(barH)}" rx="2" fill="${g.fillOf(color)}"/>`);
    if (!meta.progress && target[i] != null) { const tx = x0 + wOf(target[i]); out.push(`<line x1="${n2(tx)}" y1="${n2(by - 5)}" x2="${n2(tx)}" y2="${n2(by + barH + 5)}" stroke="#0f172a" stroke-width="2.5"/>`); }
    if (o.showCatLabels) out.push(textEl(plot.x + 4, cy, clip(cats[i] || '', 14), { size: 11, anchor: 'start', fill: '#475569', weight: 600 }));
    const id = `s0p${i}`; const ex = x0 + wOf(actual[i]); chartHot(g, id, ex, cy); out.push(ptLabel(c, o, id, ex + 16, cy, actual[i]));
  }
  return out.join('');
}

/* ---- Pareto (sorted bars + cumulative %) (+3D) ---- */
function renderPareto(c, meta, plot, g, o) {
  const vals = ((c.series[0] && c.series[0].values) || []).map(num);
  const idx = vals.map((_, i) => i).sort((a, b) => vals[b] - vals[a]);
  const sorted = idx.map((i) => vals[i]), cats = idx.map((i) => c.categories[i]);
  const total = sum(sorted) || 1; let run = 0; const cum = sorted.map((v) => { run += v; return (run / total) * 100; });
  const out = []; const sc = axisScale(o, Math.max(1, ...sorted));
  const yMax = sc.max, yMin = sc.min, span = (sc.max - sc.min) || 1;
  out.push(axisFrame(plot, { xLabels: cats, yMax, yMin, ticks: sc.ticks, o, showAxis: o.showAxis, showGrid: o.showGridlines, showCat: o.showCatLabels, titles: axisTitlesOf(o) }));
  const slot = plot.w / Math.max(1, sorted.length), bw = slot * 0.6;
  const depth = meta.d3 ? Math.max(9, (o.threeD.depth || 16) * 0.7) : 0;
  sorted.forEach((v, i) => {
    const len = Math.max(0, Math.min(1, (v - yMin) / span)) * plot.h, x = plot.x + slot * (i + 0.5) - bw / 2, y = plot.y + plot.h - len, color = pointColor(c, idx[i], g.pal);
    if (depth) out.push(bar3d(x, y, bw, len, color, depth, true, g, o));
    else out.push(`<rect x="${n2(x)}" y="${n2(y)}" width="${n2(bw)}" height="${n2(len)}" fill="${g.fillOf(color)}" rx="2"/>`);
    const id = `s0p${idx[i]}`; chartHot(g, id, x + bw / 2, y + len / 2); out.push(ptLabel(c, o, id, x + bw / 2, y - 10, v));
  });
  const px = (i) => plot.x + slot * (i + 0.5), pyc = (pct) => plot.y + plot.h - (pct / 100) * plot.h;
  const pts = cum.map((pct, i) => [px(i), pyc(pct)]);
  out.push(`<path d="${pts.map((p, i) => `${i ? 'L' : 'M'} ${n2(p[0])} ${n2(p[1])}`).join(' ')}" fill="none" stroke="#e8873a" stroke-width="2.4" stroke-linejoin="round"/>`);
  pts.forEach((p) => out.push(`<circle cx="${n2(p[0])}" cy="${n2(p[1])}" r="3" fill="#fff" stroke="#e8873a" stroke-width="2"/>`));
  return out.join('');
}

/* ---- histogram (binned) (+3D) ---- */
function renderHistogram(c, meta, plot, g, o) {
  const raw = ((c.series[0] && c.series[0].values) || []).map(num).filter(Number.isFinite);
  if (!raw.length) return textEl(plot.x + plot.w / 2, plot.y + plot.h / 2, 'No data', { fill: '#94a3b8' });
  const out = []; const bins = Math.max(2, Math.round(o.bins || 6));
  const lo = Math.min(...raw), hi = Math.max(...raw), bw0 = ((hi - lo) || 1) / bins;
  const counts = new Array(bins).fill(0);
  raw.forEach((v) => { let b = Math.floor((v - lo) / bw0); b = Math.max(0, Math.min(bins - 1, b)); counts[b] += 1; });
  const labels = counts.map((_, i) => `${n2(lo + i * bw0)}`);
  const sc = axisScale(o, Math.max(1, ...counts));
  const yMax = sc.max, yMin = sc.min, span = (sc.max - sc.min) || 1;
  out.push(axisFrame(plot, { xLabels: labels, yMax, yMin, ticks: sc.ticks, o, showAxis: o.showAxis, showGrid: o.showGridlines, showCat: o.showCatLabels, titles: axisTitlesOf(o) }));
  const slot = plot.w / bins, bw = slot * 0.94, color = seriesColor(c, 0, g.pal);
  const depth = meta.d3 ? Math.max(9, (o.threeD.depth || 16) * 0.6) : 0;
  counts.forEach((ct, i) => {
    const len = Math.max(0, Math.min(1, (ct - yMin) / span)) * plot.h, x = plot.x + slot * i + (slot - bw) / 2, y = plot.y + plot.h - len;
    if (depth) out.push(bar3d(x, y, bw, len, color, depth, true, g, o));
    else out.push(`<rect x="${n2(x)}" y="${n2(y)}" width="${n2(bw)}" height="${n2(len)}" fill="${g.fillOf(color)}" stroke="#fff" stroke-width="0.75"/>`);
    const id = `s0p${i}`; chartHot(g, id, x + bw / 2, y + len / 2); out.push(ptLabel(c, o, id, x + bw / 2, y - 10, ct));
  });
  return out.join('');
}

/* ---- box & whisker (series = Min/Q1/Median/Q3/Max) ---- */
function renderBox(c, meta, plot, g, o) {
  const cats = c.categories, n = cats.length || 1, out = [];
  const gv = (si, i) => num(c.series[si] && c.series[si].values[i]);
  const all = []; for (let si = 0; si < 5; si += 1) for (let i = 0; i < n; i += 1) all.push(gv(si, i));
  const sc = axisScale(o, Math.max(1, ...all), Math.min(0, ...all));
  const yMin = sc.min, yMax = sc.max;
  out.push(axisFrame(plot, { xLabels: cats, yMin, yMax, ticks: sc.ticks, o, showAxis: o.showAxis, showGrid: o.showGridlines, showCat: o.showCatLabels, titles: axisTitlesOf(o) }));
  const slot = plot.w / n, bw = slot * 0.42;
  const py = (v) => plot.y + plot.h - ((v - yMin) / ((yMax - yMin) || 1)) * plot.h;
  for (let i = 0; i < n; i += 1) {
    const xc = plot.x + slot * (i + 0.5), mn = gv(0, i), q1 = gv(1, i), md = gv(2, i), q3 = gv(3, i), mx = gv(4, i), color = pointColor(c, i, g.pal);
    out.push(`<line x1="${n2(xc)}" y1="${n2(py(mx))}" x2="${n2(xc)}" y2="${n2(py(q3))}" stroke="${darken(color, 0.2)}" stroke-width="1.4"/>`);
    out.push(`<line x1="${n2(xc)}" y1="${n2(py(q1))}" x2="${n2(xc)}" y2="${n2(py(mn))}" stroke="${darken(color, 0.2)}" stroke-width="1.4"/>`);
    out.push(`<line x1="${n2(xc - bw / 3)}" y1="${n2(py(mx))}" x2="${n2(xc + bw / 3)}" y2="${n2(py(mx))}" stroke="${darken(color, 0.2)}" stroke-width="1.4"/>`);
    out.push(`<line x1="${n2(xc - bw / 3)}" y1="${n2(py(mn))}" x2="${n2(xc + bw / 3)}" y2="${n2(py(mn))}" stroke="${darken(color, 0.2)}" stroke-width="1.4"/>`);
    const yTop = py(q3), bh = Math.max(2, py(q1) - py(q3));
    out.push(`<rect x="${n2(xc - bw / 2)}" y="${n2(yTop)}" width="${n2(bw)}" height="${n2(bh)}" fill="${g.fillOf(color)}" fill-opacity="0.55" stroke="${color}" stroke-width="1.5"/>`);
    out.push(`<line x1="${n2(xc - bw / 2)}" y1="${n2(py(md))}" x2="${n2(xc + bw / 2)}" y2="${n2(py(md))}" stroke="${darken(color, 0.28)}" stroke-width="2.2"/>`);
    const id = `s0p${i}`; chartHot(g, id, xc, py(md)); out.push(ptLabel(c, o, id, xc, py(mx) - 10, md));
  }
  return out.join('');
}

/* ---- heatmap (matrix: rows = series, columns = categories) ---- */
function renderHeatmap(c, meta, plot, g, o) {
  const cols = c.categories, rows = c.series, nc = cols.length || 1, nr = rows.length || 1, out = [];
  const labW = Math.min(90, plot.w * 0.22), labH = o.showCatLabels ? 18 : 0;
  const gx = plot.x + labW, gy = plot.y, gw = plot.w - labW, gh = plot.h - labH;
  const cw = gw / nc, ch = gh / nr;
  let mx = 1; rows.forEach((s) => s.values.forEach((v) => { mx = Math.max(mx, Math.abs(num(v))); }));
  const base = seriesColor(c, 0, g.pal);
  for (let r = 0; r < nr; r += 1) for (let col = 0; col < nc; col += 1) {
    const v = num(rows[r].values[col]), t = Math.max(0, Math.min(1, v / mx)), x = gx + col * cw, y = gy + r * ch;
    out.push(`<rect x="${n2(x + 1)}" y="${n2(y + 1)}" width="${n2(cw - 2)}" height="${n2(ch - 2)}" rx="3" fill="${mixColor('#eef3fb', base, t)}"/>`);
    const id = `s${r}p${col}`; chartHot(g, id, x + cw / 2, y + ch / 2);
    const lbl = (c.pointLabels && c.pointLabels[id]) || (o.showDataLabels && !isPh(rows[r].values[col]) ? n2(v) : '');
    if (lbl) out.push(`<text x="${n2(x + cw / 2)}" y="${n2(y + ch / 2)}" font-size="11" text-anchor="middle" dominant-baseline="middle" fill="${t > 0.55 ? '#fff' : '#334155'}" font-weight="600">${esc(String(lbl))}</text>`);
  }
  rows.forEach((s, r) => out.push(textEl(plot.x + 4, gy + ch * (r + 0.5), clip(s.name, 12), { size: 10, anchor: 'start', fill: '#475569', weight: 600 })));
  if (o.showCatLabels) cols.forEach((lab, col) => out.push(textEl(gx + cw * (col + 0.5), gy + gh + 11, clip(lab, 8), { size: 10, fill: '#64748b' })));
  return out.join('');
}

/* ---- scatter matrix (pairwise mini-scatters) ---- */
function renderMatrix(c, meta, plot, g, o) {
  const series = c.series, k = Math.min(3, series.length) || 1, out = [];
  const cell = Math.min(plot.w, plot.h) / k, gx = plot.x + (plot.w - cell * k) / 2, gy = plot.y + (plot.h - cell * k) / 2;
  const range = (vals) => { const a = vals.map(num); return [Math.min(...a), Math.max(...a, 1)]; };
  for (let r = 0; r < k; r += 1) for (let col = 0; col < k; col += 1) {
    const x = gx + col * cell, y = gy + r * cell;
    out.push(`<rect x="${n2(x + 2)}" y="${n2(y + 2)}" width="${n2(cell - 4)}" height="${n2(cell - 4)}" rx="4" fill="#f8fafc" stroke="#e2e8f0"/>`);
    if (r === col) { out.push(textEl(x + cell / 2, y + cell / 2, clip(series[r].name, 10), { size: 11, fill: '#64748b', weight: 700 })); continue; }
    const [x0, x1] = range(series[col].values), [y0, y1] = range(series[r].values), cc = seriesColor(c, col, g.pal);
    series[r].values.forEach((_, i) => {
      const vx = num(series[col].values[i]), vy = num(series[r].values[i]);
      const px = x + 8 + ((vx - x0) / ((x1 - x0) || 1)) * (cell - 16), py = y + cell - 8 - ((vy - y0) / ((y1 - y0) || 1)) * (cell - 16);
      out.push(`<circle cx="${n2(px)}" cy="${n2(py)}" r="2.6" fill="${cc}" fill-opacity="0.8"/>`);
      if (col === 0 && r === 1) { const id = `s${col}p${i}`; chartHot(g, id, px, py); out.push(chartLabel(c, id, px, py - 8)); }
    });
  }
  return out.join('');
}

/* ---- treemap (proportional rectangles, +3D extrusion) ---- */
function renderTreemap(c, meta, plot, g, o) {
  const vals = ((c.series[0] && c.series[0].values) || []).map(num);
  const items = vals.map((v, i) => ({ v: Math.max(0, v), i })).filter((it) => it.v > 0);
  const rects = squarify(items.map((it) => it.v), plot.x, plot.y, plot.w, plot.h);
  const out = [], depth = meta.d3 ? Math.max(8, (o.threeD.depth || 16) * 0.5) : 0;
  rects.forEach((R, k) => {
    const it = items[k], color = pointColor(c, it.i, g.pal);
    if (depth) {
      out.push(`<path d="M ${n2(R.x)} ${n2(R.y)} l ${n2(depth)} ${n2(-depth)} l ${n2(R.w)} 0 l ${n2(-depth)} ${n2(depth)} Z" fill="${g.grad3d(color, 'top')}"/>`);
      out.push(`<path d="M ${n2(R.x + R.w)} ${n2(R.y)} l ${n2(depth)} ${n2(-depth)} l 0 ${n2(R.h)} l ${n2(-depth)} ${n2(depth)} Z" fill="${g.grad3d(color, 'side')}"/>`);
      out.push(`<rect x="${n2(R.x)}" y="${n2(R.y)}" width="${n2(R.w)}" height="${n2(R.h)}" fill="${g.grad3d(color, 'frontV')}" stroke="#fff" stroke-width="1"/>`);
    } else out.push(`<rect x="${n2(R.x)}" y="${n2(R.y)}" width="${n2(R.w)}" height="${n2(R.h)}" fill="${g.fillOf(color)}" stroke="#fff" stroke-width="1.5"/>`);
    const id = `p${it.i}`; chartHot(g, id, R.x + R.w / 2, R.y + R.h / 2);
    if (R.w > 34 && R.h > 20) {
      const custom = c.pointLabels && c.pointLabels[id];
      const txt = custom || [o.showCatLabels ? clip(c.categories[it.i] || '', Math.floor(R.w / 8)) : '', o.showDataLabels && !isPh(c.series[0] && c.series[0].values[it.i]) ? n2(it.v) : ''].filter(Boolean).join(' ');
      if (txt) out.push(`<text x="${n2(R.x + 6)}" y="${n2(R.y + 16)}" font-size="11" text-anchor="start" fill="#ffffff" font-weight="700" paint-order="stroke" stroke="rgba(0,0,0,0.15)" stroke-width="2">${esc(txt)}</text>`);
    }
  });
  return out.join('');
}

/* ---- sunburst (nested rings, one per series) ---- */
function renderSunburst(c, meta, plot, g, o) {
  const cats = c.categories, out = [];
  const cx = plot.x + plot.w / 2, cy = plot.y + plot.h / 2, R = Math.min(plot.w, plot.h) / 2 * 0.92;
  const rings = Math.max(1, c.series.length), inner = R * 0.3, rw = (R - inner) / rings;
  c.series.forEach((s, si) => {
    const vals = cats.map((_, i) => Math.max(0, num(s.values[i]))), tot = sum(vals) || 1;
    let a = 0; const r1 = inner + rw * si, r2 = inner + rw * (si + 1);
    vals.forEach((v, i) => {
      const a0 = a, a1 = a + (v / tot) * 360; a = a1; if (a1 - a0 < 0.2) return;
      const color = si ? lighten(pointColor(c, i, g.pal), 0.14 * si) : pointColor(c, i, g.pal);
      out.push(`<path d="${donutArc(cx, cy, r2, r1, a0, a1)}" fill="${g.fillOf(color)}" stroke="#fff" stroke-width="1.2"/>`);
      const mid = (a0 + a1) / 2, [lx, ly] = polar(cx, cy, (r1 + r2) / 2, mid), id = `s${si}p${i}`; chartHot(g, id, lx, ly);
      const lbl = (c.pointLabels && c.pointLabels[id]) || (o.showCatLabels && si === 0 ? clip(cats[i] || '', 8) : '');
      if (lbl && (a1 - a0) > 16) out.push(`<text x="${n2(lx)}" y="${n2(ly)}" font-size="10" text-anchor="middle" dominant-baseline="middle" fill="#ffffff" font-weight="700">${esc(String(lbl))}</text>`);
    });
  });
  return out.join('');
}

/* ---- hierarchy / tree (root + children) ---- */
function renderTree(c, meta, plot, g, o) {
  const cats = c.categories, n = cats.length || 1, out = [];
  const bw = Math.min(120, plot.w / Math.max(n, 2) - 10), bh = 34;
  const rootX = plot.x + plot.w / 2, rootY = plot.y + 16, childY = plot.y + plot.h - bh - 14;
  const nodeBox = (x, y, w, h, color, label, isRoot) => `<g><rect x="${n2(x)}" y="${n2(y)}" width="${n2(w)}" height="${n2(h)}" rx="8" fill="${isRoot ? color : lighten(color, 0.82)}" stroke="${color}" stroke-width="1.6"/><text x="${n2(x + w / 2)}" y="${n2(y + h / 2)}" font-size="12" text-anchor="middle" dominant-baseline="middle" fill="${isRoot ? '#fff' : darken(color, 0.3)}" font-weight="700">${esc(label)}</text></g>`;
  out.push(nodeBox(rootX - bw / 2, rootY, bw, bh, seriesColor(c, 0, g.pal), clip(c.title || 'Root', 16), true));
  cats.forEach((lab, i) => {
    const cxp = plot.x + plot.w * (i + 0.5) / n, x = cxp - bw / 2, color = pointColor(c, i, g.pal), midY = (rootY + bh + childY) / 2;
    out.push(`<path d="M ${n2(rootX)} ${n2(rootY + bh)} C ${n2(rootX)} ${n2(midY)}, ${n2(cxp)} ${n2(midY)}, ${n2(cxp)} ${n2(childY)}" fill="none" stroke="#cbd5e1" stroke-width="1.6"/>`);
    const val = (o.showDataLabels && !isPh(c.series[0] && c.series[0].values[i])) ? `  ${n2(num(c.series[0] && c.series[0].values[i]))}` : '';
    out.push(nodeBox(x, childY, bw, bh, color, clip(lab, 13) + val, false));
    const id = `s0p${i}`; chartHot(g, id, cxp, childY + bh / 2); out.push(chartLabel(c, id, cxp, childY + bh / 2));
  });
  return out.join('');
}

/* ---- Gantt (task / start / end / progress) (+3D bars) ---- */
function renderGantt(c, meta, plot, g, o) {
  const cats = c.categories, n = cats.length || 1, out = [];
  const start = (c.series[0] && c.series[0].values) || [], end = (c.series[1] && c.series[1].values) || [], prog = (c.series[2] && c.series[2].values) || [];
  const tMax = Math.max(1, ...end.map(num));
  const labW = Math.min(120, plot.w * 0.24), gx = plot.x + labW, gw = plot.w - labW;
  const rowH = plot.h / n, barH = Math.min(24, rowH * 0.5);
  const xOf = (t) => gx + (num(t) / tMax) * gw;
  const depth = meta.d3 ? Math.max(7, (o.threeD.depth || 16) * 0.5) : 0;
  if (o.showGridlines || o.showAxis) for (let t = 0; t <= tMax; t += Math.max(1, Math.ceil(tMax / 6))) {
    const x = xOf(t);
    if (o.showGridlines) out.push(`<line x1="${n2(x)}" y1="${n2(plot.y)}" x2="${n2(x)}" y2="${n2(plot.y + plot.h)}" stroke="#eef2f7" stroke-width="1"/>`);
    if (o.showAxis) out.push(textEl(x, plot.y + plot.h + 12, t, { size: 9, fill: '#94a3b8' }));
  }
  for (let i = 0; i < n; i += 1) {
    const cy = plot.y + rowH * (i + 0.5), by = cy - barH / 2, x = xOf(start[i]), w = Math.max(2, xOf(end[i]) - xOf(start[i])), color = pointColor(c, i, g.pal);
    if (depth) out.push(bar3d(x, by, w, barH, color, depth, false, g, o));
    else out.push(`<rect x="${n2(x)}" y="${n2(by)}" width="${n2(w)}" height="${n2(barH)}" rx="4" fill="${lighten(color, 0.4)}"/>`);
    const pw = w * Math.max(0, Math.min(1, num(prog[i]) / 100));
    if (pw > 0) out.push(`<rect x="${n2(x)}" y="${n2(by)}" width="${n2(pw)}" height="${n2(barH)}" rx="4" fill="${g.fillOf(color)}"/>`);
    if (o.showCatLabels) out.push(textEl(plot.x + 4, cy, clip(cats[i] || '', 15), { size: 11, anchor: 'start', fill: '#475569', weight: 600 }));
    const id = `s0p${i}`; chartHot(g, id, x + w / 2, cy);
    const lbl = (c.pointLabels && c.pointLabels[id]) || (o.showDataLabels && !isPh(prog[i]) ? `${n2(prog[i])}%` : '');
    if (lbl) out.push(chartText(x + w + 16, cy, lbl));
  }
  return out.join('');
}

/* ---- timeline / milestone ---- */
function renderTimeline(c, meta, plot, g, o) {
  const cats = c.categories, pos = (c.series[0] && c.series[0].values) || [], n = cats.length || 1, out = [];
  const y = plot.y + plot.h / 2, x0 = plot.x + 20, x1 = plot.x + plot.w - 20;
  const pmin = Math.min(0, ...pos.map(num)), pmax = Math.max(1, ...pos.map(num));
  const xOf = (p) => x0 + ((num(p) - pmin) / ((pmax - pmin) || 1)) * (x1 - x0);
  out.push(`<line x1="${n2(x0)}" y1="${n2(y)}" x2="${n2(x1)}" y2="${n2(y)}" stroke="#cbd5e1" stroke-width="3" stroke-linecap="round"/>`);
  for (let i = 0; i < n; i += 1) {
    const x = xOf(pos[i]), color = pointColor(c, i, g.pal), up = i % 2 === 0, ly = up ? y - 34 : y + 34;
    out.push(`<line x1="${n2(x)}" y1="${n2(y)}" x2="${n2(x)}" y2="${n2(ly + (up ? 12 : -12))}" stroke="${color}" stroke-width="1.4"/>`);
    if (meta.milestone) out.push(`<path d="M ${n2(x)} ${n2(y - 7)} L ${n2(x + 7)} ${n2(y)} L ${n2(x)} ${n2(y + 7)} L ${n2(x - 7)} ${n2(y)} Z" fill="${color}" stroke="#fff" stroke-width="1.5"/>`);
    else out.push(`<circle cx="${n2(x)}" cy="${n2(y)}" r="6" fill="${color}" stroke="#fff" stroke-width="2"/>`);
    if (o.showCatLabels) out.push(textEl(x, ly, clip(cats[i] || '', 14), { size: 10, fill: '#475569', weight: 600 }));
    const id = `s0p${i}`; chartHot(g, id, x, y); out.push(chartLabel(c, id, x, up ? ly - 14 : ly + 14));
  }
  return out.join('');
}

/** SVG string → `data:image/svg+xml` URL for an <img>. */
export function chartSvgUrl(chart, size) {
  return `data:image/svg+xml,${encodeURIComponent(renderChartSvg(chart, size))}`;
}
