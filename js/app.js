/**
 * PC Health Analyzer — js/app.js
 * Main application controller: file loading, tab management, UI rendering,
 * theme toggling, compare mode, and export.
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════
   APP STATE
═══════════════════════════════════════════════════════════════ */
const State = {
  // Primary session
  rows:        null,
  groups:      null,
  events:      null,
  health:      null,
  timeline:    null,
  recs:        null,
  corrs:       null,
  chartCfgs:   null,
  sampledRows: null,
  labels:      null,
  filename:    '',
  intervalSec: 2,

  // Compare session
  compareRows:    null,
  compareLabels:  null,
  compareActive:  false,

  // UI
  theme:         'dark',
  activeTab:     'overview',
  activeChartGroup: 'all',
  eventsFilter:  'all',
};

const MAX_CHART_PTS = 600;

/* ═══════════════════════════════════════════════════════════════
   DOM REFS
═══════════════════════════════════════════════════════════════ */
const $ = id => document.getElementById(id);

const DOM = {
  screenUpload:  $('screen-upload'),
  screenLoading: $('screen-loading'),
  screenApp:     $('screen-app'),
  loadingStatus: $('loading-status'),
  dropZone:      $('drop-zone'),
  dropInner:     $('drop-inner'),
  fileInput:     $('file-input'),
  // header
  hdrFilename:   $('hdr-filename'),
  hdrHealthPill: $('hdr-health-pill'),
  hdrHealthScore:$('hdr-health-score'),
  btnTheme:      $('btn-theme'),
  btnThemeUpload:$('btn-theme-upload'),
  btnCompare:    $('btn-compare'),
  btnReset:      $('btn-reset'),
  eventsBadge:   $('events-badge'),
  // overview
  healthScoreNum: $('health-score-num'),
  healthGrade:    $('health-grade'),
  healthRingArc:  $('health-ring-arc'),
  healthBreakdown:$('health-breakdown'),
  metaFilename:   $('meta-filename'),
  metaDate:       $('meta-date'),
  metaStart:      $('meta-start'),
  metaEnd:        $('meta-end'),
  metaDuration:   $('meta-duration'),
  metaSamples:    $('meta-samples'),
  timelineStrip:  $('timeline-strip'),
  correlationsList:$('correlations-list'),
  statsGrid:      $('stats-grid'),
  alertsList:     $('alerts-list'),
  recsList:       $('recommendations-list'),
  // charts
  chartsGrid:     $('charts-grid'),
  toggleCrosshair:$('toggle-crosshair'),
  btnResetZoom:   $('btn-reset-zoom'),
  // events
  eventsTbody:    $('events-tbody'),
  eventsEmpty:    $('events-empty'),
  eventsSummary:  $('events-summary'),
  // export
  btnExportPNG:   $('btn-export-png'),
  btnPrint:       $('btn-print'),
  btnCopySummary: $('btn-copy-summary'),
  copyConfirm:    $('copy-confirm'),
  btnLoadCompare: $('btn-load-compare'),
  compareFileInput:$('compare-file-input'),
  compareStatus:  $('compare-status'),
};

