# PC Health Analyzer

Browser-based viewer for **HWiNFO64** CSV sensor logs. Drop a log file and instantly get a health score, event timeline, correlations, zoom-able charts, and plain-English diagnostics — all locally in your browser.

**Live:** [Open Website](https://dumitru2002.github.io/hwinfo-analyzer)

---

## Features

| Feature | Details |
|---|---|
| **Health Score** | 0–100 score with per-factor breakdown (throttling, temps, load, RAM) |
| **Event Log** | Every threshold breach logged with start/end time, duration, and peak value |
| **Thermal Throttling** | Detected directly from HWiNFO's `Thermal Throttling` Yes/No columns |
| **Correlations** | Pearson r analysis: CPU load↔temp, GPU load↔temp, temp↔fan |
| **Extended Stats** | min / avg / max / p95 / p99 for every sensor |
| **Activity Timeline** | Colour-coded session strip showing normal / warning / critical periods |
| **Crosshair Sync** | Hover any chart — vertical line appears on all charts simultaneously |
| **Zoom & Pan** | Mouse wheel zoom and drag-pan on every chart |
| **Compare Mode** | Load two sessions to overlay them on all charts |
| **Export** | Download every chart as PNG, print a full PDF report, copy text summary |
| **Dark / Light theme** | Persisted in localStorage |
| **AMD & Intel** | Tctl/Tdie, Package, Core temps all handled correctly |
| **Windows-1252** | Reads HWiNFO's default ANSI encoding (degree symbol, etc.) |
| **100% local** | Zero data uploaded, works offline after first load |

---

## How to use

### Record a session
1. Download [HWiNFO64](https://www.hwinfo.com/download/) (free)
2. Open → **Sensors only** → Start
3. Click the **floppy disk 💾** icon to enable CSV logging, choose a save path
4. Work through your session
5. Click the same icon to **stop logging**

### Analyze
- Open the GitHub Pages URL
- Drag the `.csv` file onto the upload zone
- Review all four tabs: **Overview, Charts, Events, Export**

---

## Sensor thresholds

| Metric | Warning | Critical |
|---|---|---|
| CPU Temperature | 80°C | 90°C |
| GPU Temperature | 83°C | 92°C |
| CPU Load (avg) | 70% | 90% |
| RAM Load (p95) | 80% | 92% |
| System Temps | 65°C | 75°C |

---

## Project structure

```
hwinfo-analyzer/
├── index.html       ← markup + screen structure
├── styles.css       ← full design system (dark/light)
├── js/
│   ├── parser.js     ← CSV parsing, column detection
│   ├── diagnostics.js← health score, events, correlations
│   ├── charts.js     ← chart rendering, crosshair, zoom
│   └── app.js        ← UI controller, tabs, export
└── README.md
```

---

## License

MIT — free to use, modify, and share.
