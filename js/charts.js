/**
 * PC Health Analyzer — js/charts.js
 * Chart creation, crosshair sync, zoom/pan, per-chart PNG download.
 * Uses Chart.js 4.x + chartjs-plugin-zoom.
 */

'use strict';

const Charts = (() => {

  const PALETTE = ['#4f8ef7', '#3ecf7a', '#f5a623', '#f74f4f', '#a07ef5', '#4fd4d4', '#f74fb0', '#f7d44f'];

  /** @type {Chart[]} */
  let instances = [];

  // ── Crosshair sync ───────────────────────────────────────────────
  // We store a shared data-index rather than raw pixels so the crosshair
  // maps correctly onto charts of different widths.
  let _crosshairIdx = null;
  let crosshairEnabled = true;

  const CrosshairPlugin = {
    id: 'crosshairSync',
    afterDraw(chart) {
      if (_crosshairIdx === null || !crosshairEnabled) return;
      const meta = chart.getDatasetMeta(0);
      if (!meta || !meta.data || !meta.data[_crosshairIdx]) return;
      const x = meta.data[_crosshairIdx].x;
      const { ctx, chartArea: ca } = chart;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x, ca.top);
      ctx.lineTo(x, ca.bottom);
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.stroke();
      ctx.restore();
    },
  };

  Chart.register(CrosshairPlugin);

  // ── Chart config builder ────────────────────────────────────────

  /**
   * Generate chart config objects from sensor groups + sampled rows.
   * @param {Object} groups
   * @param {Record<string,string>[]} sampledRows
   * @param {string[]} labels
   * @param {Record<string,string>[]|null} compareRows - optional second session
   * @param {string[]} compareLabels
   * @returns {Array}
   */
  function buildConfigs(groups, sampledRows, labels, compareRows = null, compareLabels = []) {
    const configs = [];
    const T = Diagnostics.THRESHOLDS;

    const series = (col, rows) => rows.map(r => Parser.parseVal(r[col]));
    const cpuTempCols = Parser.prioritiseCpuTempCols(groups.cpuTemp);
    const gpuLoadSorted = Parser.prioritiseGpuLoadCols(groups.gpuLoad);

    const add = (cfg) => configs.push(cfg);

    // CPU Temperature
    if (cpuTempCols.length) {
      add({
        group: 'cpu', title: 'CPU Temperature', unit: '°C',
        thresholds: [{ val: T.cpuTemp.warn, color: '#f5a623' }, { val: T.cpuTemp.danger, color: '#f74f4f' }],
        datasets: cpuTempCols.map((c, i) => ({
          label: Parser.cleanLabel(c),
          data: series(c, sampledRows),
          compareData: compareRows ? series(c, compareRows) : null,
          color: ['#4f8ef7', '#a07ef5'][i],
        })),
      });
    }

    // GPU Temperature
    if (groups.gpuTemp.length) {
      add({
        group: 'gpu', title: 'GPU Temperature', unit: '°C',
        thresholds: [{ val: T.gpuTemp.warn, color: '#f5a623' }, { val: T.gpuTemp.danger, color: '#f74f4f' }],
        datasets: [{ label: 'GPU Temp', data: series(groups.gpuTemp[0], sampledRows), color: '#f74f4f',
          compareData: compareRows ? series(groups.gpuTemp[0], compareRows) : null }],
      });
    }

    // CPU Load
    if (groups.cpuLoad.length) {
      add({
        group: 'cpu', title: 'CPU Load', unit: '%',
        thresholds: [{ val: T.cpuLoad.warn, color: '#f5a623' }, { val: T.cpuLoad.danger, color: '#f74f4f' }],
        datasets: [{ label: 'CPU Usage', data: series(groups.cpuLoad[0], sampledRows), color: '#4f8ef7',
          compareData: compareRows ? series(groups.cpuLoad[0], compareRows) : null }],
      });
    }

    // GPU Load
    if (gpuLoadSorted.length) {
      add({
        group: 'gpu', title: 'GPU Load', unit: '%',
        thresholds: [],
        datasets: [{ label: 'GPU Usage', data: series(gpuLoadSorted[0], sampledRows), color: '#a07ef5',
          compareData: compareRows ? series(gpuLoadSorted[0], compareRows) : null }],
      });
    }

    // RAM
    const ramCol = groups.ramLoad[0] ?? groups.ramUsed[0];
    if (ramCol) {
      const isPercent = ramCol.toLowerCase().includes('%') || ramCol.toLowerCase().includes('load');
      const unit = isPercent ? '%' : ' MB';
      add({
        group: 'ram', title: 'RAM Usage', unit,
        thresholds: isPercent
          ? [{ val: T.ramLoad.warn, color: '#f5a623' }, { val: T.ramLoad.danger, color: '#f74f4f' }]
          : [],
        datasets: [{ label: 'RAM', data: series(ramCol, sampledRows), color: '#3ecf7a',
          compareData: compareRows ? series(ramCol, compareRows) : null }],
      });
    }

    // System Temperatures
    if (groups.sysTemp.length) {
      add({
        group: 'system', title: 'System Temperatures', unit: '°C',
        thresholds: [{ val: T.sysTemp.danger, color: '#f5a623' }],
        datasets: groups.sysTemp.slice(0, 4).map((c, i) => ({
          label: Parser.cleanLabel(c), data: series(c, sampledRows), color: PALETTE[i + 2],
        })),
      });
    }

    // Fan Speeds
    if (groups.fanRpm.length) {
      add({
        group: 'fans', title: 'Fan Speeds', unit: ' RPM',
        thresholds: [],
        datasets: groups.fanRpm.slice(0, 3).map((c, i) => ({
          label: Parser.cleanLabel(c), data: series(c, sampledRows), color: PALETTE[i],
        })),
      });
    }

    // Power
    if (groups.power.length) {
      add({
        group: 'power', title: 'CPU Power Draw', unit: ' W',
        thresholds: [],
        datasets: groups.power.slice(0, 2).map((c, i) => ({
          label: Parser.cleanLabel(c), data: series(c, sampledRows), color: ['#f5a623', '#f74f4f'][i],
        })),
      });
    }

    return configs;
  }

  // ── Chart creation ──────────────────────────────────────────────

  /**
   * Create a Chart.js line chart with zoom, crosshair sync, and optional compare overlay.
   * @param {HTMLCanvasElement} canvas
   * @param {string[]} labels
   * @param {Object} config  - from buildConfigs()
   * @param {string[]} compareLabels
   * @param {boolean} isDark
   * @returns {Chart}
   */
  function create(canvas, labels, config, compareLabels = [], isDark = true) {
    const textColor = isDark ? '#606278' : '#888';
    const gridColor = isDark ? '#16161c' : '#ebebf0';

    const makeDs = (d, i, isCompare = false) => ({
      label:           isCompare ? `${d.label} (B)` : d.label,
      data:            isCompare ? d.compareData : d.data,
      borderColor:     isCompare ? hexAlpha(d.color ?? PALETTE[i], 0.55) : (d.color ?? PALETTE[i]),
      backgroundColor: 'transparent',
      borderWidth:     isCompare ? 1.5 : 1.5,
      borderDash:      isCompare ? [4, 3] : [],
      pointRadius:     0,
      tension:         0.3,
      spanGaps:        true,
    });

    // Primary datasets
    const datasets = config.datasets.map((d, i) => makeDs(d, i, false));

    // Compare overlay datasets (dashed)
    const hasCompare = compareLabels.length > 0;
    if (hasCompare) {
      config.datasets.forEach((d, i) => {
        if (d.compareData) datasets.push(makeDs(d, i, true));
      });
    }

    // Threshold lines as constant datasets
    config.thresholds.forEach(t => {
      datasets.push({
        label: `${t.val}${config.unit} limit`,
        data: new Array(labels.length).fill(t.val),
        borderColor: t.color,
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderDash: [5, 4],
        pointRadius: 0,
        tension: 0,
        spanGaps: true,
      });
    });

    const chart = new Chart(canvas, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            display: config.datasets.length > 1 || hasCompare,
            labels: {
              color: textColor,
              font: { size: 10, family: "'JetBrains Mono', monospace" },
              boxWidth: 10, padding: 8,
              filter: item => !item.text.includes(' limit'),
            },
          },
          tooltip: {
            backgroundColor: isDark ? '#1a1a20' : '#fff',
            borderColor:     isDark ? '#28282e' : '#ddd',
            borderWidth: 1,
            titleColor:  isDark ? '#dde1eb' : '#222',
            bodyColor:   isDark ? '#8888a0' : '#555',
            padding: 10,
            filter: item => !item.dataset.label?.includes(' limit'),
            callbacks: {
              label: ctx => {
                const v = ctx.parsed.y;
                return ` ${ctx.dataset.label}: ${v !== null ? v.toFixed(1) : 'N/A'}${config.unit}`;
              },
            },
          },
          zoom: {
            zoom:  { wheel: { enabled: true, speed: 0.08 }, pinch: { enabled: true }, mode: 'x' },
            pan:   { enabled: true, mode: 'x' },
            limits: { x: { min: 'original', max: 'original' } },
          },
        },
        scales: {
          x: {
            ticks: { color: textColor, font: { size: 10 }, maxTicksLimit: 8, maxRotation: 0 },
            grid:  { color: gridColor },
          },
          y: {
            ticks: { color: textColor, font: { size: 10 }, callback: v => `${Math.round(v)}${config.unit}` },
            grid:  { color: gridColor },
          },
        },
        onHover: (evt, items) => {
          if (!crosshairEnabled || !items.length) return;
          _crosshairIdx = items[0].index;
          instances.forEach(c => { if (c !== chart) c.update('none'); });
        },
      },
      plugins: [CrosshairPlugin],
    });

    // Clear crosshair on mouse leave
    canvas.addEventListener('mouseleave', () => {
      _crosshairIdx = null;
      instances.forEach(c => c.update('none'));
    });

    instances.push(chart);
    return chart;
  }

  // ── Chart controls ───────────────────────────────────────────────

  function resetAllZoom() {
    instances.forEach(c => { try { c.resetZoom(); } catch {} });
  }

  function destroyAll() {
    instances.forEach(c => c.destroy());
    instances = [];
    _crosshairIdx = null;
  }

  function setCrosshairEnabled(on) {
    crosshairEnabled = on;
    if (!on) { _crosshairIdx = null; instances.forEach(c => c.update('none')); }
  }

  /**
   * Update chart theme colors without full re-render.
   * @param {boolean} isDark
   */
  function updateTheme(isDark) {
    const textColor = isDark ? '#606278' : '#888';
    const gridColor = isDark ? '#16161c' : '#ebebf0';
    instances.forEach(c => {
      if (c.options.scales?.x) {
        c.options.scales.x.ticks.color = textColor;
        c.options.scales.x.grid.color  = gridColor;
        c.options.scales.y.ticks.color = textColor;
        c.options.scales.y.grid.color  = gridColor;
      }
      if (c.options.plugins?.tooltip) {
        c.options.plugins.tooltip.backgroundColor = isDark ? '#1a1a20' : '#fff';
        c.options.plugins.tooltip.borderColor     = isDark ? '#28282e' : '#ddd';
        c.options.plugins.tooltip.titleColor      = isDark ? '#dde1eb' : '#222';
        c.options.plugins.tooltip.bodyColor       = isDark ? '#8888a0' : '#555';
      }
      c.update('none');
    });
  }

  /**
   * Download a chart's canvas as a PNG file.
   * @param {Chart} chart
   * @param {string} filename
   */
  function downloadPNG(chart, filename) {
    const url = chart.canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = filename + '.png';
    a.click();
  }

  /**
   * Download all charts as individual PNG files (sequentially).
   * @param {Array} configs
   */
  function downloadAllPNG(configs) {
    instances.forEach((chart, i) => {
      const name = configs[i]?.title ?? `chart_${i}`;
      setTimeout(() => downloadPNG(chart, `pc-health_${name.toLowerCase().replace(/\s+/g, '_')}`), i * 120);
    });
  }

  // ── Utility ──────────────────────────────────────────────────────

  /**
   * Add alpha to a hex color string.
   * @param {string} hex  e.g. '#4f8ef7'
   * @param {number} alpha 0-1
   * @returns {string} rgba string
   */
  function hexAlpha(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  return {
    buildConfigs,
    create,
    resetAllZoom,
    destroyAll,
    setCrosshairEnabled,
    updateTheme,
    downloadPNG,
    downloadAllPNG,
    get instances() { return instances; },
  };
})();
