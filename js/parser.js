/**
 * PC Health Analyzer — js/parser.js
 * CSV parsing + intelligent column classification for HWiNFO64 logs.
 * Supports Windows-1252 and UTF-8 encoded files from all HWiNFO versions.
 */

'use strict';

const Parser = (() => {

  // ── Degree symbol variants ─────────────────────────────────────
  // HWiNFO saves in Windows-1252; degree (0xB0) may appear differently
  // depending on how the browser reads the file.
  function isTemperatureCol(hl) {
    if (hl.includes('\u00b0c') || hl.includes('\xb0c') || hl.includes('\ufffdc') || hl.includes('?c')) return true;
    if (hl.includes('temperature') || hl.includes('temp'))                                             return true;
    if (hl.includes('tctl') || hl.includes('tdie') || hl.includes('tccd') || hl.includes('tjunction')) return true;
    return false;
  }

  /**
   * Classifies CSV headers into typed sensor groups.
   * @param {string[]} headers
   * @returns {Object} groups
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
      throttle: [],   // thermal throttling Yes/No columns
    };

    for (const h of headers) {
      if (h === 'Date' || h === 'Time') continue;
      const hl = h.toLowerCase();

      const isTemp     = isTemperatureCol(hl);
      const isLoad     = hl.includes('%') || hl.includes('usage') || hl.includes('utilization') || hl.includes('load') || hl.includes('utility');
      const isMemMB    = hl.includes('mb') || hl.includes('gb');
      const isFan      = hl.includes('rpm') || hl.includes(' fan');
      const isPower    = hl.includes(' [w]') || (hl.includes('power') && !hl.includes('plan') && !hl.includes('state') && !hl.includes('limit')) || hl.includes('watt');
      const isThrottle = hl.includes('thermal throttling') || hl.includes('prochot') || hl.includes('(htc)');

      if (isThrottle) { groups.throttle.push(h); continue; }

      // ── Temperature ────────────────────────────────────────────
      if (isTemp) {
        const isGpu = hl.includes('gpu') || hl.includes('video') || hl.includes('vga') || hl.includes('gfx');
        const isCpu = hl.includes('cpu') || hl.includes('tctl') || hl.includes('tdie') || hl.includes('tccd')
                   || hl.includes('package') || hl.includes('tjunction')
                   || hl.includes('core temperatures')
                   || /^core\d/.test(hl);
        if      (isGpu) groups.gpuTemp.push(h);
        else if (isCpu) groups.cpuTemp.push(h);
        else            groups.sysTemp.push(h);
      }

      // ── Load / Utilisation ─────────────────────────────────────
      if (isLoad) {
        const isGpu = hl.includes('gpu') || hl.includes('video');
        const isCpu = hl.includes('cpu') || hl.includes('core usage') || hl.includes('core utility');
        const isRam = hl.includes('memory') || hl.includes('ram') || hl.includes('page file');

        if (isGpu && !hl.includes('memory') && !hl.includes('frame') && !hl.includes('dedicated') && !hl.includes('limit')) {
          if (hl.includes('utilization') || hl.includes('usage') || hl.includes('load') || hl.includes('core') || hl.includes('d3d')) {
            groups.gpuLoad.push(h);
          }
        } else if (isCpu && (hl.includes('total') || hl.includes('utility') || hl.includes('usage') || hl.includes('package'))) {
          groups.cpuLoad.push(h);
        } else if (isRam && (hl.includes('load') || hl.includes('usage') || hl.includes('utilization'))) {
          groups.ramLoad.push(h);
        }
      }

      // ── RAM size (MB) ──────────────────────────────────────────
      if (isMemMB && (hl.includes('physical') || hl.includes('ram')) && hl.includes('used')) {
        groups.ramUsed.push(h);
      }

      if (isFan)   groups.fanRpm.push(h);
      if (isPower) groups.power.push(h);
    }

    return groups;
  }

  /**
   * From a list of CPU temp columns, pick the most representative ones.
   * Priority: Tctl/Tdie (AMD) > Package (Intel) > named CPU > avg > per-core
   * @param {string[]} cols
   * @returns {string[]} up to 2, best first
   */
  function prioritiseCpuTempCols(cols) {
    const rank = c => {
      const cl = c.toLowerCase();
      if (cl.includes('tctl') || cl.includes('tdie'))        return 0;
      if (cl.includes('package'))                             return 1;
      if (cl.includes('cpu') && !cl.includes('core'))        return 2;
      if (cl.includes('core temperatures'))                   return 3;
      if (/^core\d/.test(cl))                                return 10;
      return 5;
    };
    return [...cols].sort((a, b) => rank(a) - rank(b)).slice(0, 2);
  }

  /**
   * Prefer "GPU Utilization" over GPU D3D sub-metrics.
   * @param {string[]} cols
   * @returns {string[]}
   */
  function prioritiseGpuLoadCols(cols) {
    const rank = c => {
      const cl = c.toLowerCase();
      if (cl.includes('gpu utilization') || (cl.includes('gpu') && cl.includes('utilization'))) return 0;
      if (cl.includes('gpu core load'))                                                           return 1;
      if (cl.includes('d3d usage'))                                                               return 2;
      return 5;
    };
    return [...cols].sort((a, b) => rank(a) - rank(b));
  }

  /**
   * Parse a full CSV text into { headers, rows }.
   * @param {string} text
   * @returns {{ headers: string[], rows: Record<string,string>[] }}
   */
  function parseCSV(text) {
    // Strip UTF-8 BOM if present
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

    const lines = text.split(/\r?\n/).filter(l => l.trim());

    // Find the header row (contains both Date and Time columns)
    let headerIdx = -1;
    for (let i = 0; i < Math.min(lines.length, 10); i++) {
      if (lines[i].includes('Date') && lines[i].includes('Time')) { headerIdx = i; break; }
    }
    if (headerIdx === -1) {
      // Fallback: first row with many columns
      for (let i = 0; i < Math.min(lines.length, 5); i++) {
        if (parseRow(lines[i]).length > 3) { headerIdx = i; break; }
      }
    }
    if (headerIdx === -1) throw new Error('No header row found. Is this a HWiNFO64 CSV log?');

    const headers = parseRow(lines[headerIdx]);
    const rows = [];

    for (let i = headerIdx + 1; i < lines.length; i++) {
      const cols = parseRow(lines[i]);
      if (cols.length < 3) continue;
      const row = {};
      headers.forEach((h, idx) => { row[h] = cols[idx] ?? ''; });
      rows.push(row);
    }

    if (!rows.length) throw new Error('File contains no data rows after the header.');
    return { headers, rows };
  }

  /**
   * Parse a single CSV line, respecting quoted fields.
   * @param {string} line
   * @returns {string[]}
   */
  function parseRow(line) {
    const result = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"')           { inQ = !inQ; }
      else if (ch === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
      else                         { cur += ch; }
    }
    result.push(cur.trim());
    return result;
  }

  /**
   * Parse a sensor value string to a float (handles comma as decimal).
   * @param {string|undefined} v
   * @returns {number|null}
   */
  function parseVal(v) {
    if (!v) return null;
    const n = parseFloat(String(v).replace(',', '.'));
    return isNaN(n) ? null : n;
  }

  /**
   * Strip HWiNFO unit suffixes and degree characters for display labels.
   * @param {string} col
   * @returns {string}
   */
  function cleanLabel(col) {
    return col
      .replace(/\[.*?\]/g, '')
      .replace(/[°\xb0\u00b0\ufffd]/g, '')
      .trim()
      .substring(0, 32);
  }

  /**
   * Uniformly downsample an array to at most maxPoints.
   * @template T
   * @param {T[]} arr
   * @param {number} max
   * @returns {T[]}
   */
  function downsample(arr, max) {
    if (arr.length <= max) return arr;
    const step = arr.length / max;
    return Array.from({ length: max }, (_, i) =>
      arr[Math.min(Math.floor(i * step), arr.length - 1)]
    );
  }

  /**
   * Estimate sample interval in seconds from the first two row timestamps.
   * @param {Record<string,string>[]} rows
   * @returns {number} seconds
   */
  function estimateInterval(rows) {
    if (rows.length < 2) return 2;
    try {
      const t0 = rows[0]['Time'], t1 = rows[1]['Time'];
      const parse = t => {
        const parts = t.split(':').map(Number);
        return parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
      };
      const diff = Math.abs(parse(t1) - parse(t0));
      return diff > 0 && diff < 60 ? diff : 2;
    } catch { return 2; }
  }

  return {
    parseCSV,
    detectColumns,
    prioritiseCpuTempCols,
    prioritiseGpuLoadCols,
    parseVal,
    cleanLabel,
    downsample,
    estimateInterval,
  };
})();
