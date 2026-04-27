/**
 * PC Health Analyzer — js/diagnostics.js
 * Analysis engine: health scoring, event detection, correlations,
 * recommendations, session timeline, and extended statistics.
 */

'use strict';

const Diagnostics = (() => {

  // ── Sensor thresholds ────────────────────────────────────────────
  const THRESHOLDS = {
    cpuTemp: { warn: 80,  danger: 90  },
    gpuTemp: { warn: 83,  danger: 92  },
    cpuLoad: { warn: 70,  danger: 90  },
    ramLoad: { warn: 80,  danger: 92  },
    sysTemp: { warn: 65,  danger: 75  },
  };

  // ── Extended statistics ──────────────────────────────────────────

  /**
   * Compute min/avg/max/p95/p99 for a column.
   * @param {Record<string,string>[]} rows
   * @param {string} col
   * @returns {{ min, avg, max, p95, p99, count }|null}
   */
  function computeStats(rows, col) {
    const vals = rows.map(r => Parser.parseVal(r[col])).filter(v => v !== null);
    if (!vals.length) return null;
    vals.sort((a, b) => a - b);
    const sum = vals.reduce((a, b) => a + b, 0);
    const p = pct => vals[Math.floor((pct / 100) * (vals.length - 1))];
    return { min: vals[0], avg: sum / vals.length, max: vals[vals.length - 1], p95: p(95), p99: p(99), count: vals.length };
  }

  // ── Correlation ──────────────────────────────────────────────────

  /**
   * Pearson correlation coefficient between two value arrays.
   * @param {number[]} xs
   * @param {number[]} ys
   * @returns {number|null}
   */
  function pearsonCorr(xs, ys) {
    const n = Math.min(xs.length, ys.length);
    if (n < 5) return null;
    const x = xs.slice(0, n), y = ys.slice(0, n);
    const mx = x.reduce((a, b) => a + b, 0) / n;
    const my = y.reduce((a, b) => a + b, 0) / n;
    let num = 0, dx2 = 0, dy2 = 0;
    for (let i = 0; i < n; i++) {
      const dx = x[i] - mx, dy = y[i] - my;
      num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
    }
    const denom = Math.sqrt(dx2 * dy2);
    return denom === 0 ? 0 : +(num / denom).toFixed(3);
  }

  /**
   * Compute sensor correlations (CPU load↔temp, GPU load↔temp, temp↔fan).
   * @param {Record<string,string>[]} rows
   * @param {Object} groups
   * @returns {Array}
   */
  function computeCorrelations(rows, groups) {
    const getVals = col => rows.map(r => Parser.parseVal(r[col])).filter(v => v !== null);
    const corrs = [];
    const cpuTempCol = Parser.prioritiseCpuTempCols(groups.cpuTemp)[0];
    const cpuLoadCol = groups.cpuLoad[0];
    const gpuTempCol = groups.gpuTemp[0];
    const gpuLoadCol = Parser.prioritiseGpuLoadCols(groups.gpuLoad)[0];
    const fanCol     = groups.fanRpm[0];

    const add = (a, b, ca, cb) => {
      if (!ca || !cb) return;
      const r = pearsonCorr(getVals(ca), getVals(cb));
      if (r !== null) corrs.push({ a, b, r });
    };

    add('CPU Load', 'CPU Temp', cpuLoadCol, cpuTempCol);
    add('GPU Load', 'GPU Temp', gpuLoadCol, gpuTempCol);
    add('CPU Temp', 'Fan Speed', cpuTempCol, fanCol);
    add('CPU Load', 'CPU Power', cpuLoadCol, groups.power[0]);
    return corrs;
  }

  // ── Event detection ──────────────────────────────────────────────

  /**
   * Detect all threshold-crossing and throttling events in the session.
   * Groups consecutive above-threshold rows into a single event.
   * @param {Record<string,string>[]} rows
   * @param {Object} groups
   * @param {number} intervalSec - sample interval in seconds
   * @returns {Array}
   */
  function detectEvents(rows, groups, intervalSec = 2) {
    const events = [];

    // Metric configs to monitor
    const cpuTempCol = Parser.prioritiseCpuTempCols(groups.cpuTemp)[0];
    const gpuTempCol = groups.gpuTemp[0];
    const cpuLoadCol = groups.cpuLoad[0];
    const ramLoadCol = groups.ramLoad[0];

    const metrics = [
      cpuTempCol && { col: cpuTempCol, name: 'CPU Temp',  unit: '°C', ...THRESHOLDS.cpuTemp },
      gpuTempCol && { col: gpuTempCol, name: 'GPU Temp',  unit: '°C', ...THRESHOLDS.gpuTemp },
      cpuLoadCol && { col: cpuLoadCol, name: 'CPU Load',  unit: '%',  ...THRESHOLDS.cpuLoad },
      ramLoadCol && { col: ramLoadCol, name: 'RAM Load',  unit: '%',  ...THRESHOLDS.ramLoad },
    ].filter(Boolean);

    // Threshold events
    for (const mc of metrics) {
      let span = null;
      for (let i = 0; i <= rows.length; i++) {
        const val = i < rows.length ? Parser.parseVal(rows[i][mc.col]) : null;
        const sev = val !== null
          ? (val >= mc.danger ? 'critical' : val >= mc.warn ? 'warning' : null)
          : null;

        if (sev && !span) {
          span = { start: i, peak: val, sev, threshold: val >= mc.danger ? mc.danger : mc.warn };
        } else if (sev && span) {
          if (val > span.peak) { span.peak = val; }
          if (sev === 'critical') span.sev = 'critical';
        } else if ((!sev || i === rows.length) && span) {
          const endIdx = i - 1;
          events.push({
            type:      'threshold',
            severity:  span.sev,
            metric:    mc.name,
            unit:      mc.unit,
            startTime: rows[span.start]['Time'],
            endTime:   rows[endIdx]['Time'],
            duration:  (endIdx - span.start + 1) * intervalSec,
            peak:      +span.peak.toFixed(1),
            threshold: span.threshold,
            startIdx:  span.start,
            endIdx,
          });
          span = null;
        }
      }
    }

    // Thermal throttling events
    for (const tCol of groups.throttle) {
      let span = null;
      for (let i = 0; i <= rows.length; i++) {
        const active = i < rows.length && rows[i][tCol] === 'Yes';
        if (active && !span)  { span = { start: i }; }
        else if (!active && span) {
          const endIdx = i - 1;
          events.push({
            type:      'throttle',
            severity:  'critical',
            metric:    Parser.cleanLabel(tCol) || 'Thermal Throttle',
            unit:      '',
            startTime: rows[span.start]['Time'],
            endTime:   rows[endIdx]['Time'],
            duration:  (endIdx - span.start + 1) * intervalSec,
            peak:      'Yes',
            threshold: 'Active',
            startIdx:  span.start,
            endIdx,
          });
          span = null;
        }
      }
    }

    return events.sort((a, b) => {
      const o = { critical: 0, warning: 1 };
      return (o[a.severity] ?? 2) - (o[b.severity] ?? 2);
    });
  }

  // ── Health score ─────────────────────────────────────────────────

  /**
   * Compute a 0–100 health score with per-factor breakdown.
   * @param {Record<string,string>[]} rows
   * @param {Object} groups
   * @param {Array} events
   * @returns {{ score: number, breakdown: Array, grade: string }}
   */
  function computeHealthScore(rows, groups, events) {
    let score = 100;
    const breakdown = [];

    const deduct = (label, amount, severity) => {
      const d = Math.min(amount, score); // can't go below 0
      score -= d;
      if (d > 0) breakdown.push({ label, deduct: d, severity });
    };

    // Throttling
    const throttleCount = events.filter(e => e.type === 'throttle').length;
    if (throttleCount) deduct('Thermal throttling', Math.min(25, throttleCount * 12), 'critical');

    // CPU temperature (based on p95 to ignore momentary spikes)
    const cpuTempCol = Parser.prioritiseCpuTempCols(groups.cpuTemp)[0];
    if (cpuTempCol) {
      const s = computeStats(rows, cpuTempCol);
      if (s) {
        if (s.p95 >= THRESHOLDS.cpuTemp.danger)
          deduct('CPU temp critical (p95)', Math.min(18, Math.round((s.p95 - THRESHOLDS.cpuTemp.danger) * 1.8)), 'critical');
        else if (s.p95 >= THRESHOLDS.cpuTemp.warn)
          deduct('CPU temp elevated (p95)', Math.min(10, Math.round((s.p95 - THRESHOLDS.cpuTemp.warn) * 1.0)), 'warning');
      }
    }

    // GPU temperature
    if (groups.gpuTemp[0]) {
      const s = computeStats(rows, groups.gpuTemp[0]);
      if (s) {
        if (s.p95 >= THRESHOLDS.gpuTemp.danger)
          deduct('GPU temp critical (p95)', Math.min(14, Math.round((s.p95 - THRESHOLDS.gpuTemp.danger) * 1.5)), 'critical');
        else if (s.p95 >= THRESHOLDS.gpuTemp.warn)
          deduct('GPU temp elevated (p95)', Math.min(8, Math.round(s.p95 - THRESHOLDS.gpuTemp.warn)), 'warning');
      }
    }

    // CPU load — stat-based (sustained avg) + frequency-based (repeated danger spikes)
    if (groups.cpuLoad[0]) {
      const s = computeStats(rows, groups.cpuLoad[0]);
      if (s) {
        if (s.avg >= THRESHOLDS.cpuLoad.danger)
          deduct('CPU chronically maxed out', Math.min(15, Math.round((s.avg - THRESHOLDS.cpuLoad.danger) * 1.5)), 'critical');
        else if (s.avg >= THRESHOLDS.cpuLoad.warn)
          deduct('CPU under heavy sustained load', Math.min(8, Math.round(s.avg - THRESHOLDS.cpuLoad.warn)), 'warning');

        const cpuCritEvents = events.filter(e => e.type === 'threshold' && e.metric === 'CPU Load' && e.severity === 'critical').length;
        const cpuWarnEvents = events.filter(e => e.type === 'threshold' && e.metric === 'CPU Load' && e.severity === 'warning').length;
        if (cpuCritEvents)
          deduct('CPU repeatedly hit danger threshold', Math.min(20, cpuCritEvents * 4), 'critical');
        else if (cpuWarnEvents > 2)
          deduct('CPU frequently under high load', Math.min(10, (cpuWarnEvents - 2) * 2), 'warning');
      }
    }

    // RAM — stat-based (p95 level) + frequency-based (recurring pressure events)
    const ramCol = groups.ramLoad[0];
    if (ramCol) {
      const s = computeStats(rows, ramCol);
      if (s) {
        if (s.p95 >= THRESHOLDS.ramLoad.danger)
          deduct('RAM critically full (p95)', Math.min(15, Math.round((s.p95 - THRESHOLDS.ramLoad.danger) * 1.5)), 'critical');
        else if (s.p95 >= THRESHOLDS.ramLoad.warn)
          deduct('RAM near capacity (p95)', Math.min(8, Math.round(s.p95 - THRESHOLDS.ramLoad.warn)), 'warning');

        const ramEvents = events.filter(e => e.type === 'threshold' && e.metric === 'RAM Load').length;
        if (ramEvents > 1)
          deduct('RAM pressure recurring', Math.min(12, (ramEvents - 1) * 3), ramEvents >= 4 ? 'critical' : 'warning');
      }
    }

    score = Math.max(0, Math.round(score));

    const grade =
      score >= 90 ? 'EXCELLENT' :
      score >= 75 ? 'GOOD'      :
      score >= 60 ? 'FAIR'      :
      score >= 40 ? 'POOR'      : 'CRITICAL';

    return { score, breakdown, grade };
  }

  // ── Session timeline ─────────────────────────────────────────────

  /**
   * Divide the session into colour-coded severity buckets.
   * @param {Record<string,string>[]} rows
   * @param {Object} groups
   * @param {number} buckets - number of segments
   * @returns {Array<{ severity: string, time: string, idx: number }>}
   */
  function buildTimeline(rows, groups, events, buckets = 120) {
    const cpuTempCol = Parser.prioritiseCpuTempCols(groups.cpuTemp)[0];
    const cpuLoadCol = groups.cpuLoad[0];
    const gpuTempCol = groups.gpuTemp[0];
    const gpuLoadCol = Parser.prioritiseGpuLoadCols(groups.gpuLoad)[0];
    const ramLoadCol = groups.ramLoad[0];

    const size = Math.max(1, Math.ceil(rows.length / buckets));
    const segments = [];

    for (let i = 0; i < rows.length; i += size) {
      const slice = rows.slice(i, i + size);
      const endIdx = i + slice.length - 1;
      let sev = 'ok';

      const getMetric = (col, warnAt, dangerAt) => {
        if (!col) return null;
        const vals = slice.map(r => Parser.parseVal(r[col])).filter(v => v !== null);
        if (!vals.length) return null;
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        const max = Math.max(...vals);
        let metSev = avg >= dangerAt ? 'crit' : avg >= warnAt ? 'warn' : 'ok';
        if (metSev === 'crit')                  sev = 'crit';
        else if (metSev === 'warn' && sev !== 'crit') sev = 'warn';
        return { avg: Math.round(avg), max: Math.round(max), sev: metSev };
      };

      const cpuTemp = getMetric(cpuTempCol, THRESHOLDS.cpuTemp.warn, THRESHOLDS.cpuTemp.danger);
      const cpuLoad = getMetric(cpuLoadCol, THRESHOLDS.cpuLoad.warn, THRESHOLDS.cpuLoad.danger);
      const gpuTemp = getMetric(gpuTempCol, THRESHOLDS.gpuTemp.warn, THRESHOLDS.gpuTemp.danger);
      const gpuLoad = getMetric(gpuLoadCol, Infinity, Infinity);
      const ramLoad = getMetric(ramLoadCol, THRESHOLDS.ramLoad.warn, THRESHOLDS.ramLoad.danger);

      const segEvents = (events || []).filter(e =>
        e.startIdx <= endIdx && e.endIdx >= i
      );

      // Escalate severity based on events in this segment (catches brief spikes averaging below threshold)
      if (sev !== 'crit' && segEvents.some(e => e.severity === 'critical' || e.type === 'throttle')) {
        sev = 'crit';
      } else if (sev === 'ok' && segEvents.some(e => e.severity === 'warning')) {
        sev = 'warn';
      }

      segments.push({
        severity: sev,
        time:    slice[0]?.['Time'] ?? '',
        endTime: slice[slice.length - 1]?.['Time'] ?? '',
        idx: i, endIdx,
        metrics: { cpuTemp, cpuLoad, gpuTemp, gpuLoad, ramLoad },
        events: segEvents,
      });
    }

    return segments;
  }

  // ── Recommendations ──────────────────────────────────────────────

  /**
   * Generate rule-based diagnostic recommendations.
   * @param {Record<string,string>[]} rows
   * @param {Object} groups
   * @param {Array} events
   * @param {{ score, grade }} health
   * @returns {Array<{ severity, icon, title, desc }>}
   */
  function generateRecommendations(rows, groups, events, health) {
    const recs = [];

    const cpuTempCol = Parser.prioritiseCpuTempCols(groups.cpuTemp)[0];
    const cpuLoadCol = groups.cpuLoad[0];
    const gpuTempCol = groups.gpuTemp[0];
    const ramLoadCol = groups.ramLoad[0];

    const cpuT = cpuTempCol ? computeStats(rows, cpuTempCol) : null;
    const cpuL = cpuLoadCol ? computeStats(rows, cpuLoadCol) : null;
    const gpuT = gpuTempCol ? computeStats(rows, gpuTempCol) : null;
    const ramL = ramLoadCol ? computeStats(rows, ramLoadCol) : null;

    const throttles = events.filter(e => e.type === 'throttle');

    if (throttles.length) {
      recs.push({
        severity: 'critical', icon: '🚨',
        title: `Thermal throttling detected — ${throttles.length} event(s)`,
        desc: 'The CPU was forced to reduce its clock speed to prevent damage. This is the direct cause of the freezes and slowdowns. Immediately: clean dust from the CPU cooler, reapply thermal paste, and verify the cooler is seated correctly.',
      });
    }

    if (cpuT && cpuL) {
      if (cpuT.avg > 72 && cpuL.avg < 35) {
        recs.push({
          severity: 'warning', icon: '🌡',
          title: 'CPU runs hot under light workload',
          desc: 'CPU temperature is elevated even when under-utilised. This points to a thermal management issue — dried or insufficient thermal paste, a clogged heatsink, or poor case airflow — rather than a CPU load problem.',
        });
      }
      if (cpuT.p95 > 83 && cpuL.avg > 55) {
        recs.push({
          severity: 'warning', icon: '🔥',
          title: 'CPU cooler struggling under sustained load',
          desc: `CPU hit ${Math.round(cpuT.max)}°C peak while averaging ${Math.round(cpuL.avg)}% load. Consider upgrading the cooler, improving case airflow, or undervolting the CPU if this session is typical for this workload.`,
        });
      }
    }

    if (ramL && ramL.p95 > 80) {
      const level = ramL.p95 > 92 ? 'critical' : 'warning';
      recs.push({
        severity: level, icon: '💾',
        title: `RAM is a bottleneck — p95 usage ${Math.round(ramL.p95)}%`,
        desc: `Memory usage regularly exceeds ${Math.round(ramL.p95)}%. Windows is actively using the page file (slow virtual memory on disk). Adding more RAM would have the single biggest impact on day-to-day responsiveness.`,
      });
    }

    if (gpuT && gpuT.p95 > 83) {
      recs.push({
        severity: 'warning', icon: '🎮',
        title: `GPU temperatures elevated — peak ${Math.round(gpuT.max)}°C`,
        desc: 'Check GPU fan operation (listen for unusual sounds or stop-start at idle). Clean dust from the graphics card heatsink. Ensure the case has adequate exhaust airflow near the GPU.',
      });
    }

    if (health.score >= 88 && !throttles.length) {
      recs.push({
        severity: 'ok', icon: '✅',
        title: 'System is in good health',
        desc: 'All monitored sensors stayed within normal operating ranges throughout this session. No hardware issues were detected.',
      });
    }

    return recs;
  }

  return {
    THRESHOLDS,
    computeStats,
    computeCorrelations,
    detectEvents,
    computeHealthScore,
    buildTimeline,
    generateRecommendations,
  };
})();