/* ═══════════════════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════════════════ */
function init() {
  // Drag & drop
  DOM.dropInner.addEventListener('dragover',  e => { e.preventDefault(); DOM.dropInner.classList.add('drag-over'); });
  DOM.dropInner.addEventListener('dragleave', () => DOM.dropInner.classList.remove('drag-over'));
  DOM.dropInner.addEventListener('drop',      e => { e.preventDefault(); DOM.dropInner.classList.remove('drag-over'); const f = e.dataTransfer.files[0]; if (f) loadFile(f); });
  DOM.dropInner.addEventListener('click',     () => DOM.fileInput.click());
  DOM.fileInput.addEventListener('change',    e => { if (e.target.files[0]) loadFile(e.target.files[0]); });

  // Prevent the label's click from bubbling to dropInner (which would open a second dialog)
  // and prevent the programmatic fileInput.click() from looping back to dropInner
  document.querySelector('label[for="file-input"]').addEventListener('click', e => e.stopPropagation());
  DOM.fileInput.addEventListener('click', e => e.stopPropagation());

  // Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Theme toggles
  DOM.btnTheme.addEventListener('click',       toggleTheme);
  DOM.btnThemeUpload.addEventListener('click', toggleTheme);

  // Chart controls
  DOM.btnResetZoom.addEventListener('click', () => Charts.resetAllZoom());
  DOM.toggleCrosshair.addEventListener('change', e => Charts.setCrosshairEnabled(e.target.checked));

  // Chart group filter
  document.querySelectorAll('.cg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      State.activeChartGroup = btn.dataset.group;
      filterChartCards();
    });
  });

  // Events filter
  document.querySelectorAll('.ef-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ef-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      State.eventsFilter = btn.dataset.filter;
      renderEventsTable();
    });
  });

  // Header controls
  DOM.btnReset.addEventListener('click', resetApp);
  DOM.btnCompare.addEventListener('click', () => DOM.compareFileInput.click());

  // Export
  DOM.btnExportPNG.addEventListener('click', () => Charts.downloadAllPNG(State.chartCfgs));
  DOM.btnPrint.addEventListener('click',    () => window.print());
  DOM.btnCopySummary.addEventListener('click', copySummary);
  DOM.btnLoadCompare.addEventListener('click', () => DOM.compareFileInput.click());
  DOM.compareFileInput.addEventListener('change', e => { if (e.target.files[0]) loadCompareFile(e.target.files[0]); });

  // Apply saved theme
  const saved = localStorage.getItem('pha-theme');
  if (saved) applyTheme(saved);
}

/* ═══════════════════════════════════════════════════════════════
   FILE LOADING
═══════════════════════════════════════════════════════════════ */
function loadFile(file) {
  showScreen('loading');
  DOM.loadingStatus.textContent = 'Parsing CSV…';
  readFile(file, (text) => {
    try {
      processSession(file.name, text);
    } catch (err) {
      alert(`Could not parse file:\n\n${err.message}\n\nMake sure this is a HWiNFO64 CSV log.`);
      showScreen('upload');
    }
  });
}

function loadCompareFile(file) {
  DOM.compareStatus.textContent = 'Loading…';
  readFile(file, (text) => {
    try {
      const { rows } = Parser.parseCSV(text);
      const sampled  = Parser.downsample(rows, MAX_CHART_PTS);
      State.compareRows   = sampled;
      State.compareLabels = sampled.map(r => shortTime(r['Time']));
      State.compareActive = true;
      DOM.compareStatus.textContent = `✓ Comparing: ${file.name}`;
      // Re-render charts tab with compare overlay
      renderChartsTab();
    } catch (err) {
      DOM.compareStatus.textContent = `Error: ${err.message}`;
    }
  });
}

/**
 * Read a file as Windows-1252 text (handles both ANSI and UTF-8 HWiNFO exports).
 */
function readFile(file, callback) {
  const reader = new FileReader();
  reader.onload  = e => callback(e.target.result);
  reader.onerror = () => { alert('Failed to read file.'); showScreen('upload'); };
  reader.readAsText(file, 'windows-1252');
}

/* ═══════════════════════════════════════════════════════════════
   SESSION PROCESSING
═══════════════════════════════════════════════════════════════ */
function processSession(filename, text) {
  DOM.loadingStatus.textContent = 'Detecting sensors…';

  const { rows, headers } = Parser.parseCSV(text);
  const groups   = Parser.detectColumns(headers);
  const interval = Parser.estimateInterval(rows);

  DOM.loadingStatus.textContent = 'Running diagnostics…';

  const events   = Diagnostics.detectEvents(rows, groups, interval);
  const health   = Diagnostics.computeHealthScore(rows, groups, events);
  const timeline = Diagnostics.buildTimeline(rows, groups);
  const recs     = Diagnostics.generateRecommendations(rows, groups, events, health);
  const corrs    = Diagnostics.computeCorrelations(rows, groups);

  const sampled  = Parser.downsample(rows, MAX_CHART_PTS);
  const labels   = sampled.map(r => shortTime(r['Time']));
  const cfgs     = Charts.buildConfigs(groups, sampled, labels);

  // Store in state
  Object.assign(State, {
    rows, groups, events, health, timeline, recs, corrs,
    chartCfgs: cfgs, sampledRows: sampled, labels,
    filename, intervalSec: interval,
  });

  showScreen('app');
  renderAll();
}

