/**
 * Report generation engines. Faithful port of backend/app/reports.py.
 *
 * - XLSX  : exceljs           (Python openpyxl)
 * - PDF   : playwright        (Python Playwright headless Chromium HTML->PDF)
 *   with a pure-Node pdfkit FALLBACK (Python's fpdf2 fallback) used when
 *   Chromium isn't available / launch fails.
 * - PNG   : playwright        (full-page screenshot; no fallback, same as Python)
 *
 * X-Report-Engine value: 'playwright' when Chromium ran, otherwise 'pdfkit'.
 * NOTE the substitution: Python reports 'fpdf2' for its pure-Python fallback;
 * the Node fallback is pdfkit, so this port reports 'pdfkit' for that case.
 *
 * NOTE (perf): Playwright/Chromium PDF rendering is CPU/IO heavy and, like the
 * Python version, runs in-process — a Chromium launch + render blocks this
 * request. The migration plan flags isolating this into a worker/queue; that is
 * out of scope here (see docs/BACKEND-MIGRATION-ANALYSIS.md).
 */
import { Workbook } from 'exceljs';
import PDFDocument from 'pdfkit';
import { chromium } from 'playwright';

type PdfDoc = InstanceType<typeof PDFDocument>;

// Status values that read as "good" (green) vs "bad" (red) in exports.
const GOOD = new Set(['on_track', 'complete', 'solved', 'done']);
const BAD = new Set(['off_track', 'open']);

/** (header, key) column descriptor — mirrors Python's list[tuple]. */
export type Column = [string, string];

export interface WeeklyPoint {
  week_ending: string;
  actual_value: number;
  rag: string;
  status: string;
}

export interface ScorecardData {
  title: string;
  owner: string | null;
  comparison_operator: string | null;
  target_value: number;
  unit: string | null;
  weekly_history: WeeklyPoint[];
}

export interface SeatData {
  id: string;
  title: string;
  parent_seat_id: string | null;
  responsibilities: string | null;
  holder_name: string | null;
  holders: { id: string; name: string }[];
  gwc_gets: boolean | null;
  gwc_wants: boolean | null;
  gwc_capacity: boolean | null;
}

export type EngineResult = { buffer: Buffer; engine: string };

// --------------------------------------------------------------- helpers ----
function fmt(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

/** html.escape(s, quote=True) equivalent. */
function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// exceljs ARGB (openpyxl fgColor is RGB; prefix full-opacity alpha).
const ARGB = {
  navy: 'FF1B3A5C',
  white: 'FFFFFFFF',
  good: 'FFE7F3EC',
  bad: 'FFFBEAE7',
  mid: 'FFFCF3D9',
  gridline: 'FFDFE2DC',
};
const solid = (argb: string) => ({ type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb } });
const THIN = { style: 'thin' as const, color: { argb: ARGB.gridline } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };

