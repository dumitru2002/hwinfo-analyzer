/**
 * PC Health Analyzer — app.js
 * Parses HWiNFO64 CSV sensor logs and renders charts + diagnostics.
 */

'use strict';

// ─── Constants ─────────────────────────────────────────────────────────────

const MAX_CHART_POINTS = 600;

const THRESHOLDS = {
  cpuTemp:  { warn: 80,  danger: 90  },
  gpuTemp:  { warn: 83,  danger: 92  },
  cpuLoad:  { warn: 70,  danger: 90  },
  ramLoad:  { warn: 80,  danger: 92  },
  sysTemp:  { warn: 65,  danger: 75  },
};

const CHART_COLORS = [
  '#4f8ef7', '#3fc97a', '#f5a623', '#f74f4f',
  '#a07ef5', '#4fd4d4', '#f74fb0',
];


// ─── DOM References ─────────────────────────────────────────────────────────

const elDropZone        = document.getElementById('drop-zone');
const elDropInner       = elDropZone.querySelector('.drop-inner');
const elFileInput       = document.getElementById('file-input');
const elLoadingScreen   = document.getElementById('loading-screen');
const elDashboard       = document.getElementById('dashboard');
const elInfoFilename    = document.getElementById('info-filename');
const elInfoDuration    = document.getElementById('info-duration');
const elInfoSamples     = document.getElementById('info-samples');
const elHealthBadge     = document.getElementById('health-badge');
const elBtnReset        = document.getElementById('btn-reset');
const elAlertsContainer = document.getElementById('alerts-container');
const elStatsGrid       = document.getElementById('stats-grid');
const elChartsGrid      = document.getElementById('charts-grid');

/** @type {Chart[]} */
const activeCharts = [];


// ─── Event Listeners ────────────────────────────────────────────────────────

elDropInner.addEventListener('dragover',   onDragOver);
elDropInner.addEventListener('dragleave',  onDragLeave);
elDropInner.addEventListener('drop',       onDrop);
elDropInner.addEventListener('click',      () => elFileInput.click());
elFileInput.addEventListener('change',     onFileInputChange);
elBtnReset.addEventListener('click',       resetApp);


// ─── Drag / Drop ────────────────────────────────────────────────────────────

function onDragOver(e) {
  e.preventDefault();
  elDropInner.classList.add('drag-over');
}

function onDragLeave() {
  elDropInner.classList.remove('drag-over');
}

function onDrop(e) {
  e.preventDefault();
  elDropInner.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) readFile(file);
}

function onFileInputChange(e) {
  const file = e.target.files[0];
  if (file) readFile(file);
}


// ─── File Reading ────────────────────────────────────────────────────────────

function readFile(file) {
  showLoading();
  const reader = new FileReader();
  reader.onload  = (e) => {
    try {
      parseAndRender(file.name, e.target.result);
    } catch (err) {
      alert(`Could not parse file:\n\n${err.message}\n\nMake sure this is a HWiNFO64 CSV log file.`);
      resetApp();
    }
  };
  reader.onerror = () => { alert('Failed to read file.'); resetApp(); };
  reader.readAsText(file);
}


// ─── CSV Parsing ─────────────────────────────────────────────────────────────

/**
 * Parses a raw CSV string into headers + row objects.
 * @param {string} text
 * @returns {{ headers: string[], rows: Record<string, string>[] }}
 */
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());

  let headerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    if (lines[i].includes('Date') && lines[i].includes('Time')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    for (let i = 0; i < Math.min(lines.length, 5); i++) {
      if (parseCSVRow(lines[i]).length > 3) { headerIdx = i; break; }
    }
  }
  if (headerIdx === -1) {
    throw new Error('Could not find a header row. Is this a HWiNFO64 CSV log?');
  }

  const headers = parseCSVRow(lines[headerIdx]);
  const rows = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = parseCSVRow(lines[i]);
    if (cols.length < 3) continue;
    /** @type {Record<string, string>} */
    const row = {};
    headers.forEach((h, idx) => { row[h] = cols[idx] ?? ''; });
    rows.push(row);
  }

  if (rows.length === 0) throw new Error('File contains no data rows.');
  return { headers, rows };
}

/**
 * Parses a single CSV line, respecting quoted fields.
 * @param {string} line
 * @returns {string[]}
 */