/* ═══════════════════════════════════════════════════════════════
   RENDER PIPELINE
═══════════════════════════════════════════════════════════════ */
function renderAll() {
  renderHeader();
  renderOverviewTab();
  renderChartsTab();
  renderEventsTable();
}

// ── Header ────────────────────────────────────────────────────────
function renderHeader() {
  const { health, filename, events } = State;
  DOM.hdrFilename.textContent  = filename;
  DOM.hdrHealthScore.textContent = health.score;

  DOM.hdrHealthPill.className = 'health-pill ' + (
    health.score >= 75 ? 'ok' : health.score >= 50 ? 'warn' : 'danger'
  );

  const critCount = events.filter(e => e.severity === 'critical').length;
  if (critCount) {
    DOM.eventsBadge.textContent = critCount;
    DOM.eventsBadge.hidden = false;
  }
}

// ── Overview Tab ─────────────────────────────────────────────────
function renderOverviewTab() {
  renderHealthRing();
  renderSessionMeta();
  renderTimeline();
  renderCorrelations();
  renderRecommendations(); // "What to do" first
  renderAlerts();          // "What happened" second
  renderStats();           // Raw numbers last
}

function renderHealthRing() {
  const { health } = State;
  const pct = health.score / 100;
  const circumference = 2 * Math.PI * 50; // r=50
  const offset = circumference * (1 - pct);
  const color  = health.score >= 75 ? 'var(--ok)' : health.score >= 50 ? 'var(--warn)' : 'var(--danger)';

  DOM.healthRingArc.style.strokeDashoffset = offset;
  DOM.healthRingArc.style.stroke = color;

  DOM.healthScoreNum.textContent = health.score;
  DOM.healthScoreNum.style.color = color;
  DOM.healthGrade.textContent    = health.grade;
  DOM.healthGrade.style.color    = color;

  // Breakdown rows
  DOM.healthBreakdown.innerHTML = '';
  if (health.breakdown.length) {
    health.breakdown.forEach(b => {
      const row = el('div', 'breakdown-row');
      row.innerHTML = `<span>${esc(b.label)}</span><span class="breakdown-deduct sev-${b.severity}">−${b.deduct}</span>`;
      DOM.healthBreakdown.appendChild(row);
    });
  } else {
    DOM.healthBreakdown.innerHTML = `<div class="breakdown-row" style="color:var(--ok)">No deductions ✓</div>`;
  }
}

function renderSessionMeta() {
  const { rows, filename, intervalSec } = State;
  const first = rows[0], last = rows[rows.length - 1];
  const duration = formatDuration((rows.length - 1) * intervalSec);
  DOM.metaFilename.textContent = filename;
  DOM.metaDate.textContent     = first?.['Date'] ?? '—';
  DOM.metaStart.textContent    = first?.['Time'] ? formatTime(first['Time']) : '—';
  DOM.metaEnd.textContent      = last?.['Time']  ? formatTime(last['Time'])  : '—';
  DOM.metaDuration.textContent = duration;
  DOM.metaSamples.textContent  = rows.length.toLocaleString() + ' readings';
}

function renderTimeline() {
  DOM.timelineStrip.innerHTML = '';
  State.timeline.forEach(seg => {
    const s = el('div', `tl-seg ${seg.severity}`);
    s.title = `${seg.time} — ${seg.severity}`;
    s.addEventListener('click', () => {
      // Jump to events tab if critical
      if (seg.severity === 'crit') switchTab('events');
    });
    DOM.timelineStrip.appendChild(s);
  });
}

function renderCorrelations() {
  const list = DOM.correlationsList;
  list.innerHTML = '';

  const insights = buildInsights();

  if (!insights.length) {
    list.innerHTML = `<p style="font-size:11px;color:var(--text-3);padding:4px 0">Not enough data to generate observations.</p>`;
    return;
  }

  insights.forEach(ins => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;align-items:flex-start;padding:7px 0;border-bottom:1px solid var(--border);font-size:11px;';
    row.innerHTML = `<span style="font-size:15px;flex-shrink:0;line-height:1.3">${ins.icon}</span>
      <div>
        <span style="color:var(--text-1);font-weight:700;display:block;margin-bottom:2px">${esc(ins.title)}</span>
        <span style="color:var(--text-2);line-height:1.6">${esc(ins.detail)}</span>
      </div>`;
    row.lastElementChild.style.borderBottom = 'none';
    list.appendChild(row);
  });
  // Remove border on last item
  if (list.lastChild) list.lastChild.style.borderBottom = 'none';
}