// ------------------------------------------------------------ Excel: list ---
export async function buildTableXlsx(
  sheetTitle: string,
  headline: string,
  columns: Column[],
  rows: Record<string, unknown>[],
): Promise<Buffer> {
  const wb = new Workbook();
  const ws = wb.addWorksheet(sheetTitle.slice(0, 31));

  const a1 = ws.getCell('A1');
  a1.value = headline;
  a1.font = { size: 15, bold: true, color: { argb: ARGB.navy } };

  const row0 = 3;
  columns.forEach(([header], idx) => {
    const cell = ws.getRow(row0).getCell(idx + 1);
    cell.value = header;
    cell.fill = solid(ARGB.navy);
    cell.font = { color: { argb: ARGB.white }, bold: true };
    cell.alignment = { horizontal: 'left' };
    cell.border = BORDER;
  });

  rows.forEach((r, i) => {
    const rr = row0 + 1 + i;
    columns.forEach(([, key], idx) => {
      const cell = ws.getRow(rr).getCell(idx + 1);
      cell.value = fmt(r[key]);
      cell.border = BORDER;
      cell.alignment = { horizontal: 'left', vertical: 'top', wrapText: key === 'description' };
      if (key === 'status') {
        const v = String(r.status ?? '').toLowerCase();
        if (GOOD.has(v)) cell.fill = solid(ARGB.good);
        else if (BAD.has(v)) cell.fill = solid(ARGB.bad);
      }
    });
  });

  const widths: Record<string, number> = {
    title: 34,
    description: 40,
    owner_name: 20,
    created_by_name: 20,
    team_name: 18,
  };
  columns.forEach(([, key], idx) => {
    ws.getColumn(idx + 1).width = widths[key] ?? 14;
  });
  ws.views = [{ state: 'frozen', ySplit: 3 }]; // freeze_panes = "A4"

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// -------------------------------------------------------- Excel: scorecard --
export async function buildScorecardXlsx(tenantName: string, scorecards: ScorecardData[]): Promise<Buffer> {
  const wb = new Workbook();
  const ws = wb.addWorksheet('Scorecard');

  const a1 = ws.getCell('A1');
  a1.value = `Scorecard — ${tenantName}`;
  a1.font = { size: 15, bold: true, color: { argb: ARGB.navy } };

  // widest week history across KPIs -> column set
  const maxWeeks = scorecards.reduce((m, s) => Math.max(m, s.weekly_history.length), 0);
  let weeks: string[] = [];
  for (const s of scorecards) {
    for (const w of s.weekly_history) {
      if (!weeks.includes(w.week_ending)) weeks.push(w.week_ending);
    }
  }
  weeks = maxWeeks ? weeks.slice().sort().slice(-maxWeeks) : [];

  const header = ['KPI', 'Owner', 'Target', ...weeks];
  const row0 = 3;
  header.forEach((title, idx) => {
    const cell = ws.getRow(row0).getCell(idx + 1);
    cell.value = title;
    cell.fill = solid(ARGB.navy);
    cell.font = { color: { argb: ARGB.white }, bold: true };
    cell.alignment = { horizontal: 'center' };
    cell.border = BORDER;
  });

  const ragFill: Record<string, string> = { GREEN: ARGB.good, YELLOW: ARGB.mid, RED: ARGB.bad };

  scorecards.forEach((s, i) => {
    const r = row0 + 1 + i;
    const c1 = ws.getRow(r).getCell(1);
    c1.value = s.title;
    c1.border = BORDER;
    const c2 = ws.getRow(r).getCell(2);
    c2.value = s.owner || 'Unassigned';
    c2.border = BORDER;
    const c3 = ws.getRow(r).getCell(3);
    c3.value = `${s.comparison_operator} ${s.target_value} ${s.unit || ''}`.trim();
    c3.border = BORDER;

    const byWeek = new Map(s.weekly_history.map((w) => [w.week_ending, w]));
    weeks.forEach((wk, idx) => {
      const cell = ws.getRow(r).getCell(4 + idx);
      cell.border = BORDER;
      cell.alignment = { horizontal: 'center' };
      const w = byWeek.get(wk);
      if (w) {
        cell.value = w.actual_value;
        const rag = w.rag || (w.status === 'ON_TRACK' ? 'GREEN' : 'RED');
        cell.fill = solid(ragFill[rag] ?? ARGB.bad);
      }
    });
  });

  ws.getColumn(1).width = 26;
  ws.getColumn(2).width = 18;
  ws.getColumn(3).width = 16;
  for (let c = 4; c < 4 + weeks.length; c++) ws.getColumn(c).width = 12;
  ws.views = [{ state: 'frozen', xSplit: 3, ySplit: 3 }]; // freeze_panes = "D4"

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// -------------------------------------------------------------- HTML: list --
export function buildTableHtml(headline: string, columns: Column[], rows: Record<string, unknown>[]): string {
  const head = columns.map(([h]) => `<th>${esc(h)}</th>`).join('');

  const cell = (r: Record<string, unknown>, key: string): string => {
    const val = esc(fmt(r[key]));
    if (key === 'status') {
      const v = String(r.status ?? '').toLowerCase();
      const cls = GOOD.has(v) ? 'on' : BAD.has(v) ? 'off' : '';
      return `<td class="${cls}">${val}</td>`;
    }
    return `<td class="${key === 'title' ? 'kpi' : ''}">${val}</td>`;
  };

  const body = rows
    .map((r) => '<tr>' + columns.map(([, key]) => cell(r, key)).join('') + '</tr>')
    .join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
      body { font-family: -apple-system, 'Segoe UI', sans-serif; color:#1b2430; padding:28px; }
      h1 { color:#122943; font-size:20px; margin:0 0 14px; }
      table { border-collapse:collapse; width:100%; font-size:11px; }
      th, td { border:1px solid #dfe2dc; padding:6px 8px; text-align:left; vertical-align:top; }
      thead th { background:#1b3a5c; color:#fff; }
      td.kpi { font-weight:600; color:#122943; }
      td.on { background:#e7f3ec; } td.off { background:#fbeae7; }
    </style></head><body>
      <h1>${esc(headline)}</h1>
      <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
    </body></html>`;
}

// --------------------------------------------------------- HTML: scorecard --
export function buildScorecardHtml(tenantName: string, scorecards: ScorecardData[]): string {
  const weekSet = new Set<string>();
  for (const s of scorecards) for (const w of s.weekly_history) weekSet.add(w.week_ending);
  const weeks = [...weekSet].sort();

  const cells = (s: ScorecardData): string => {
    const byWeek = new Map(s.weekly_history.map((w) => [w.week_ending, w]));
    let out = '';
    for (const wk of weeks) {
      const w = byWeek.get(wk);
      if (w) {
        const rag = w.rag || (w.status === 'ON_TRACK' ? 'GREEN' : 'RED');
        const cls = rag === 'GREEN' ? 'on' : rag === 'YELLOW' ? 'mid' : 'off';
        out += `<td class="${cls}">${w.actual_value}</td>`;
      } else {
        out += '<td></td>';
      }
    }
    return out;
  };

  const rows = scorecards
    .map(
      (s) =>
        `<tr><td class='kpi'>${esc(s.title)}</td>` +
        `<td>${esc(s.owner || 'Unassigned')}</td>` +
        `<td>${esc(s.comparison_operator)} ${s.target_value} ${esc(s.unit || '')}</td>` +
        `${cells(s)}</tr>`,
    )
    .join('');
  const weekCols = weeks.map((wk) => `<th>${wk.slice(5)}</th>`).join(''); // MM-DD

  return `<!doctype html><html><head><meta charset="utf-8"><style>
      body { font-family: -apple-system, 'Segoe UI', sans-serif; color:#1b2430; padding:28px; }
      h1 { color:#122943; font-size:20px; margin:0 0 2px; }
      .sub { color:#5b6570; font-size:12px; margin:0 0 18px; }
      table { border-collapse:collapse; width:100%; font-size:11px; }
      th, td { border:1px solid #dfe2dc; padding:5px 7px; text-align:center; }
      thead th { background:#1b3a5c; color:#fff; }
      td.kpi { text-align:left; font-weight:600; color:#122943; }
      td.on { background:#e7f3ec; } td.mid { background:#fcf3d9; } td.off { background:#fbeae7; }
    </style></head><body>
      <h1>Scorecard — ${esc(tenantName)}</h1>
      <p class="sub">Measurables with Red / Yellow / Green status.</p>
      <table><thead><tr><th style="text-align:left">KPI</th><th>Owner</th><th>Target</th>${weekCols}</tr></thead>
      <tbody>${rows}</tbody></table>
    </body></html>`;
}

// --------------------------------------------------------- HTML: org chart --
export function buildOrgchartHtml(tenantName: string, seats: SeatData[]): string {
  const byParent = new Map<string | null, SeatData[]>();
  for (const s of seats) {
    const key = s.parent_seat_id ?? null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(s);
  }

  const gwcDot = (val: boolean | null, letter: string): string => {
    const color = val === true ? '#2E7D5B' : val === false ? '#B4472E' : '#c9cdd3';
    return `<span class="dot" style="background:${color}" title="${letter}">${letter}</span>`;
  };

  const node = (s: SeatData): string => {
    const holders = s.holders || [];
    const who = holders.length ? holders.map((h) => h.name).join(', ') : s.holder_name || 'Vacant';
    const resp = (s.responsibilities || '')
      .split('\n')
      .map((r) => r.trim())
      .filter((r) => r)
      .slice(0, 5);
    const bullets = resp.map((r) => `<li>${esc(r)}</li>`).join('');
    const gwc = gwcDot(s.gwc_gets, 'G') + gwcDot(s.gwc_wants, 'W') + gwcDot(s.gwc_capacity, 'C');
    const kids = (byParent.get(s.id) || []).map((c) => node(c)).join('');
    const kidsHtml = kids ? `<div class="kids">${kids}</div>` : '';
    return (
      `<div class="branch"><div class="seat">` +
      `<div class="seat-top"><span class="stitle">${esc(s.title)}</span>` +
      `<span class="gwc">${gwc}</span></div>` +
      `<div class="who">${esc(who)}</div>` +
      `${bullets ? `<ul>${bullets}</ul>` : ''}` +
      `</div>${kidsHtml}</div>`
    );
  };

  const roots = (byParent.get(null) || []).map((s) => node(s)).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
      body { font-family:-apple-system,'Segoe UI',sans-serif; color:#1b2430; padding:24px; }
      h1 { color:#122943; font-size:20px; margin:0 0 16px; }
      .branch { margin-left:18px; border-left:1px solid #dfe2dc; padding-left:14px; }
      .kids { margin-top:4px; }
      .seat { display:inline-block; background:#fff; border:1px solid #dfe2dc; border-radius:10px;
               padding:9px 13px; margin:5px 0; min-width:210px; box-shadow:0 1px 3px rgba(0,0,0,.05); }
      .seat-top { display:flex; justify-content:space-between; align-items:center; gap:12px; }
      .stitle { font-weight:700; color:#122943; }
      .who { font-size:12px; color:#5b6570; margin-top:2px; }
      ul { margin:6px 0 0; padding-left:16px; font-size:11px; color:#3b4653; }
      .gwc { display:inline-flex; gap:3px; }
      .dot { width:16px; height:16px; border-radius:50%; color:#fff; font-size:9px; font-weight:700;
              display:inline-flex; align-items:center; justify-content:center; }
    </style></head><body>
      <h1>Accountability Chart — ${esc(tenantName)}</h1>
      ${roots || '<p style="color:#5b6570">No seats defined.</p>'}
    </body></html>`;
}

// ------------------------------------------------------- Playwright render ---
const PDF_MARGIN_TABLE = { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' };
const PDF_MARGIN_ORG = { top: '10mm', bottom: '10mm', left: '8mm', right: '8mm' };

async function htmlToPdf(html: string, margin: Record<string, string>): Promise<Buffer> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const pdf = await page.pdf({ format: 'A4', landscape: true, printBackground: true, margin });
    return pdf;
  } finally {
    await browser.close();
  }
}

async function htmlToPng(html: string): Promise<Buffer> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.setContent(html, { waitUntil: 'load' });
    return await page.screenshot({ fullPage: true });
  } finally {
    await browser.close();
  }
}

// -------------------------------------------------------------- PDF: list ---
export async function buildTablePdf(
  headline: string,
  columns: Column[],
  rows: Record<string, unknown>[],
): Promise<EngineResult> {
  const html = buildTableHtml(headline, columns, rows);
  try {
    const pdf = await htmlToPdf(html, PDF_MARGIN_TABLE);
    return { buffer: pdf, engine: 'playwright' };
  } catch {
    return { buffer: await buildTablePdfFallback(headline, columns, rows), engine: 'pdfkit' };
  }
}

// --------------------------------------------------------- PDF: scorecard ---
export async function buildScorecardPdf(tenantName: string, scorecards: ScorecardData[]): Promise<EngineResult> {
  const html = buildScorecardHtml(tenantName, scorecards);
  try {
    const pdf = await htmlToPdf(html, PDF_MARGIN_TABLE);
    return { buffer: pdf, engine: 'playwright' };
  } catch {
    return { buffer: await buildScorecardPdfFallback(tenantName, scorecards), engine: 'pdfkit' };
  }
}

// --------------------------------------------------------- PDF/PNG: orgchart -
// Playwright only — matches Python (no fallback; errors surface as 500).
export async function buildOrgchartPdf(tenantName: string, seats: SeatData[]): Promise<EngineResult> {
  const html = buildOrgchartHtml(tenantName, seats);
  const pdf = await htmlToPdf(html, PDF_MARGIN_ORG);
  return { buffer: pdf, engine: 'playwright' };
}

export async function buildOrgchartPng(tenantName: string, seats: SeatData[]): Promise<Buffer> {
  const html = buildOrgchartHtml(tenantName, seats);
  return htmlToPng(html);
}

// ---------------------------------------------------- pdfkit fallbacks ------
// Pure-Node equivalents of Python's fpdf2 fallbacks. Landscape A4. The layout is
// a best-effort match of the fpdf2 tables (same colors, header, status shading,
// 40-char truncation); exact pixel parity with fpdf2 is not required.

const RGB = {
  navyText: '#122943',
  headerBg: '#1b3a5c',
  headerText: '#ffffff',
  subText: '#5b6570',
  good: '#e7f3ec',
  yellow: '#fcf3d9',
  bad: '#fbeae7',
  white: '#ffffff',
  gridline: '#dfe2dc',
};

function pdfToBuffer(doc: PdfDoc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

/** Draw one bordered (optionally filled) cell with truncated single-line text. */
function drawCell(
  doc: PdfDoc,
  x: number,
  y: number,
  w: number,
  h: number,
  text: string,
  opts: { fill?: string; textColor?: string; align?: 'left' | 'center'; bold?: boolean; size?: number },
): void {
  if (opts.fill) doc.save().rect(x, y, w, h).fill(opts.fill).restore();
  doc.save().lineWidth(0.5).strokeColor(RGB.gridline).rect(x, y, w, h).stroke().restore();
  doc
    .font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
    .fontSize(opts.size ?? 8)
    .fillColor(opts.textColor ?? RGB.navyText)
    .text(text.slice(0, 40), x + 3, y + h / 2 - (opts.size ?? 8) / 2, {
      width: w - 6,
      height: h,
      align: opts.align ?? 'left',
      lineBreak: false,
      ellipsis: true,
    });
}

async function buildTablePdfFallback(
  headline: string,
  columns: Column[],
  rows: Record<string, unknown>[],
): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28 });
  const left = doc.page.margins.left;
  const avail = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.font('Helvetica-Bold').fontSize(15).fillColor(RGB.navyText).text(headline, { lineBreak: false });
  let y = doc.y + 6;

  const colW = avail / columns.length;
  const headerH = 18;
  const rowH = 16;

  columns.forEach(([header], idx) => {
    drawCell(doc, left + idx * colW, y, colW, headerH, header, {
      fill: RGB.headerBg,
      textColor: RGB.headerText,
      bold: true,
    });
  });
  y += headerH;

  for (const r of rows) {
    columns.forEach(([, key], idx) => {
      const x = left + idx * colW;
      const txt = fmt(r[key]);
      if (key === 'status') {
        const v = String(r.status ?? '').toLowerCase();
        const fill = GOOD.has(v) ? RGB.good : BAD.has(v) ? RGB.bad : RGB.white;
        drawCell(doc, x, y, colW, rowH, txt, { fill });
      } else {
        drawCell(doc, x, y, colW, rowH, txt, {});
      }
    });
    y += rowH;
    if (y + rowH > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.page.margins.top;
    }
  }

  return pdfToBuffer(doc);
}

async function buildScorecardPdfFallback(tenantName: string, scorecards: ScorecardData[]): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28 });
  const left = doc.page.margins.left;
  const avail = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.font('Helvetica-Bold').fontSize(15).fillColor(RGB.navyText).text(`Scorecard - ${tenantName}`, { lineBreak: false });
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(RGB.subText)
    .text('Weekly measurables (on-track / off-track)', { lineBreak: false });
  let y = doc.y + 6;

  const weekSet = new Set<string>();
  for (const s of scorecards) for (const w of s.weekly_history) weekSet.add(w.week_ending);
  const weeks = [...weekSet].sort();

  const kpiW = avail * 0.28;
  const tgtW = avail * 0.12;
  const wkW = Math.max(30, (avail - kpiW - tgtW) / Math.max(weeks.length, 1));
  const headerH = 18;
  const rowH = 16;

  drawCell(doc, left, y, kpiW, headerH, 'KPI', { fill: RGB.headerBg, textColor: RGB.headerText, bold: true });
  drawCell(doc, left + kpiW, y, tgtW, headerH, 'Target', {
    fill: RGB.headerBg,
    textColor: RGB.headerText,
    bold: true,
    align: 'center',
  });
  weeks.forEach((wk, idx) => {
    drawCell(doc, left + kpiW + tgtW + idx * wkW, y, wkW, headerH, wk.slice(5), {
      fill: RGB.headerBg,
      textColor: RGB.headerText,
      bold: true,
      align: 'center',
    });
  });
  y += headerH;

  const ragRgb: Record<string, string> = { GREEN: RGB.good, YELLOW: RGB.yellow, RED: RGB.bad };

  for (const s of scorecards) {
    const byWeek = new Map(s.weekly_history.map((w) => [w.week_ending, w]));
    drawCell(doc, left, y, kpiW, rowH, s.title, {});
    drawCell(doc, left + kpiW, y, tgtW, rowH, `${s.comparison_operator} ${s.target_value}`, { align: 'center' });
    weeks.forEach((wk, idx) => {
      const x = left + kpiW + tgtW + idx * wkW;
      const w = byWeek.get(wk);
      if (w) {
        const rag = w.rag || (w.status === 'ON_TRACK' ? 'GREEN' : 'RED');
        drawCell(doc, x, y, wkW, rowH, String(w.actual_value), { fill: ragRgb[rag] ?? RGB.bad, align: 'center' });
      } else {
        drawCell(doc, x, y, wkW, rowH, '', { fill: RGB.white, align: 'center' });
      }
    });
    y += rowH;
    if (y + rowH > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.page.margins.top;
    }
  }

  return pdfToBuffer(doc);
}