function parseCSVRow(line) {
  const result = [];
  let current = '';
  let inQuote = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"')      { inQuote = !inQuote; }
    else if (ch === ',' && !inQuote) { result.push(current.trim()); current = ''; }
    else { current += ch; }
  }
  result.push(current.trim());
  return result;
}


// ─── Column Detection ─────────────────────────────────────────────────────────

/**
 * Returns true if the header looks like a temperature column.
 * Handles degree symbol encoding variants (UTF-8, Windows-1252, replacement char).
 * @param {string} hl - lowercase header string
 */
function isTemperatureCol(hl) {
  // Various encodings of "°C": proper UTF-8, Windows-1252 mojibake, replacement char, plain ascii fallback
  const degreePatterns = ['°c', '\xb0c', '\u00b0c', '\ufffdc', '�c', '[c]'];
  if (degreePatterns.some(p => hl.includes(p))) return true;
  if (hl.includes('temperature') || hl.includes('temp')) return true;
  // AMD-specific: Tctl/Tdie, Tccd, Tjunction
  if (hl.includes('tctl') || hl.includes('tdie') || hl.includes('tccd') || hl.includes('tjunction')) return true;
  return false;
}

/**
 * Classifies CSV headers into sensor groups.
 * Handles real-world HWiNFO64 column naming variations across Intel/AMD/GPU vendors.
 * @param {string[]} headers
 */
function detectColumns(headers) {
  const groups = {
    cpuTemp:  [],
    gpuTemp:  [],
    sysTemp:  [],
    cpuLoad:  [],
    gpuLoad:  [],
    ramLoad:  [],
    ramUsed:  [],
    fanRpm:   [],
    power:    [],
  };

  for (const h of headers) {
    if (h === 'Date' || h === 'Time') continue;
    const hl = h.toLowerCase();

    const isTemp    = isTemperatureCol(hl);
    const isPercent = hl.includes('%');
    const isLoad    = isPercent || hl.includes('usage') || hl.includes('utilization') || hl.includes('load') || hl.includes('utility');
    const isMemSize = hl.includes('mb') || hl.includes('gb');
    const isFan     = hl.includes('rpm') || hl.includes(' fan');
    const isPower   = hl.includes(' [w]') || (hl.includes('power') && !hl.includes('plan') && !hl.includes('state')) || hl.includes('watt');

    // ── Temperature routing ───────────────────────────────────────────────────
    if (isTemp) {
      const isGpu = hl.includes('gpu') || hl.includes('video') || hl.includes('vga') || hl.includes('gfx');
      const isCpu = hl.includes('cpu')    || hl.includes('tctl') || hl.includes('tdie')
                 || hl.includes('tccd')   || hl.includes('package') || hl.includes('tjunction')
                 || hl.includes('core temperature') || hl.includes('core temp')
                 // "Core0", "Core1" etc but NOT "L3 Cache" or other non-core named cols
                 || /^core\d/.test(hl);

      if      (isGpu) groups.gpuTemp.push(h);
      else if (isCpu) groups.cpuTemp.push(h);
      else            groups.sysTemp.push(h);
    }

    // ── Load / utilization routing ─────────────────────────────────────────────
    if (isLoad) {
      const isGpu = hl.includes('gpu') || hl.includes('video') || hl.includes('vga');
      const isCpu = hl.includes('cpu') || hl.includes('core usage') || hl.includes('core utility');
      const isRam = hl.includes('memory') || hl.includes('ram') || hl.includes('page file');

      if (isGpu && (hl.includes('utilization') || hl.includes('usage') || hl.includes('load') || hl.includes('core') || hl.includes('d3d'))) {
        // Prefer "GPU Utilization" or "GPU Core Load" over framerate/memory columns
        if (!hl.includes('memory') && !hl.includes('frame') && !hl.includes('dedicated')) {
          groups.gpuLoad.push(h);
        }
      } else if (isCpu && (hl.includes('total') || hl.includes('utility') || hl.includes('usage') || hl.includes('package'))) {
        groups.cpuLoad.push(h);
      } else if (isRam && (hl.includes('load') || hl.includes('usage') || hl.includes('utilization'))) {
        groups.ramLoad.push(h);
      }
    }

    // ── RAM used (MB) ──────────────────────────────────────────────────────────
    if (isMemSize && (hl.includes('physical') || hl.includes('virtual') || hl.includes('ram'))) {
      if (hl.includes('used') || hl.includes('commit') || hl.includes('available') === false) {
        groups.ramUsed.push(h);
      }
    }

    if (isFan)   groups.fanRpm.push(h);
    if (isPower) groups.power.push(h);
  }

  return groups;
}