/**
 * Convert Pearson correlations into plain-English insight objects.
 */
function buildInsights() {
  const insights = [];
  const { corrs, rows, groups, events } = State;

  // Correlation-based insights
  corrs.forEach(c => {
    const abs = Math.abs(c.r);
    if (abs < 0.35) return; // too weak to mention

    const strength = abs > 0.75 ? 'strongly' : abs > 0.5 ? 'noticeably' : 'slightly';

    if (c.a === 'CPU Load' && c.b === 'CPU Temp') {
      if (c.r > 0.75) {
        insights.push({ icon: '🌡', title: 'CPU heats up under load — normal behaviour', detail: `Temperature rises ${strength} when the processor is busy. This is expected; the concern is only if it crosses 90°C.` });
      } else if (c.r < 0.35) {
        insights.push({ icon: '⚠️', title: 'CPU is hot even when idle', detail: 'Temperature stays elevated regardless of workload. This suggests a cooling problem — dried thermal paste or a clogged heatsink — not an overloaded processor.' });
      }
    }

    if (c.a === 'GPU Load' && c.b === 'GPU Temp') {
      if (c.r > 0.6) {
        insights.push({ icon: '🎮', title: 'GPU temperature tracks workload — normal', detail: `GPU heats up ${strength} when doing graphical work. Check only if it exceeds 92°C.` });
      }
    }

    if (c.a === 'CPU Temp' && c.b === 'Fan Speed') {
      if (c.r > 0.6) {
        insights.push({ icon: '🌀', title: 'Fans respond well to heat', detail: 'Fan speed increases when the CPU gets hot. Cooling is working as intended.' });
      } else if (c.r < 0.25) {
        insights.push({ icon: '🔇', title: 'Fans barely react to temperature', detail: 'Fan speed does not increase much when the CPU heats up. Check fan curve settings in BIOS or if a fan has failed.' });
      }
    }
  });

  // Event-based observations (always useful even without correlations)
  const throttleEvents = events.filter(e => e.type === 'throttle');
  if (throttleEvents.length) {
    insights.push({ icon: '🚨', title: `Processor slowed itself down ${throttleEvents.length} time(s)`, detail: 'The CPU hit its thermal limit and had to reduce speed to cool down. This is the direct cause of freezes and lag spikes.' });
  }

  const cpuTempCol = Parser.prioritiseCpuTempCols(groups.cpuTemp)[0];
  const cpuLoadCol = groups.cpuLoad[0];
  if (cpuTempCol && cpuLoadCol) {
    const cpuT = Diagnostics.computeStats(rows, cpuTempCol);
    const cpuL = Diagnostics.computeStats(rows, cpuLoadCol);
    if (cpuT && cpuL && cpuT.avg > 65 && cpuL.avg < 30) {
      insights.push({ icon: '🧊', title: 'CPU runs warm even when doing almost nothing', detail: `Average load was only ${Math.round(cpuL.avg)}% but temperature averaged ${Math.round(cpuT.avg)}°C. The cooling system may need attention.` });
    }
    if (cpuL && cpuL.avg > 70) {
      insights.push({ icon: '⚙️', title: 'Processor was busy for most of the session', detail: `CPU load averaged ${Math.round(cpuL.avg)}% — well above comfortable levels. Background processes or insufficient CPU for the workload.` });
    }
  }

  const ramCol = groups.ramLoad[0];
  if (ramCol) {
    const ramS = Diagnostics.computeStats(rows, ramCol);
    if (ramS && ramS.avg > 75) {
      insights.push({ icon: '💾', title: 'PC was running low on memory most of the time', detail: `RAM averaged ${Math.round(ramS.avg)}% full. When memory runs out, Windows uses the hard drive as slow backup memory — this causes sluggishness.` });
    }
  }

  return insights.slice(0, 5);
}

function renderStats() {
  const { rows, groups } = State;
  DOM.statsGrid.innerHTML = '';
  const T = Diagnostics.THRESHOLDS;

  const cpuTempCols = Parser.prioritiseCpuTempCols(groups.cpuTemp);
  const gpuLoadCol  = Parser.prioritiseGpuLoadCols(groups.gpuLoad)[0];
  const ramCol      = groups.ramLoad[0] ?? groups.ramUsed[0];

  const defs = [
    cpuTempCols[0] && { label: 'CPU Temp',   col: cpuTempCols[0], unit: '°C',  warnAt: T.cpuTemp.warn,  dangerAt: T.cpuTemp.danger  },
    groups.gpuTemp[0] && { label: 'GPU Temp', col: groups.gpuTemp[0], unit: '°C', warnAt: T.gpuTemp.warn, dangerAt: T.gpuTemp.danger },
    groups.cpuLoad[0] && { label: 'CPU Load', col: groups.cpuLoad[0], unit: '%',  warnAt: T.cpuLoad.warn, dangerAt: T.cpuLoad.danger },
    gpuLoadCol && { label: 'GPU Load', col: gpuLoadCol, unit: '%', warnAt: null, dangerAt: null, cls: 'val-accent' },
    ramCol && { label: 'RAM Usage', col: ramCol, unit: ramCol.toLowerCase().includes('%') ? '%' : ' MB', warnAt: T.ramLoad.warn, dangerAt: T.ramLoad.danger },
    groups.fanRpm[0] && { label: 'Max Fan RPM', col: groups.fanRpm[0], unit: ' RPM', warnAt: null, dangerAt: null, cls: 'val-accent' },
    groups.power[0] && { label: 'CPU Power',  col: groups.power[0], unit: ' W', warnAt: null, dangerAt: null, cls: 'val-purple' },
  ].filter(Boolean);

  defs.forEach(d => {
    const s = Diagnostics.computeStats(rows, d.col);
    if (!s) return;
    const peakCls = d.cls ?? (
      d.dangerAt && s.max >= d.dangerAt ? 'val-danger' :
      d.warnAt   && s.max >= d.warnAt   ? 'val-warn'   : 'val-ok'
    );
    const card = el('div', 'stat-card');
    card.innerHTML = `
      <div class="stat-label">${esc(d.label)}</div>
      <div class="stat-peak ${peakCls}">${s.max.toFixed(0)}${esc(d.unit)}</div>
      <div class="stat-rows">
        <div class="stat-row">min <span>${s.min.toFixed(0)}${esc(d.unit)}</span></div>
        <div class="stat-row">avg <span>${s.avg.toFixed(0)}${esc(d.unit)}</span></div>
        <div class="stat-row">p95 <span>${s.p95.toFixed(0)}${esc(d.unit)}</span></div>
        <div class="stat-row">p99 <span>${s.p99.toFixed(0)}${esc(d.unit)}</span></div>
      </div>`;
    DOM.statsGrid.appendChild(card);
  });
}

function renderAlerts() {
  const { events } = State;
  DOM.alertsList.innerHTML = '';
  if (!events.length) {
    DOM.alertsList.innerHTML = `<div class="alert-item ok"><span class="alert-icon ok">✓</span><div><span class="alert-title">Everything stayed within normal limits</span><span class="alert-desc">No temperature spikes, CPU overloads, or memory pressure detected during this session.</span></div></div>`;
    return;
  }
  const shown = events.slice(0, 12);
  shown.forEach(e => {
    const sev  = e.severity;
    const icon = sev === 'critical' ? '✕' : '!';
    const item = el('div', `alert-item ${sev}`);
    const dur  = formatDuration(e.duration);
    const peak = e.type === 'throttle' ? 'Processor had to slow down' : `Reached ${e.peak}${e.unit}`;
    const what = e.type === 'throttle'
      ? `${esc(e.metric)} was active`
      : `${esc(e.metric)} exceeded the ${e.threshold}${e.unit} ${sev} limit`;
    item.innerHTML = `
      <span class="alert-icon ${sev}" aria-hidden="true">${icon}</span>
      <div>
        <span class="alert-title">${what}</span>
        <span class="alert-desc">${esc(peak)} · Started at ${esc(e.startTime)} · Lasted ${dur}</span>
      </div>`;
    DOM.alertsList.appendChild(item);
  });
}