// ─── Data Helpers ─────────────────────────────────────────────────────────────

/**
 * Parses a sensor value string to a float (handles comma decimals).
 * @param {string} v
 * @returns {number|null}
 */
function parseVal(v) {
  if (!v) return null;
  const n = parseFloat(v.replace(',', '.'));
  return isNaN(n) ? null : n;
}

/**
 * Reduces an array to at most maxPoints by uniform sampling.
 * @template T
 * @param {T[]} arr
 * @param {number} maxPoints
 * @returns {T[]}
 */
function downsample(arr, maxPoints) {
  if (arr.length <= maxPoints) return arr;
  const step = arr.length / maxPoints;
  return Array.from({ length: maxPoints }, (_, i) => arr[Math.min(Math.floor(i * step), arr.length - 1)]);
}

/**
 * Max non-null numeric value across all rows for a column.
 * @param {Record<string, string>[]} rows
 * @param {string} col
 * @returns {number}
 */
function colMax(rows, col) {
  return Math.max(0, ...rows.map(r => parseVal(r[col]) ?? 0));
}

/**
 * Mean non-null numeric value for a column.
 * @param {Record<string, string>[]} rows
 * @param {string} col
 * @returns {number}
 */
function colAvg(rows, col) {
  const vals = rows.map(r => parseVal(r[col])).filter(v => v !== null);
  if (!vals.length) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * Returns a CSS class name based on value vs warn/danger thresholds.
 * @param {number} val
 * @param {number} warnAt
 * @param {number} dangerAt
 * @returns {string}
 */
function thresholdClass(val, warnAt, dangerAt) {
  if (val >= dangerAt) return 'val-danger';
  if (val >= warnAt)   return 'val-warn';
  return 'val-ok';
}

/**
 * Strips sensor unit suffixes and trims a column label for display.
 * @param {string} col
 * @returns {string}
 */
function cleanLabel(col) {
  return col.replace(/\[.*?\]/g, '').replace(/[°\xb0\u00b0\ufffd]/g, '').trim().substring(0, 32);
}

/**
 * From a list of CPU temp columns, pick the best single "whole package" representative.
 * Priority: Tctl/Tdie (AMD) > Package (Intel) > named CPU > core avg > individual cores.
 * @param {string[]} cols
 * @returns {string[]} sorted with best first, up to 2 entries
 */
function prioritiseCpuTempCols(cols) {
  const rank = (c) => {
    const cl = c.toLowerCase();
    if (cl.includes('tctl') || cl.includes('tdie'))           return 0;
    if (cl.includes('package'))                                return 1;
    if (cl.includes('cpu') && !cl.includes('core'))           return 2;
    if (cl.includes('core temperatures') || cl.includes('core temp')) return 3;
    if (/^core\d/.test(cl))                                   return 10;
    return 5;
  };
  return [...cols].sort((a, b) => rank(a) - rank(b)).slice(0, 2);
}


// ─── Main Parse & Render ──────────────────────────────────────────────────────

/**
 * Entry point: parse the CSV and populate the dashboard.
 * @param {string} filename
 * @param {string} text
 */
function parseAndRender(filename, text) {
  const { headers, rows } = parseCSV(text);
  const groups = detectColumns(headers);

  // Downsample rows for chart rendering
  const sampledRows  = downsample(rows, MAX_CHART_POINTS);
  const timestamps   = sampledRows.map(r => r['Time'] ?? '');
  const shortLabels  = timestamps.map(t => {
    const parts = t.split(':');
    return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : t;
  });

  /** Helper: extract numeric series for a column from sampled rows */
  const colSeries = (col) => sampledRows.map(r => parseVal(r[col]));

  const alerts = [];
  const stats  = [];
  const charts = [];

  // ── CPU Temperature ──────────────────────────────────────
  const cpuTempCols = prioritiseCpuTempCols(groups.cpuTemp);
  if (cpuTempCols.length) {
    const col   = cpuTempCols[0];
    const peak  = colMax(rows, col);
    const avg   = colAvg(rows, col);
    const cls   = thresholdClass(peak, THRESHOLDS.cpuTemp.warn, THRESHOLDS.cpuTemp.danger);

    stats.push({ label: 'CPU Temp Peak', value: `${Math.round(peak)}°C`, sub: `avg ${avg.toFixed(0)}°C`, cls });

    if (peak >= THRESHOLDS.cpuTemp.danger) {
      alerts.push({ level: 'danger', title: `CPU overheating — peak ${Math.round(peak)}°C`,
        desc: 'Temperatures above 90°C cause thermal throttling (sudden slowdowns) and long-term hardware damage. Clean the CPU cooler or replace thermal paste.' });
    } else if (peak >= THRESHOLDS.cpuTemp.warn) {
      alerts.push({ level: 'warn', title: `CPU running hot — peak ${Math.round(peak)}°C`,
        desc: 'Above 80°C under load. Monitor closely. Consider improving case airflow or the CPU cooler.' });
    }

    charts.push({
      title: 'CPU Temperature', unit: '°C',
      thresholds: [
        { val: THRESHOLDS.cpuTemp.warn,   color: '#f5a623' },
        { val: THRESHOLDS.cpuTemp.danger, color: '#f74f4f' },
      ],
      datasets: cpuTempCols.map((c, i) => ({
        label: cleanLabel(c),
        data:  colSeries(c),
        color: ['#4f8ef7', '#a07ef5'][i],
      })),
    });
  }

  // ── GPU Temperature ──────────────────────────────────────
  const gpuTempCols = groups.gpuTemp.slice(0, 1);
  if (gpuTempCols.length) {
    const col  = gpuTempCols[0];
    const peak = colMax(rows, col);
    const avg  = colAvg(rows, col);
    const cls  = thresholdClass(peak, THRESHOLDS.gpuTemp.warn, THRESHOLDS.gpuTemp.danger);

    stats.push({ label: 'GPU Temp Peak', value: `${Math.round(peak)}°C`, sub: `avg ${avg.toFixed(0)}°C`, cls });

    if (peak >= THRESHOLDS.gpuTemp.danger) {
      alerts.push({ level: 'danger', title: `GPU overheating — peak ${Math.round(peak)}°C`,
        desc: 'GPU above 92°C is critical. Check GPU fan operation, clean dust, and ensure adequate case airflow.' });
    } else if (peak >= THRESHOLDS.gpuTemp.warn) {
      alerts.push({ level: 'warn', title: `GPU running hot — peak ${Math.round(peak)}°C`,
        desc: 'GPU above 83°C may throttle under sustained load. Check case airflow and GPU fan curve.' });
    }

    charts.push({
      title: 'GPU Temperature', unit: '°C',
      thresholds: [
        { val: THRESHOLDS.gpuTemp.warn,   color: '#f5a623' },
        { val: THRESHOLDS.gpuTemp.danger, color: '#f74f4f' },
      ],
      datasets: [{ label: 'GPU Temp', data: colSeries(col), color: '#f74f4f' }],
    });
  }

  // ── CPU Load ─────────────────────────────────────────────
  const cpuLoadCols = groups.cpuLoad.slice(0, 1);
  if (cpuLoadCols.length) {
    const col  = cpuLoadCols[0];
    const peak = colMax(rows, col);
    const avg  = colAvg(rows, col);
    const cls  = thresholdClass(avg, THRESHOLDS.cpuLoad.warn, THRESHOLDS.cpuLoad.danger);

    stats.push({ label: 'CPU Load Peak', value: `${Math.round(peak)}%`, sub: `avg ${avg.toFixed(0)}%`, cls });

    if (avg >= THRESHOLDS.cpuLoad.danger) {
      alerts.push({ level: 'danger', title: `CPU maxed out — average ${avg.toFixed(0)}%`,
        desc: 'CPU was near 100% for most of the session. The PC runs out of processing power. Investigate background processes or consider a faster CPU.' });
    } else if (avg >= THRESHOLDS.cpuLoad.warn) {
      alerts.push({ level: 'warn', title: `CPU under heavy load — average ${avg.toFixed(0)}%`,
        desc: 'CPU was consistently under heavy load. Open Task Manager and check which processes are consuming the most CPU.' });
    }

    charts.push({
      title: 'CPU Load', unit: '%',
      thresholds: [
        { val: THRESHOLDS.cpuLoad.warn,   color: '#f5a623' },
        { val: THRESHOLDS.cpuLoad.danger, color: '#f74f4f' },
      ],
      datasets: [{ label: 'CPU Usage', data: colSeries(col), color: '#4f8ef7' }],
    });
  }

  // ── GPU Load ─────────────────────────────────────────────
  // Prefer "GPU Utilization" over sub-metrics like D3D usage
  const gpuLoadSorted = [...groups.gpuLoad].sort((a, b) => {
    const rank = (c) => {
      const cl = c.toLowerCase();
      if (cl.includes('utilization') && cl.includes('gpu')) return 0;
      if (cl.includes('core') && cl.includes('load'))       return 1;
      if (cl.includes('d3d usage'))                         return 2;
      return 5;
    };
    return rank(a) - rank(b);
  });
  const gpuLoadCols = gpuLoadSorted.slice(0, 1);
  if (gpuLoadCols.length) {
    const col  = gpuLoadCols[0];
    const peak = colMax(rows, col);
    const avg  = colAvg(rows, col);

    stats.push({ label: 'GPU Load Peak', value: `${Math.round(peak)}%`, sub: `avg ${avg.toFixed(0)}%`, cls: 'val-accent' });
    charts.push({
      title: 'GPU Load', unit: '%',
      thresholds: [],
      datasets: [{ label: 'GPU Usage', data: colSeries(col), color: '#a07ef5' }],
    });
  }

  // ── RAM ───────────────────────────────────────────────────
  const ramCol = groups.ramLoad[0] ?? groups.ramUsed[0];
  if (ramCol) {
    const peak      = colMax(rows, ramCol);
    const avg       = colAvg(rows, ramCol);
    const isPercent = ramCol.toLowerCase().includes('%') || ramCol.toLowerCase().includes('load') || ramCol.toLowerCase().includes('usage');
    const unit      = isPercent ? '%' : ' MB';
    const cls       = isPercent ? thresholdClass(peak, THRESHOLDS.ramLoad.warn, THRESHOLDS.ramLoad.danger) : 'val-accent';

    stats.push({ label: 'RAM Peak', value: `${Math.round(peak)}${unit}`, sub: `avg ${avg.toFixed(0)}${unit}`, cls });

    if (isPercent) {
      if (peak >= THRESHOLDS.ramLoad.danger) {
        alerts.push({ level: 'danger', title: `RAM nearly full — peak ${Math.round(peak)}%`,
          desc: 'System was almost out of memory. This causes severe slowdowns and disk swapping (very slow virtual memory). More RAM is the solution.' });
      } else if (peak >= THRESHOLDS.ramLoad.warn) {
        alerts.push({ level: 'warn', title: `RAM usage high — peak ${Math.round(peak)}%`,
          desc: 'RAM was heavily used. Close unused applications or browser tabs. Consider upgrading RAM.' });
      }
    }

    charts.push({
      title: 'RAM Usage', unit,
      thresholds: isPercent
        ? [{ val: THRESHOLDS.ramLoad.warn, color: '#f5a623' }, { val: THRESHOLDS.ramLoad.danger, color: '#f74f4f' }]
        : [],
      datasets: [{ label: 'RAM', data: colSeries(ramCol), color: '#3fc97a' }],
    });
  }

  // ── System Temperatures ───────────────────────────────────
  if (groups.sysTemp.length) {
    const cols = groups.sysTemp.slice(0, 3);
    charts.push({
      title: 'System Temperatures', unit: '°C',
      thresholds: [{ val: THRESHOLDS.sysTemp.danger, color: '#f5a623' }],
      datasets: cols.map((c, i) => ({
        label: cleanLabel(c),
        data:  colSeries(c),
        color: CHART_COLORS[i + 2],
      })),
    });
  }

  // ── Fan Speeds ────────────────────────────────────────────
  if (groups.fanRpm.length) {
    const cols   = groups.fanRpm.slice(0, 3);
    const peakRpm = Math.max(...cols.map(c => colMax(rows, c)));

    stats.push({ label: 'Max Fan Speed', value: `${Math.round(peakRpm)} RPM`, sub: `${cols.length} fan(s)`, cls: 'val-accent' });
    charts.push({
      title: 'Fan Speeds', unit: ' RPM',
      thresholds: [],
      datasets: cols.map((c, i) => ({
        label: cleanLabel(c),
        data:  colSeries(c),
        color: CHART_COLORS[i],
      })),
    });
  }

  // ── CPU Power ─────────────────────────────────────────────
  if (groups.power.length) {
    const col  = groups.power[0];
    const peak = colMax(rows, col);
    const avg  = colAvg(rows, col);

    stats.push({ label: 'CPU Power Peak', value: `${Math.round(peak)} W`, sub: `avg ${avg.toFixed(0)} W`, cls: 'val-purple' });
    charts.push({
      title: 'CPU Power Draw', unit: ' W',
      thresholds: [],
      datasets: [{ label: 'CPU Power', data: colSeries(col), color: '#f5a623' }],
    });
  }

  // ── No data fallback ──────────────────────────────────────
  if (!stats.length && !charts.length) {
    throw new Error('No recognizable sensor columns were found. Make sure logging was enabled in HWiNFO64 Sensors view before exporting.');
  }

  // ── Render ────────────────────────────────────────────────
  renderFileBar(filename, rows);
  renderHealthBadge(alerts);
  renderAlerts(alerts);
  renderStats(stats);
  renderCharts(charts, shortLabels);

  showDashboard();
}


// ─── Render Helpers ───────────────────────────────────────────────────────────

function renderFileBar(filename, rows) {
  const first = rows[0];
  const last  = rows[rows.length - 1];
  const date  = first?.['Date'] ?? '';
  const t0    = first?.['Time'] ?? '';
  const t1    = last?.['Time']  ?? '';

  elInfoFilename.textContent = filename;
  elInfoSamples.textContent  = rows.length.toLocaleString();
  elInfoDuration.textContent = date ? `${date}  ${t0} → ${t1}` : `${t0} → ${t1}`;
}

function renderHealthBadge(alerts) {
  const hasDanger = alerts.some(a => a.level === 'danger');
  const hasWarn   = alerts.some(a => a.level === 'warn');

  if (hasDanger) {
    elHealthBadge.className   = 'health-badge danger';
    elHealthBadge.textContent = 'Critical issues';
  } else if (hasWarn) {
    elHealthBadge.className   = 'health-badge warn';
    elHealthBadge.textContent = 'Warnings found';
  } else {
    elHealthBadge.className   = 'health-badge ok';
    elHealthBadge.textContent = 'Looks healthy';
  }
}

function renderAlerts(alerts) {
  elAlertsContainer.innerHTML = '';

  const items = alerts.length
    ? alerts
    : [{ level: 'ok', title: 'No issues detected', desc: 'All monitored values stayed within normal ranges throughout the session.' }];

  for (const a of items) {
    const iconMap  = { danger: '✕', warn: '!', ok: '✓' };
    const el       = document.createElement('div');
    el.className   = `alert alert-${a.level}`;
    el.innerHTML   = `
      <span class="alert-icon icon-${a.level}" aria-hidden="true">${iconMap[a.level]}</span>
      <div class="alert-body">
        <span class="alert-title">${escapeHTML(a.title)}</span>
        <span class="alert-desc">${escapeHTML(a.desc)}</span>
      </div>`;
    elAlertsContainer.appendChild(el);
  }
}

function renderStats(stats) {
  elStatsGrid.innerHTML = '';
  if (!stats.length) {
    elStatsGrid.innerHTML = '<p class="empty-note">No summary metrics available.</p>';
    return;
  }
  for (const s of stats) {
    const el      = document.createElement('div');
    el.className  = 'stat-card';
    el.innerHTML  = `
      <div class="stat-label">${escapeHTML(s.label)}</div>
      <div class="stat-value ${s.cls}">${escapeHTML(s.value)}</div>
      <div class="stat-sub">${escapeHTML(s.sub)}</div>`;
    elStatsGrid.appendChild(el);
  }
}

function renderCharts(charts, labels) {
  elChartsGrid.innerHTML = '';
  if (!charts.length) {
    elChartsGrid.innerHTML = '<p class="empty-note">No chart data available.</p>';
    return;
  }
  charts.forEach((ch, idx) => {
    const canvasId = `chart_${idx}`;
    const card     = document.createElement('div');
    card.className = 'chart-card';

    const thresholdHTML = ch.thresholds.map(t => `
      <span class="chart-threshold-item">
        <span class="threshold-dash" style="border-color:${t.color}; color:${t.color};"></span>
        <span style="color:${t.color};">${t.val}${ch.unit}</span>
      </span>`).join('');

    card.innerHTML = `
      <div class="chart-header">
        <h3 class="chart-title">${escapeHTML(ch.title)}</h3>
        <span class="chart-unit">${escapeHTML(ch.unit)}</span>
      </div>
      <div class="chart-canvas-wrap">
        <canvas id="${canvasId}" role="img" aria-label="${escapeHTML(ch.title)} chart over time"></canvas>
      </div>
      ${thresholdHTML ? `<div class="chart-thresholds">${thresholdHTML}</div>` : ''}`;

    elChartsGrid.appendChild(card);

    // Defer chart init so DOM is painted first
    requestAnimationFrame(() => initChart(canvasId, labels, ch));
  });
}

/**
 * Initialises a Chart.js line chart on the given canvas.
 * @param {string} canvasId
 * @param {string[]} labels
 * @param {{ title: string, unit: string, datasets: Array, thresholds: Array }} config
 */
function initChart(canvasId, labels, config) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const annotations = {};
  config.thresholds.forEach((t, i) => {
    annotations[`threshold_${i}`] = {
      type: 'line', yMin: t.val, yMax: t.val,
      borderColor: t.color, borderWidth: 1, borderDash: [5, 4],
    };
  });

  const chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: config.datasets.map((d, i) => ({
        label:           d.label,
        data:            d.data,
        borderColor:     d.color ?? CHART_COLORS[i % CHART_COLORS.length],
        backgroundColor: 'transparent',
        borderWidth:     1.5,
        pointRadius:     0,
        tension:         0.3,
        spanGaps:        true,
      })),
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      animation:           false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: config.datasets.length > 1,
          labels: {
            color:    '#7a8099',
            font:     { size: 10, family: "'JetBrains Mono', monospace" },
            boxWidth: 10,
            padding:  10,
          },
        },
        tooltip: {
          backgroundColor: '#1a1d24',
          borderColor:     '#252830',
          borderWidth:     1,
          titleColor:      '#dde1eb',
          bodyColor:       '#7a8099',
          padding:         10,
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed.y;
              return ` ${ctx.dataset.label}: ${v !== null ? v.toFixed(1) : 'N/A'}${config.unit}`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color:       '#454a5e',
            font:        { size: 10 },
            maxTicksLimit: 7,
            maxRotation: 0,
          },
          grid: { color: '#13151a' },
        },
        y: {
          ticks: {
            color:    '#454a5e',
            font:     { size: 10 },
            callback: (v) => `${Math.round(v)}${config.unit}`,
          },
          grid: { color: '#1a1d24' },
        },
      },
    },
  });

  activeCharts.push(chart);
}


// ─── State Transitions ─────────────────────────────────────────────────────

function showLoading() {
  elDropZone.hidden      = true;
  elLoadingScreen.hidden = false;
  elDashboard.hidden     = true;
}

function showDashboard() {
  elLoadingScreen.hidden = true;
  elDashboard.hidden     = false;
}

function resetApp() {
  // Destroy all active Chart.js instances to free memory
  activeCharts.forEach(c => c.destroy());
  activeCharts.length = 0;

  elAlertsContainer.innerHTML = '';
  elStatsGrid.innerHTML       = '';
  elChartsGrid.innerHTML      = '';
  elFileInput.value           = '';

  elDashboard.hidden     = true;
  elLoadingScreen.hidden = true;
  elDropZone.hidden      = false;
}


// ─── Utils ───────────────────────────────────────────────────────────────────

/**
 * Escapes a string for safe insertion into HTML.
 * @param {string} str
 * @returns {string}
 */
function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