function renderRecommendations() {
  DOM.recsList.innerHTML = '';
  State.recs.forEach(r => {
    const item = el('div', 'rec-item');
    item.innerHTML = `
      <span class="rec-icon">${r.icon}</span>
      <div>
        <span class="rec-title">${esc(r.title)}</span>
        <span class="rec-desc">${esc(r.desc)}</span>
      </div>`;
    DOM.recsList.appendChild(item);
  });
}

// ── Charts Tab ───────────────────────────────────────────────────
function renderChartsTab() {
  Charts.destroyAll();
  DOM.chartsGrid.innerHTML = '';

  const { chartCfgs, labels, compareRows, compareLabels } = State;
  const isDark = State.theme === 'dark';

  chartCfgs.forEach((cfg, idx) => {
    const card = el('div', `chart-card`);
    card.dataset.group = cfg.group;

    const canvasId = `chart_canvas_${idx}`;
    const thrHTML = cfg.thresholds.map(t =>
      `<span class="threshold-item"><span class="threshold-dash" style="border-color:${t.color};color:${t.color}"></span><span style="color:${t.color}">${t.val}${esc(cfg.unit)}</span></span>`
    ).join('');

    card.innerHTML = `
      <div class="chart-card-header">
        <span class="chart-card-title">${esc(cfg.title)}</span>
        <div class="chart-card-actions">
          <button class="btn-chart-dl" data-idx="${idx}" title="Download as PNG">↓ PNG</button>
        </div>
      </div>
      <div class="chart-canvas-wrap"><canvas id="${canvasId}" role="img" aria-label="${esc(cfg.title)} chart"></canvas></div>
      ${thrHTML ? `<div class="chart-thresholds">${thrHTML}</div>` : ''}`;

    DOM.chartsGrid.appendChild(card);

    requestAnimationFrame(() => {
      const canvas = document.getElementById(canvasId);
      const chart  = Charts.create(canvas, labels, cfg, compareLabels ?? [], isDark);
      card.querySelector('.btn-chart-dl').addEventListener('click', () =>
        Charts.downloadPNG(chart, `pc-health_${cfg.title.toLowerCase().replace(/\s+/g, '_')}`)
      );
    });
  });

  filterChartCards();
}

function filterChartCards() {
  const group = State.activeChartGroup;
  document.querySelectorAll('.chart-card').forEach(card => {
    card.hidden = group !== 'all' && card.dataset.group !== group;
  });
}

// ── Events Table ─────────────────────────────────────────────────
function renderEventsTable() {
  const { events, eventsFilter } = State;
  let filtered = events;
  if (eventsFilter === 'critical')  filtered = events.filter(e => e.severity === 'critical' && e.type !== 'throttle');
  if (eventsFilter === 'warning')   filtered = events.filter(e => e.severity === 'warning');
  if (eventsFilter === 'throttle')  filtered = events.filter(e => e.type === 'throttle');

  DOM.eventsTbody.innerHTML = '';
  DOM.eventsEmpty.hidden = !!filtered.length;

  const critCount = events.filter(e => e.severity === 'critical').length;
  const warnCount = events.filter(e => e.severity === 'warning').length;
  DOM.eventsSummary.textContent = `${critCount} critical · ${warnCount} warnings · ${events.filter(e=>e.type==='throttle').length} throttle events`;

  filtered.forEach(e => {
    const tr = el('tr');
    const sevClass = e.type === 'throttle' ? 'throttle' : e.severity;
    const peak = e.type === 'throttle' ? 'Active' : `${e.peak}${e.unit}`;
    tr.innerHTML = `
      <td><span class="sev-badge ${sevClass}">${sevClass.toUpperCase()}</span></td>
      <td>${esc(e.metric)}</td>
      <td>${esc(e.startTime)}</td>
      <td>${esc(e.endTime)}</td>
      <td>${formatDuration(e.duration)}</td>
      <td><strong>${esc(peak)}</strong></td>
      <td>${esc(String(e.threshold))}</td>`;
    DOM.eventsTbody.appendChild(tr);
  });
}

/* ═══════════════════════════════════════════════════════════════
   EXPORT
═══════════════════════════════════════════════════════════════ */
function copySummary() {
  const { health, events, rows, groups, filename, intervalSec } = State;
  const T = Diagnostics.THRESHOLDS;
  const lines = [
    `PC Health Report — ${filename}`,
    `Generated: ${new Date().toLocaleString()}`,
    `Health Score: ${health.score}/100 (${health.grade})`,
    `Samples: ${rows.length} @ ~${intervalSec}s interval`,
    '',
    '── Peak Values ─────────────────────────────',
  ];

  const cpuTCol = Parser.prioritiseCpuTempCols(groups.cpuTemp)[0];
  const gpuTCol = groups.gpuTemp[0];
  const cpuLCol = groups.cpuLoad[0];
  const ramCol  = groups.ramLoad[0];

  const addStat = (label, col, unit) => {
    if (!col) return;
    const s = Diagnostics.computeStats(rows, col);
    if (s) lines.push(`${label}: max=${s.max.toFixed(1)}${unit}  avg=${s.avg.toFixed(1)}${unit}  p95=${s.p95.toFixed(1)}${unit}`);
  };
  addStat('CPU Temp', cpuTCol,  '°C');
  addStat('GPU Temp', gpuTCol,  '°C');
  addStat('CPU Load', cpuLCol,  '%');
  addStat('RAM Load', ramCol,   '%');

  lines.push('', '── Events ──────────────────────────────────');
  if (!events.length) {
    lines.push('No threshold violations detected.');
  } else {
    events.slice(0, 20).forEach(e => {
      const peak = e.type === 'throttle' ? 'Throttle' : `peak ${e.peak}${e.unit}`;
      lines.push(`[${e.severity.toUpperCase()}] ${e.metric} — ${e.startTime}→${e.endTime} (${formatDuration(e.duration)}) ${peak}`);
    });
  }

  lines.push('', '── Recommendations ─────────────────────────');
  State.recs.forEach(r => lines.push(`• ${r.title}: ${r.desc}`));

  navigator.clipboard.writeText(lines.join('\n')).then(() => {
    DOM.copyConfirm.hidden = false;
    setTimeout(() => { DOM.copyConfirm.hidden = true; }, 2500);
  });
}

/* ═══════════════════════════════════════════════════════════════
   NAVIGATION
═══════════════════════════════════════════════════════════════ */
function switchTab(tab) {
  State.activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
    btn.setAttribute('aria-selected', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-pane').forEach(pane => {
    pane.hidden = pane.id !== `tab-${tab}`;
  });
}

function showScreen(name) {
  DOM.screenUpload.hidden  = name !== 'upload';
  DOM.screenLoading.hidden = name !== 'loading';
  DOM.screenApp.hidden     = name !== 'app';
}

function resetApp() {
  Charts.destroyAll();
  Object.assign(State, {
    rows: null, groups: null, events: null, health: null,
    timeline: null, recs: null, corrs: null, chartCfgs: null,
    sampledRows: null, labels: null, filename: '',
    compareRows: null, compareLabels: null, compareActive: false,
    activeTab: 'overview', eventsFilter: 'all',
  });
  DOM.fileInput.value = '';
  DOM.compareFileInput.value = '';
  DOM.eventsBadge.hidden = true;
  switchTab('overview');
  showScreen('upload');
}

/* ═══════════════════════════════════════════════════════════════
   THEME
═══════════════════════════════════════════════════════════════ */
function toggleTheme() {
  applyTheme(State.theme === 'dark' ? 'light' : 'dark');
}

function applyTheme(theme) {
  State.theme = theme;
  document.documentElement.dataset.theme = theme;
  const icon = theme === 'dark' ? '☽' : '☀';
  DOM.btnTheme.textContent = icon;
  DOM.btnThemeUpload.textContent = icon;
  localStorage.setItem('pha-theme', theme);
  Charts.updateTheme(theme === 'dark');
}

/* ═══════════════════════════════════════════════════════════════
   UTILITIES
═══════════════════════════════════════════════════════════════ */
function el(tag, className = '') {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shortTime(t = '') {
  const parts = t.split(':');
  return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : t;
}

/** Format HH:MM:SS.mmm → HH:MM:SS */
function formatTime(t = '') {
  return t.split('.')[0]; // strip milliseconds if present
}

function formatDuration(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60), s = Math.round(seconds % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/* ═══════════════════════════════════════════════════════════════
   BOOT
═══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', init);
