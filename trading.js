// Trading assistant: market posture, technical/VCP analysis, CANSLIM check, position sizing,
// pre-trade discipline gate and a trade journal. Everything runs in the browser; data stays in
// localStorage on this device and is never sent anywhere.
// Rules are adapted from tradermonty/claude-trading-skills (MIT): exposure-coach, vcp-screener,
// position-sizer, pre-trade-discipline-gate, drawdown-circuit-breaker, trader-memory-core.
(() => {
  'use strict';

  const KEYS = {
    settings: 'claudethinks.trading.settings.v1',
    trades: 'claudethinks.trading.trades.v1',
    market: 'claudethinks.trading.market.v1',
    tab: 'claudethinks.trading.tab',
  };

  const DEFAULT_SETTINGS = {
    account: null, lot: 100, feeBuy: 0.15, feeSell: 0.25,
    daily: 2, weekly: 5, monthly: 8, streak: 2,
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // --- Helpers -------------------------------------------------------------

  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      alert('Gagal menyimpan ke browser. Ekspor jurnalmu agar tidak hilang.');
      return false;
    }
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (ch) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
  }

  // Reads a numeric input; empty or invalid -> null.
  function num(id) {
    const el = document.getElementById(id);
    if (!el || el.value.trim() === '') return null;
    const v = Number(el.value);
    return Number.isFinite(v) ? v : null;
  }

  function setVal(id, v) {
    const el = document.getElementById(id);
    if (el) el.value = v === null || v === undefined || Number.isNaN(v) ? '' : String(v);
  }

  const nf0 = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
  const nf2 = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 });
  const rp = (x) => (x === null || !Number.isFinite(x) ? '—' : `${x < 0 ? '−' : ''}Rp ${nf0.format(Math.abs(Math.round(x)))}`);
  const n2 = (x) => (x === null || !Number.isFinite(x) ? '—' : nf2.format(x));
  const pct = (x, d = 1) => (x === null || !Number.isFinite(x) ? '—' : `${x.toFixed(d).replace('.', ',')}%`);

  function isoDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function parseISO(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function addDays(d, n) {
    const r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
  }

  const today = () => isoDate(new Date());

  function fmtDate(s) {
    if (!s) return '—';
    return parseISO(s).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function badge(text, tone) {
    return `<span class="badge badge-${tone}">${esc(text)}</span>`;
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // --- State ---------------------------------------------------------------

  let settings = { ...DEFAULT_SETTINGS, ...readJSON(KEYS.settings, {}) };
  let trades = readJSON(KEYS.trades, []);
  if (!Array.isArray(trades)) trades = [];
  let marketLog = readJSON(KEYS.market, {});
  if (!marketLog || typeof marketLog !== 'object' || Array.isArray(marketLog)) marketLog = {};

  let lastSizing = null; // { symbol, entry, stop, shares, riskRp }
  let lastAnalysis = null; // { symbol, pivot, stop, atr, rsScore }

  // --- Tabs ----------------------------------------------------------------

  const tabButtons = $$('.subtabs [role="tab"]');

  function showPanel(name) {
    if (!document.getElementById(`panel-${name}`)) name = 'pasar';
    tabButtons.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.panel === name)));
    $$('.panel').forEach((p) => { p.hidden = p.id !== `panel-${name}`; });
    try { localStorage.setItem(KEYS.tab, name); } catch { /* ignore */ }
    if (name === 'gerbang') renderBreaker();
    if (name === 'jurnal') renderJournal();
    if (name === 'analisis' && lastChart) requestAnimationFrame(() => drawChart(lastChart));
  }

  window.addEventListener('hashchange', () => { if (location.hash.length > 1) showPanel(location.hash.slice(1)); });

  tabButtons.forEach((b) => b.addEventListener('click', () => {
    history.replaceState(null, '', `#${b.dataset.panel}`);
    showPanel(b.dataset.panel);
  }));

  // =========================================================================
  // 1. Market posture (exposure-coach)
  // =========================================================================

  const WEIGHTS = { regime: 0.25, top_risk: 0.20, breadth: 0.15, uptrend: 0.15, institutional: 0.10, ftd: 0.05 };
  const CRITICAL = ['regime', 'top_risk', 'breadth'];
  const REGIME_SCORES = { broadening: 80, concentration: 60, transitional: 50, inflationary: 40, contraction: 20 };
  const REC_LABEL = {
    NEW_ENTRY_ALLOWED: ['Entri baru diizinkan', 'good'],
    REDUCE_ONLY: ['Hanya kurangi posisi', 'warn'],
    CASH_PRIORITY: ['Prioritaskan kas', 'bad'],
  };

  function distributionScore(days) {
    if (days <= 2) return 80;
    if (days <= 4) return 60;
    if (days === 5) return 40;
    if (days === 6) return 30;
    return 15;
  }

  function exposureCeiling(c) {
    if (c >= 80) return Math.min(100, Math.floor(90 + (c - 80)));
    if (c >= 65) return Math.floor(70 + (c - 65) * 1.3);
    if (c >= 50) return Math.floor(50 + (c - 50) * 1.3);
    if (c >= 35) return Math.floor(30 + (c - 35) * 1.3);
    if (c >= 20) return Math.floor(10 + (c - 20) * 1.3);
    return Math.max(0, Math.floor(c / 2));
  }

  function computePosture(inputs) {
    const scores = {};
    if (inputs.regime) scores.regime = REGIME_SCORES[inputs.regime];
    if (inputs.dist !== null) scores.top_risk = distributionScore(Math.round(inputs.dist));
    if (inputs.breadth !== null) scores.breadth = Math.max(0, Math.min(100, inputs.breadth));
    if (inputs.uptrend !== null) scores.uptrend = Math.max(0, Math.min(100, inputs.uptrend));
    if (inputs.flow !== null) scores.institutional = inputs.flow;
    if (inputs.ftd !== null) scores.ftd = inputs.ftd;

    const provided = Object.keys(scores);
    const missing = Object.keys(WEIGHTS).filter((k) => !(k in scores));
    const missingCritical = CRITICAL.filter((k) => !(k in scores)).length;

    let sum = 0;
    let wsum = 0;
    provided.forEach((k) => { sum += scores[k] * WEIGHTS[k]; wsum += WEIGHTS[k]; });
    const composite = wsum > 0 ? sum / wsum : 0;

    // Missing inputs shave the ceiling: fewer facts, less exposure.
    let ceiling = exposureCeiling(composite);
    if (missingCritical > 0) ceiling = Math.max(0, Math.round(ceiling * (1 - 0.15 * missingCritical)));

    let rec = 'NEW_ENTRY_ALLOWED';
    const top = scores.top_risk ?? null;
    if (composite < 30 || (top !== null && top < 25)) rec = 'CASH_PRIORITY';
    else if (composite < 50 || (top !== null && top < 40) || missingCritical >= 2) rec = 'REDUCE_ONLY';

    let confidence = 'RENDAH';
    if (provided.length >= 5 && missingCritical === 0) confidence = 'TINGGI';
    else if (provided.length >= 4 || missingCritical <= 1) confidence = 'SEDANG';

    const upBroad = scores.uptrend !== undefined && scores.uptrend >= 50;
    const brBroad = scores.breadth !== undefined && scores.breadth >= 50;
    const participation = upBroad && brBroad ? 'LUAS' : (upBroad || brBroad ? 'SEDANG' : 'SEMPIT');

    return { composite: Math.round(composite), ceiling, rec, confidence, participation, scores, missing, provided };
  }

  const LABELS = {
    regime: 'Rezim', top_risk: 'Risiko puncak', breadth: 'Breadth', uptrend: 'Uptrend',
    institutional: 'Institusi', ftd: 'FTD',
  };

  function postureHTML(p, date) {
    const [label, tone] = REC_LABEL[p.rec];
    const rows = Object.keys(WEIGHTS).map((k) => (
      `<tr><td>${LABELS[k]}</td><td>${k in p.scores ? p.scores[k] : '<span class="muted">kosong</span>'}</td><td>${Math.round(WEIGHTS[k] * 100)}%</td></tr>`
    )).join('');
    let advice;
    if (p.rec === 'CASH_PRIORITY') advice = 'Hindari komitmen baru. Pertimbangkan menaikkan porsi kas.';
    else if (p.rec === 'REDUCE_ONLY') advice = 'Jangan buka posisi baru. Kelola posisi yang ada, ambil sebagian saat menguat.';
    else advice = `Analisis saham boleh dilanjutkan, dengan total eksposur saham maksimal sekitar ${p.ceiling}% modal.`;
    return `
      <div class="result-head">
        <div>${badge(label, tone)} <span class="muted small">${esc(fmtDate(date))}</span></div>
        <div class="big">${p.ceiling}%<span class="muted small"> plafon eksposur</span></div>
      </div>
      <p>${advice}</p>
      <p class="small muted">Skor gabungan ${p.composite}/100 · Partisipasi ${p.participation} · Keyakinan ${p.confidence}
        (${p.provided.length} dari ${Object.keys(WEIGHTS).length} input).</p>
      <table class="mini"><thead><tr><th>Komponen</th><th>Skor</th><th>Bobot</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="small muted">Ini postur, bukan perintah beli/jual.</p>`;
  }

  function readMarketForm() {
    const regime = $('#m-regime').value || null;
    const ftd = $('#m-ftd').value === '' ? null : Number($('#m-ftd').value);
    const flow = $('#m-flow').value === '' ? null : Number($('#m-flow').value);
    return { regime, dist: num('m-dist'), breadth: num('m-breadth'), uptrend: num('m-uptrend'), ftd, flow };
  }

  function fillMarketForm(inputs) {
    $('#m-regime').value = inputs.regime || '';
    setVal('m-dist', inputs.dist);
    setVal('m-breadth', inputs.breadth);
    setVal('m-uptrend', inputs.uptrend);
    $('#m-ftd').value = inputs.ftd === null || inputs.ftd === undefined ? '' : String(inputs.ftd);
    $('#m-flow').value = inputs.flow === null || inputs.flow === undefined ? '' : String(inputs.flow);
  }

  function renderMarketHistory() {
    const dates = Object.keys(marketLog).sort().reverse().slice(0, 10);
    const box = $('#market-history');
    if (!dates.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<h3>Riwayat</h3><table class="mini"><thead><tr><th>Tanggal</th><th>Postur</th><th>Plafon</th><th>Keyakinan</th></tr></thead><tbody>${
      dates.map((d) => {
        const p = marketLog[d].result;
        const [label, tone] = REC_LABEL[p.rec];
        return `<tr><td>${esc(fmtDate(d))}</td><td>${badge(label, tone)}</td><td>${p.ceiling}%</td><td>${esc(p.confidence)}</td></tr>`;
      }).join('')}</tbody></table>`;
  }

  $('#market-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const inputs = readMarketForm();
    const result = computePosture(inputs);
    const date = today();
    marketLog[date] = { inputs, result, at: Date.now() };
    // Keep the log small: last 60 entries.
    const keep = Object.keys(marketLog).sort().slice(-60);
    marketLog = Object.fromEntries(keep.map((k) => [k, marketLog[k]]));
    writeJSON(KEYS.market, marketLog);
    const box = $('#market-result');
    box.innerHTML = postureHTML(result, date);
    box.hidden = false;
    renderMarketHistory();
  });

  function todayPosture() {
    return marketLog[today()]?.result || null;
  }

  // =========================================================================
  // 2. Technical analysis & VCP (vcp-screener)
  // =========================================================================

  function splitCSVLine(line, delim) {
    const out = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q;
      } else if (ch === delim && !q) {
        out.push(cur); cur = '';
      } else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  }

  function parseNumber(s, decimalComma) {
    if (s === undefined) return NaN;
    let t = s.replace(/["\s]/g, '');
    if (!t || /^(null|nan|-)$/i.test(t)) return NaN;
    if (decimalComma) t = t.replace(/\./g, '').replace(',', '.');
    else t = t.replace(/,/g, '');
    return Number(t);
  }

  function parseDate(s) {
    const t = s.replace(/"/g, '').trim();
    let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; // dd/mm/yyyy
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : isoDate(d);
  }

  function parseCSV(text) {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) throw new Error('File kosong atau hanya berisi header.');
    const head = lines[0];
    const counts = { ',': (head.match(/,/g) || []).length, ';': (head.match(/;/g) || []).length, '\t': (head.match(/\t/g) || []).length };
    const delim = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    const decimalComma = delim === ';';
    const cols = splitCSVLine(head, delim).map((c) => c.toLowerCase().replace(/"/g, ''));
    const find = (...names) => cols.findIndex((c) => names.some((n) => c === n || c.startsWith(n)));
    const iDate = find('date', 'tanggal', 'time');
    const iOpen = find('open', 'pembukaan');
    const iHigh = find('high', 'tertinggi');
    const iLow = find('low', 'terendah');
    let iClose = cols.findIndex((c) => c === 'close' || c === 'penutupan' || c === 'price' || c === 'last');
    if (iClose < 0) iClose = find('close', 'adj close', 'adj_close');
    const iVol = find('volume', 'vol');
    if ([iDate, iHigh, iLow, iClose].some((i) => i < 0)) {
      throw new Error('Kolom Date, High, Low, dan Close wajib ada di baris header.');
    }
    const rows = [];
    for (let k = 1; k < lines.length; k++) {
      const p = splitCSVLine(lines[k], delim);
      const date = parseDate(p[iDate] || '');
      const c = parseNumber(p[iClose], decimalComma);
      const h = parseNumber(p[iHigh], decimalComma);
      const l = parseNumber(p[iLow], decimalComma);
      let o = iOpen >= 0 ? parseNumber(p[iOpen], decimalComma) : c;
      const v = iVol >= 0 ? parseNumber(p[iVol], decimalComma) : NaN;
      if (!date || !(c > 0) || !(h > 0) || !(l > 0)) continue;
      if (!(o > 0)) o = c;
      rows.push({ d: date, o, h: Math.max(h, o, c), l: Math.min(l, o, c), c, v: Number.isFinite(v) ? v : 0 });
    }
    rows.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    // Drop duplicated dates (keep the last one).
    const dedup = [];
    rows.forEach((r) => {
      if (dedup.length && dedup[dedup.length - 1].d === r.d) dedup[dedup.length - 1] = r;
      else dedup.push(r);
    });
    if (dedup.length < 30) throw new Error(`Hanya ${dedup.length} baris valid terbaca. Perlu lebih banyak data.`);
    return dedup;
  }

  function sma(values, n) {
    const out = new Array(values.length).fill(null);
    let s = 0;
    for (let i = 0; i < values.length; i++) {
      s += values[i];
      if (i >= n) s -= values[i - n];
      if (i >= n - 1) out[i] = s / n;
    }
    return out;
  }

  function atrSeries(rows, n = 14) {
    const out = new Array(rows.length).fill(null);
    let prev = null;
    for (let i = 1; i < rows.length; i++) {
      const tr = Math.max(rows[i].h - rows[i].l, Math.abs(rows[i].h - rows[i - 1].c), Math.abs(rows[i].l - rows[i - 1].c));
      if (i < n) { prev = (prev ?? 0) + tr; if (i === n - 1) { prev /= n; out[i] = prev; } continue; }
      prev = (prev * (n - 1) + tr) / n; // Wilder smoothing
      out[i] = prev;
    }
    return out;
  }

  function rsScoreFromExcess(x) {
    const table = [[50, 100], [30, 95], [20, 90], [10, 80], [5, 70], [0, 60], [-5, 50], [-10, 40], [-20, 20]];
    for (const [min, score] of table) if (x >= min) return score;
    return 0;
  }

  function relativeStrength(rows, bench) {
    if (!bench || bench.length < 60) return null;
    const map = new Map(bench.map((r) => [r.d, r.c]));
    const closeAt = (idx) => {
      for (let k = idx; k >= Math.max(0, idx - 5); k--) {
        const v = map.get(rows[k].d);
        if (v) return v;
      }
      return null;
    };
    const last = rows.length - 1;
    const bLast = closeAt(last);
    if (!bLast) return null;
    const parts = [[63, 0.4], [126, 0.2], [189, 0.2], [252, 0.2]];
    let sum = 0;
    let w = 0;
    parts.forEach(([days, weight]) => {
      const i0 = last - days;
      if (i0 < 0) return;
      const b0 = closeAt(i0);
      if (!b0) return;
      const rs = (rows[last].c / rows[i0].c - 1) * 100;
      const rb = (bLast / b0 - 1) * 100;
      sum += (rs - rb) * weight;
      w += weight;
    });
    if (w === 0) return null;
    const excess = sum / w;
    return { excess, score: rsScoreFromExcess(excess) };
  }

  // ZigZag swing points: a reversal is confirmed once price moves `thr` away from the extreme.
  function swings(rows, start, thr) {
    const pts = [];
    let dir = 1; // 1 = tracking a high, -1 = tracking a low
    let hi = start;
    let lo = start;
    for (let i = start; i < rows.length; i++) {
      if (dir === 1) {
        if (rows[i].h >= rows[hi].h) hi = i;
        if (rows[hi].h - rows[i].l >= thr) { pts.push({ t: 'H', i: hi, p: rows[hi].h }); dir = -1; lo = i; }
      } else {
        if (rows[i].l <= rows[lo].l) lo = i;
        if (rows[i].h - rows[lo].l >= thr) { pts.push({ t: 'L', i: lo, p: rows[lo].l }); dir = 1; hi = i; }
      }
    }
    // Unconfirmed, still-forming extreme.
    if (dir === -1) pts.push({ t: 'L', i: lo, p: rows[lo].l, open: true });
    else if (pts.length) pts.push({ t: 'H', i: hi, p: rows[hi].h, open: true });
    return pts;
  }

  function analyze(rows, bench) {
    const closes = rows.map((r) => r.c);
    const vols = rows.map((r) => r.v);
    const s50 = sma(closes, 50);
    const s150 = sma(closes, 150);
    const s200 = sma(closes, 200);
    const atr = atrSeries(rows);
    const n = rows.length;
    const i = n - 1;
    const c = closes[i];
    const look52 = rows.slice(Math.max(0, n - 252));
    const hi52 = Math.max(...look52.map((r) => r.h));
    const lo52 = Math.min(...look52.map((r) => r.l));
    const rs = relativeStrength(rows, bench);

    const crit = [];
    const add = (label, ok) => crit.push({ label, ok });
    add('Harga > MA150 dan > MA200', s200[i] === null ? null : c > s150[i] && c > s200[i]);
    add('MA150 > MA200', s200[i] === null ? null : s150[i] > s200[i]);
    add('MA200 naik ≥ 22 sesi', s200[i - 22] == null ? null : s200[i] > s200[i - 22]);
    add('Harga > MA50', s50[i] === null ? null : c > s50[i]);
    add('Harga ≥ 25% di atas low 52 minggu', n < 200 ? null : c >= lo52 * 1.25);
    add('Harga dalam 25% dari high 52 minggu', n < 200 ? null : c >= hi52 * 0.75);
    add('Kekuatan relatif ≥ 70', rs ? rs.score >= 70 : null);
    const evaluated = crit.filter((x) => x.ok !== null);
    const passed = evaluated.filter((x) => x.ok).length;
    const trendScore = evaluated.length ? Math.round((passed / evaluated.length) * 100) : 0;
    const trendPass = evaluated.length >= 6 && trendScore >= 85;

    // Contractions inside the last 120 sessions, starting at the highest swing high.
    const lookback = Math.min(120, n - 1);
    const start = n - lookback;
    const atrNow = atr[i] ?? (rows[i].h - rows[i].l);
    const thr = Math.max(atrNow * 1.5, c * 0.02);
    const pts = swings(rows, start, thr);
    const highs = pts.filter((p) => p.t === 'H' && !p.open);
    let contractions = [];
    let valid = false;
    let pivot = null;
    let stop = null;
    const notes = [];

    if (highs.length) {
      // Peel the base from left to right: H1 is the highest swing high, each contraction's low
      // is the lowest swing low after its high, and the next high is the highest swing high after
      // that low. A VCP (lower highs, higher lows) decomposes into progressively tighter legs;
      // small wiggles inside a leg are absorbed because only the extremes are kept.
      const h1 = highs.reduce((a, b) => (b.p > a.p ? b : a));
      const near = h1.p * 0.95;
      let hiPt = h1;
      while (hiPt && contractions.length < 6) {
        const lows = pts.filter((p) => p.t === 'L' && p.i > hiPt.i);
        if (!lows.length) break;
        const loPt = lows.reduce((a, b) => (b.p < a.p ? b : a));
        contractions.push({ hi: hiPt.p, hiI: hiPt.i, lo: loPt.p, loI: loPt.i, open: !!loPt.open, depth: ((hiPt.p - loPt.p) / hiPt.p) * 100 });
        const nextHighs = pts.filter((p) => p.t === 'H' && !p.open && p.i > loPt.i);
        if (!nextHighs.length) break;
        hiPt = nextHighs.reduce((a, b) => (b.p > a.p ? b : a));
        // Right-shoulder rule (vcp-screener): later highs must stay within 5% of H1.
        if (hiPt.p < near) break;
      }
      if (contractions.length) {
        const last = contractions[contractions.length - 1];
        pivot = last.hi;
        stop = last.lo;
        const t1 = contractions[0].depth;
        let tightening = true;
        for (let k = 1; k < contractions.length; k++) {
          if (contractions[k].depth > contractions[k - 1].depth * 0.75) tightening = false;
        }
        if (t1 < 10) notes.push('Koreksi pertama (T1) terlalu dangkal (< 10%).');
        if (t1 > 50) notes.push('Koreksi pertama (T1) terlalu dalam (> 50%).');
        if (!tightening) notes.push('Kontraksi tidak konsisten menyempit (tiap koreksi harus ≥ 25% lebih sempit dari sebelumnya).');
        if (contractions.length < 2) notes.push('Baru 1 kontraksi; VCP butuh minimal 2.');
        if (last.depth > 15) notes.push('Kontraksi terakhir masih lebar (> 15%): "wide and loose".');
        valid = contractions.length >= 2 && tightening && t1 >= 10 && t1 <= 50;
      }
    } else {
      notes.push('Belum ada swing high yang terkonfirmasi dalam 120 sesi terakhir.');
    }

    const avg50v = vols.slice(Math.max(0, n - 51), n - 1).reduce((a, b) => a + b, 0) / Math.min(50, n - 1);
    const avg10v = vols.slice(n - 10).reduce((a, b) => a + b, 0) / 10;
    const hasVol = avg50v > 0;
    const dryUp = hasVol ? avg10v / avg50v : null;
    const volToday = hasVol ? vols[i] / avg50v : null;

    let state;
    let tone = 'warn';
    if (!trendPass) {
      state = s50[i] !== null && s200[i] !== null && c < s50[i] && s50[i] < s200[i] ? 'Invalid — bukan Stage 2' : 'Belum lolos Trend Template';
      tone = 'bad';
    } else if (!valid || pivot === null) {
      state = 'Belum ada VCP valid';
    } else if (c < stop || (s50[i] !== null && c < s50[i])) {
      state = 'Damaged — pola rusak'; tone = 'bad';
    } else if (c > pivot * 1.10 || (s200[i] && c > s200[i] * 1.5)) {
      state = 'Overextended — sudah terlalu jauh';
    } else if (c > pivot) {
      if (volToday !== null && volToday >= 1.5) { state = 'Breakout'; tone = 'good'; } else state = 'Breakout, volume lemah';
    } else if (c >= pivot * 0.95) {
      state = 'Pre-breakout — dekat pivot'; tone = 'good';
    } else {
      state = 'Masih membentuk basis';
    }

    return {
      rows, s50, s150, s200, atr: atrNow, crit, trendScore, trendPass, rs,
      contractions, valid, pivot, stop, dryUp, volToday, state, tone, notes, hi52, lo52,
    };
  }

  function analysisHTML(a, symbol) {
    const last = a.rows[a.rows.length - 1];
    const critRows = a.crit.map((x) => (
      `<li class="${x.ok === null ? 'na' : x.ok ? 'ok' : 'no'}">${x.ok === null ? '–' : x.ok ? '✓' : '✗'} ${esc(x.label)}</li>`
    )).join('');
    const cons = a.contractions.length
      ? `<table class="mini"><thead><tr><th>#</th><th>High</th><th>Low</th><th>Dalam</th></tr></thead><tbody>${
        a.contractions.map((t, k) => `<tr><td>T${k + 1}${t.open ? '*' : ''}</td><td>${n2(t.hi)}</td><td>${n2(t.lo)}</td><td>${pct(t.depth)}</td></tr>`).join('')
      }</tbody></table>${a.contractions.some((t) => t.open) ? '<p class="small muted">* low belum terkonfirmasi.</p>' : ''}`
      : '<p class="muted small">Tidak ada kontraksi terdeteksi.</p>';
    const risk = a.pivot && a.stop ? ((a.pivot - a.stop) / a.pivot) * 100 : null;
    return `
      <div class="result-head">
        <div>${badge(a.state, a.tone)} <span class="muted small">${esc(symbol || 'Saham')} · ${esc(fmtDate(last.d))}</span></div>
        <div class="big">${n2(last.c)}<span class="muted small"> harga terakhir</span></div>
      </div>
      <div class="cols">
        <div>
          <h3>Trend Template ${a.trendScore}/100 ${a.trendPass ? badge('Stage 2', 'good') : badge('Tidak lolos', 'bad')}</h3>
          <ul class="checks small">${critRows}</ul>
          <p class="small muted">${a.rs ? `RS tertimbang vs indeks: ${a.rs.excess >= 0 ? '+' : ''}${pct(a.rs.excess)} → skor ~${a.rs.score}.` : 'RS tidak dinilai (unggah file indeks).'}</p>
        </div>
        <div>
          <h3>Kontraksi volatilitas</h3>
          ${cons}
          <dl class="kv small">
            <dt>Pivot</dt><dd>${n2(a.pivot)}</dd>
            <dt>Stop (low kontraksi terakhir)</dt><dd>${n2(a.stop)}</dd>
            <dt>Jarak risiko</dt><dd>${pct(risk)}</dd>
            <dt>ATR(14)</dt><dd>${n2(a.atr)}</dd>
            <dt>Volume 10 hari / 50 hari</dt><dd>${a.dryUp === null ? 'tidak ada data volume' : `${n2(a.dryUp)}× ${a.dryUp < 0.7 ? '(mengering ✓)' : ''}`}</dd>
            <dt>Volume hari ini / rata-rata 50</dt><dd>${a.volToday === null ? '—' : `${n2(a.volToday)}×`}</dd>
          </dl>
        </div>
      </div>
      ${a.notes.length ? `<ul class="small warn-list">${a.notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      <p class="small muted">Deteksi swing otomatis bisa meleset dari mata manusia. Cocokkan dengan grafik sebelum memakai pivot/stop.</p>`;
  }

  // --- Chart ---------------------------------------------------------------

  let lastChart = null;

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function drawChart(a) {
    lastChart = a;
    const canvas = $('#a-chart');
    const wrap = canvas.parentElement;
    const cssW = Math.max(280, wrap.clientWidth - 2);
    const cssH = Math.round(Math.min(380, Math.max(240, cssW * 0.55)));
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const colors = {
      text: cssVar('--muted'), grid: cssVar('--border'), up: cssVar('--up'), down: cssVar('--down'),
      ma50: cssVar('--ma50'), ma150: cssVar('--ma150'), ma200: cssVar('--ma200'),
      pivot: cssVar('--accent'), stop: cssVar('--danger'), vol: cssVar('--grid-vol'),
    };
    ctx.clearRect(0, 0, cssW, cssH);

    const N = a.rows.length;
    const show = Math.min(N, cssW < 500 ? 120 : 200);
    const from = N - show;
    const rows = a.rows.slice(from);
    const padL = 6;
    const padR = 56;
    const padT = 10;
    const volH = Math.round(cssH * 0.18);
    const padB = 22;
    const priceH = cssH - padT - padB - volH - 6;
    const plotW = cssW - padL - padR;
    const step = plotW / show;

    let lo = Infinity;
    let hi = -Infinity;
    rows.forEach((r) => { lo = Math.min(lo, r.l); hi = Math.max(hi, r.h); });
    [a.s50, a.s150, a.s200].forEach((s) => s.slice(from).forEach((v) => { if (v !== null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }));
    if (a.stop) lo = Math.min(lo, a.stop);
    if (a.pivot) hi = Math.max(hi, a.pivot);
    const pad = (hi - lo) * 0.05 || 1;
    lo -= pad; hi += pad;
    const y = (p) => padT + (hi - p) / (hi - lo) * priceH;
    const x = (k) => padL + k * step + step / 2;

    // Grid + price labels.
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = colors.text;
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const p = lo + (hi - lo) * (g / 4);
      const yy = Math.round(y(p)) + 0.5;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
      ctx.fillText(hi > 100 ? nf0.format(p) : nf2.format(p), padL + plotW + 4, yy + 4);
    }

    // Volume.
    const maxV = Math.max(...rows.map((r) => r.v), 1);
    const vBase = padT + priceH + 6 + volH;
    ctx.fillStyle = colors.vol;
    rows.forEach((r, k) => {
      const h = (r.v / maxV) * volH;
      ctx.fillRect(x(k) - Math.max(1, step * 0.35), vBase - h, Math.max(1, step * 0.7), h);
    });

    // Candles.
    rows.forEach((r, k) => {
      const col = r.c >= r.o ? colors.up : colors.down;
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      const xx = Math.round(x(k)) + 0.5;
      ctx.beginPath(); ctx.moveTo(xx, y(r.h)); ctx.lineTo(xx, y(r.l)); ctx.stroke();
      const bw = Math.max(1, step * 0.6);
      const top = y(Math.max(r.o, r.c));
      const bh = Math.max(1, Math.abs(y(r.o) - y(r.c)));
      ctx.fillRect(x(k) - bw / 2, top, bw, bh);
    });

    // Moving averages.
    const line = (series, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      series.slice(from).forEach((v, k) => {
        if (v === null) return;
        if (!started) { ctx.moveTo(x(k), y(v)); started = true; } else ctx.lineTo(x(k), y(v));
      });
      ctx.stroke();
    };
    line(a.s50, colors.ma50);
    line(a.s150, colors.ma150);
    line(a.s200, colors.ma200);

    // Pivot / stop.
    const hline = (p, color, label) => {
      if (!p) return;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(padL, y(p)); ctx.lineTo(padL + plotW, y(p)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillText(label, padL + 4, y(p) - 4);
    };
    hline(a.pivot, colors.pivot, `Pivot ${nf2.format(a.pivot || 0)}`);
    hline(a.stop, colors.stop, `Stop ${nf2.format(a.stop || 0)}`);

    // Date labels.
    ctx.fillStyle = colors.text;
    ctx.fillText(fmtDate(rows[0].d), padL, cssH - 6);
    const endLabel = fmtDate(rows[rows.length - 1].d);
    ctx.fillText(endLabel, padL + plotW - ctx.measureText(endLabel).width, cssH - 6);
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (lastChart && !$('#panel-analisis').hidden) drawChart(lastChart); }, 150);
  });
  $('#btn-theme')?.addEventListener('click', () => setTimeout(() => { if (lastChart) drawChart(lastChart); }, 0));
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (lastChart) drawChart(lastChart); });

  // --- Synthetic sample ----------------------------------------------------

  function sampleRows() {
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    // Piecewise path: long uptrend, then three tightening pullbacks.
    const legs = [[0, 1000], [230, 2050], [250, 1700], [268, 1990], [280, 1820], [292, 1975], [300, 1900], [310, 1960]];
    const closes = [];
    for (let k = 0; k < legs.length - 1; k++) {
      const [i0, p0] = legs[k];
      const [i1, p1] = legs[k + 1];
      for (let i = i0; i < i1; i++) closes.push(p0 + (p1 - p0) * ((i - i0) / (i1 - i0)));
    }
    const rows = [];
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - Math.round(closes.length * 1.45));
    let d = startDate;
    let prev = closes[0];
    closes.forEach((base, i) => {
      do { d = addDays(d, 1); } while (d.getDay() === 0 || d.getDay() === 6);
      const inBase = i >= 230;
      const noise = (rnd() - 0.5) * base * (inBase ? 0.01 : 0.02);
      const c = Math.round(base + noise);
      const o = Math.round(prev + (rnd() - 0.5) * base * 0.006);
      const h = Math.max(o, c) + Math.round(rnd() * base * 0.008);
      const l = Math.min(o, c) - Math.round(rnd() * base * 0.008);
      const volBase = inBase ? 6e6 - (i - 230) * 4e4 : 9e6;
      rows.push({ d: isoDate(d), o, h, l, c, v: Math.round(volBase * (0.6 + rnd() * 0.8)) });
      prev = c;
    });
    return rows;
  }

  // --- Wiring --------------------------------------------------------------

  function readFile(input) {
    const f = input.files && input.files[0];
    if (!f) return Promise.resolve(null);
    if (f.size > 20 * 1024 * 1024) return Promise.reject(new Error('File terlalu besar (maks. 20 MB).'));
    return f.text();
  }

  function showAnalysisError(msg) {
    const el = $('#a-error');
    el.textContent = msg;
    el.hidden = !msg;
  }

  function runAnalysis(rows, bench, symbol) {
    const a = analyze(rows, bench);
    lastAnalysis = { symbol, pivot: a.pivot, stop: a.stop, atr: a.atr, rsScore: a.rs ? a.rs.score : null };
    $('#a-output').hidden = false;
    $('#a-report').innerHTML = analysisHTML(a, symbol);
    requestAnimationFrame(() => drawChart(a));
    if (a.rs) setVal('c-l', a.rs.score);
  }

  $('#a-run').addEventListener('click', async () => {
    showAnalysisError('');
    try {
      const text = await readFile($('#a-file'));
      if (!text) { showAnalysisError('Pilih file CSV harga saham dulu, atau coba data contoh.'); return; }
      const rows = parseCSV(text);
      let bench = null;
      const btext = await readFile($('#a-bench'));
      if (btext) bench = parseCSV(btext);
      const symbol = $('#a-symbol').value.trim().toUpperCase()
        || ($('#a-file').files[0].name.replace(/\.[^.]+$/, '').toUpperCase().slice(0, 12));
      runAnalysis(rows, bench, symbol);
      if (rows.length < 252) showAnalysisError(`Hanya ${rows.length} baris: beberapa kriteria 52 minggu/MA200 tidak bisa dinilai.`);
    } catch (err) {
      $('#a-output').hidden = true;
      showAnalysisError(err.message || 'Gagal membaca file.');
    }
  });

  $('#a-sample').addEventListener('click', () => {
    showAnalysisError('');
    $('#a-symbol').value = 'CONTOH';
    runAnalysis(sampleRows(), null, 'CONTOH (sintetis)');
  });

  $('#a-to-sizer').addEventListener('click', () => {
    if (!lastAnalysis) return;
    const symbol = lastAnalysis.symbol.replace(/\s*\(.*\)$/, '');
    setVal('s-symbol', symbol);
    if (lastAnalysis.pivot) setVal('s-entry', Number(lastAnalysis.pivot.toFixed(2)));
    if (lastAnalysis.stop) setVal('s-stop', Number(lastAnalysis.stop.toFixed(2)));
    if (lastAnalysis.atr) setVal('s-atr', Number(lastAnalysis.atr.toFixed(2)));
    $('#s-method').value = 'fixed';
    updateMethodFields();
    history.replaceState(null, '', '#ukuran');
    showPanel('ukuran');
  });

  // --- CANSLIM ---------------------------------------------------------------

  $('#canslim-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const yn = (id) => ($(id).value === '' ? null : $(id).value === '1');
    let m = yn('#c-m');
    let mNote = '';
    if (m === null) {
      const p = todayPosture();
      if (p) { m = p.rec === 'NEW_ENTRY_ALLOWED'; mNote = ' (dari tab Pasar)'; }
    }
    const items = [
      ['C', 'EPS kuartal ≥ 25%', num('c-c') === null ? null : num('c-c') >= 25],
      ['A', 'EPS tahunan ≥ 25%', num('c-a') === null ? null : num('c-a') >= 25],
      ['N', 'Ada katalis baru', yn('#c-n')],
      ['S', 'Volume naik > volume turun', num('c-s') === null ? null : num('c-s') > 1],
      ['L', 'Pemimpin (RS ≥ 80)', num('c-l') === null ? null : num('c-l') >= 80],
      ['I', 'Institusi menambah', yn('#c-i')],
      ['M', `Pasar mendukung${mNote}`, m],
    ];
    const done = items.filter((x) => x[2] !== null);
    const pass = done.filter((x) => x[2]).length;
    const box = $('#canslim-result');
    const mFail = m === false;
    let verdict;
    let tone;
    if (done.length < 5) { verdict = 'Data belum cukup'; tone = 'warn'; } else if (mFail) { verdict = 'Pasar tidak mendukung'; tone = 'bad'; } else if (pass === done.length) { verdict = 'Semua kriteria terpenuhi'; tone = 'good'; } else if (pass >= done.length - 1) { verdict = 'Hampir lengkap'; tone = 'warn'; } else { verdict = 'Banyak yang belum terpenuhi'; tone = 'bad'; }
    box.innerHTML = `
      <div class="result-head"><div>${badge(verdict, tone)}</div><div class="big">${pass}/${done.length}<span class="muted small"> terpenuhi</span></div></div>
      <ul class="checks small">${items.map(([k, label, ok]) => `<li class="${ok === null ? 'na' : ok ? 'ok' : 'no'}"><b>${k}</b> ${ok === null ? '–' : ok ? '✓' : '✗'} ${esc(label)}</li>`).join('')}</ul>
      <p class="small muted">Tanpa M (pasar), O'Neil menyarankan tidak membeli meski 6 huruf lain lolos.</p>`;
    box.hidden = false;
  });

  // =========================================================================
  // 3. Position sizer
  // =========================================================================

  function updateMethodFields() {
    const m = $('#s-method').value;
    $$('#sizer-form [data-method]').forEach((el) => { el.hidden = !el.dataset.method.split(' ').includes(m); });
  }
  $('#s-method').addEventListener('change', updateMethodFields);

  function journalStats() {
    const closed = trades.filter(isClosed).map((t) => ({ ...t, pnl: tradePnl(t), r: tradeR(t) }));
    const wins = closed.filter((t) => t.pnl > 0);
    const losses = closed.filter((t) => t.pnl <= 0);
    const sum = (arr, f) => arr.reduce((a, t) => a + f(t), 0);
    const avgWin = wins.length ? sum(wins, (t) => t.pnl) / wins.length : null;
    const avgLoss = losses.length ? Math.abs(sum(losses, (t) => t.pnl) / losses.length) : null;
    const rs = closed.filter((t) => t.r !== null);
    return {
      n: closed.length,
      winRate: closed.length ? (wins.length / closed.length) * 100 : null,
      avgWin, avgLoss,
      payoff: avgWin !== null && avgLoss ? avgWin / avgLoss : null,
      total: sum(closed, (t) => t.pnl),
      expectancyR: rs.length ? sum(rs, (t) => t.r) / rs.length : null,
      profitFactor: losses.length && sum(losses, (t) => t.pnl) !== 0 ? sum(wins, (t) => t.pnl) / Math.abs(sum(losses, (t) => t.pnl)) : null,
      followed: closed.length ? (closed.filter((t) => t.followed !== false).length / closed.length) * 100 : null,
    };
  }

  $('#s-from-journal').addEventListener('click', () => {
    const s = journalStats();
    if (s.n < 1 || s.winRate === null || s.payoff === null) {
      alert('Jurnal belum punya cukup trade tertutup (perlu ada yang untung dan yang rugi).');
      return;
    }
    setVal('s-wr', Number(s.winRate.toFixed(1)));
    setVal('s-payoff', Number(s.payoff.toFixed(2)));
    if (s.n < 30) alert(`Baru ${s.n} trade tertutup. Statistik dari sampel sekecil ini belum bisa dipercaya untuk Kelly.`);
  });

  function sizeShares(budget, perShareRisk, entry, account, maxPosPct, lot) {
    const byRisk = perShareRisk > 0 ? Math.floor(budget / perShareRisk) : 0;
    const byPos = Math.floor((account * maxPosPct / 100) / entry);
    const raw = Math.min(byRisk, byPos);
    const shares = Math.floor(raw / lot) * lot;
    let binding = byRisk <= byPos ? 'risiko per trade' : 'batas ukuran posisi';
    if (shares === 0 && raw > 0) binding = `satuan lot (${lot} lembar)`;
    return { shares, byRisk, byPos, binding };
  }

  $('#sizer-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const m = $('#s-method').value;
    const account = num('s-account');
    const entry = num('s-entry');
    const lot = Math.max(1, Math.round(settings.lot || 100));
    const maxPos = num('s-maxpos') ?? 20;
    const box = $('#sizer-result');
    const fail = (msg) => { box.innerHTML = `<p class="error">${esc(msg)}</p>`; box.hidden = false; lastSizing = null; };
    if (!(account > 0) || !(entry > 0)) return fail('Isi modal akun dan harga entri dengan angka positif.');

    let stop = num('s-stop');
    let budget;
    let methodLabel;
    let extra = '';
    let scenarios = [];

    if (m === 'atr') {
      const atr = num('s-atr');
      const mult = num('s-atrmult') ?? 2;
      if (!(atr > 0)) return fail('Isi ATR dengan angka positif.');
      stop = entry - atr * mult;
      const riskPct = num('s-risk') ?? 1;
      budget = account * riskPct / 100;
      methodLabel = `ATR ${n2(mult)}× (stop ${n2(stop)})`;
      scenarios = [1.5, 2, 3].map((k) => {
        const st = entry - atr * k;
        const r = sizeShares(budget, entry - st, entry, account, maxPos, lot);
        return [`ATR ${n2(k)}×`, st, r.shares];
      });
    } else if (m === 'kelly') {
      const wr = num('s-wr');
      const payoff = num('s-payoff');
      if (wr === null || !(payoff > 0)) return fail('Isi win rate dan rasio untung/rugi.');
      const W = wr / 100;
      const kelly = W - (1 - W) / payoff;
      if (kelly <= 0) return fail(`Kelly = ${pct(kelly * 100)}: statistikmu belum menunjukkan keunggulan. Jangan menambah risiko berdasarkan data ini.`);
      const half = kelly / 2;
      budget = account * half;
      methodLabel = `Setengah Kelly (${pct(half * 100, 2)} modal)`;
      extra = `<p class="small">Kelly penuh ${pct(kelly * 100, 2)}; dipakai setengahnya karena Kelly penuh terlalu agresif dan sangat sensitif terhadap kesalahan estimasi win rate. ${half > 0.02 ? '<b>Catatan:</b> lebih dari 2% modal per trade tergolong agresif.' : ''}</p>`;
    } else {
      const riskPct = num('s-risk') ?? 1;
      budget = account * riskPct / 100;
      methodLabel = `Risiko tetap ${pct(riskPct, 2)}`;
    }
    if (m !== 'atr') {
      if (!(stop > 0)) return fail('Isi harga stop.');
      if (m === 'fixed') {
        scenarios = [0.5, 1, 1.5].map((rp2) => {
          const r = sizeShares(account * rp2 / 100, entry - stop, entry, account, maxPos, lot);
          return [`Risiko ${pct(rp2)}`, stop, r.shares];
        });
      }
    }
    if (!(stop < entry)) return fail('Stop harus di bawah harga entri (hanya posisi beli/long).');

    const perShare = entry - stop;
    const r = sizeShares(budget, perShare, entry, account, maxPos, lot);
    const value = r.shares * entry;
    const riskRp = r.shares * perShare;
    const fees = value * (settings.feeBuy / 100) + r.shares * stop * (settings.feeSell / 100);
    const symbol = $('#s-symbol').value.trim().toUpperCase();
    lastSizing = { symbol, entry, stop, shares: r.shares, riskRp: riskRp + fees, planned: budget };

    box.innerHTML = `
      <div class="result-head">
        <div>${badge(methodLabel, 'neutral')}</div>
        <div class="big">${nf0.format(r.shares)}<span class="muted small"> lembar (${nf0.format(r.shares / lot)} lot)</span></div>
      </div>
      ${r.shares === 0 ? '<p class="error">Ukuran 0: risiko per saham terlalu besar untuk anggaran ini, atau harga terlalu tinggi untuk 1 lot.</p>' : ''}
      <dl class="kv">
        <dt>Nilai posisi</dt><dd>${rp(value)} (${pct((value / account) * 100)} modal)</dd>
        <dt>Risiko jika kena stop</dt><dd>${rp(riskRp)} (${pct((riskRp / account) * 100, 2)} modal)</dd>
        <dt>+ perkiraan biaya</dt><dd>${rp(fees)} → total ${rp(riskRp + fees)}</dd>
        <dt>Jarak stop</dt><dd>${n2(perShare)} per lembar (${pct((perShare / entry) * 100)})</dd>
        <dt>Pembatas</dt><dd>${esc(r.binding)}</dd>
      </dl>
      ${extra}
      ${scenarios.length ? `<table class="mini"><thead><tr><th>Skenario</th><th>Stop</th><th>Lembar</th><th>Risiko</th></tr></thead><tbody>${
        scenarios.map(([lbl, st, sh]) => `<tr><td>${lbl}</td><td>${n2(st)}</td><td>${nf0.format(sh)}</td><td>${rp(sh * (entry - st))}</td></tr>`).join('')
      }</tbody></table>` : ''}
      <p class="small muted">Belum termasuk slippage dan gap harga melewati stop.</p>
      <div class="form-actions"><button type="button" id="s-to-gate">Lanjut ke Gerbang →</button></div>`;
    box.hidden = false;
    $('#s-to-gate').addEventListener('click', () => {
      setVal('g-symbol', lastSizing.symbol);
      setVal('g-planned', Math.round(lastSizing.planned));
      setVal('g-actual', Math.round(lastSizing.riskRp));
      history.replaceState(null, '', '#gerbang');
      showPanel('gerbang');
    });
  });

  // =========================================================================
  // 4. Circuit breaker + discipline gate
  // =========================================================================

  function isClosed(t) {
    return Boolean(t.exitDate) && Number(t.exit) > 0;
  }

  function tradePnl(t) {
    if (!isClosed(t)) return null;
    const gross = (t.exit - t.entry) * t.shares;
    const fees = t.entry * t.shares * (settings.feeBuy / 100) + t.exit * t.shares * (settings.feeSell / 100);
    return gross - fees;
  }

  function tradeR(t) {
    const risk = (t.entry - t.stop) * t.shares;
    if (!isClosed(t) || !(risk > 0)) return null;
    return tradePnl(t) / risk;
  }

  function startOfWeek(d) {
    const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const day = (r.getDay() + 6) % 7; // Monday = 0
    return addDays(r, -day);
  }

  function nextWeekday(d) {
    let r = addDays(d, 1);
    while (r.getDay() === 0 || r.getDay() === 6) r = addDays(r, 1);
    return r;
  }

  function circuitBreaker(now = new Date()) {
    const account = settings.account;
    const todayS = isoDate(now);
    const weekS = isoDate(startOfWeek(now));
    const monthS = todayS.slice(0, 8) + '01';
    const closed = trades.filter(isClosed).sort((a, b) => (a.exitDate < b.exitDate ? -1 : a.exitDate > b.exitDate ? 1 : (a.createdAt || 0) - (b.createdAt || 0)));
    const sumSince = (from) => closed.filter((t) => t.exitDate >= from && t.exitDate <= todayS).reduce((s, t) => s + tradePnl(t), 0);
    const daily = sumSince(todayS);
    const weekly = sumSince(weekS);
    const monthly = sumSince(monthS);

    let streak = 0;
    for (let k = closed.length - 1; k >= 0 && tradePnl(closed[k]) <= 0; k--) streak++;
    const lastLoss = streak > 0 ? closed[closed.length - 1] : null;

    const rules = [];
    if (!(account > 0)) {
      return { rec: 'REVIEW', rules: [{ text: 'Modal akun belum diatur di Setelan, batas rugi tidak bisa dihitung.' }], daily, weekly, monthly, streak };
    }
    const lim = (p) => -(account * p / 100);
    if (daily <= lim(settings.daily)) rules.push({ rec: 'HALTED', text: `Rugi hari ini ${rp(daily)} melewati batas ${pct(settings.daily)}.`, until: nextWeekday(now) });
    if (weekly <= lim(settings.weekly)) rules.push({ rec: 'HALTED', text: `Rugi minggu ini ${rp(weekly)} melewati batas ${pct(settings.weekly)}.`, until: addDays(startOfWeek(now), 7) });
    if (monthly <= lim(settings.monthly)) rules.push({ rec: 'HALTED', text: `Rugi bulan ini ${rp(monthly)} melewati batas ${pct(settings.monthly)}.`, until: new Date(now.getFullYear(), now.getMonth() + 1, 1) });
    if (lastLoss && streak >= settings.streak) {
      // Exit dates have no time, so the 24h cooldown runs through the day after the last loss.
      const until = addDays(parseISO(lastLoss.exitDate), 2);
      if (now < until) rules.push({ rec: 'COOLDOWN', text: `${streak} trade rugi beruntun. Jeda dulu dan tinjau penyebabnya.`, until });
    }
    const rec = rules.some((r) => r.rec === 'HALTED') ? 'HALTED' : rules.some((r) => r.rec === 'COOLDOWN') ? 'COOLDOWN' : 'ALLOWED';
    return { rec, rules, daily, weekly, monthly, streak, lastLoss };
  }

  const BREAKER_LABEL = {
    ALLOWED: ['Risiko baru diizinkan', 'good'],
    COOLDOWN: ['Jeda (cooldown)', 'warn'],
    HALTED: ['Berhenti entri baru', 'bad'],
    REVIEW: ['Perlu diatur', 'warn'],
  };

  function renderBreaker() {
    const b = circuitBreaker();
    const [label, tone] = BREAKER_LABEL[b.rec];
    const posture = todayPosture();
    const pLabel = posture ? REC_LABEL[posture.rec] : null;
    $('#breaker-status').innerHTML = `
      <div class="result-head"><div><b>Pemutus rugi</b> ${badge(label, tone)}</div>
        <div><b>Pasar hari ini</b> ${pLabel ? badge(pLabel[0], pLabel[1]) : badge('Belum dicek', 'warn')}</div></div>
      <dl class="kv small">
        <dt>P&amp;L hari ini</dt><dd>${rp(b.daily)}</dd>
        <dt>P&amp;L minggu ini</dt><dd>${rp(b.weekly)}</dd>
        <dt>P&amp;L bulan ini</dt><dd>${rp(b.monthly)}</dd>
        <dt>Rugi beruntun</dt><dd>${b.streak}</dd>
      </dl>
      ${b.rules.length ? `<ul class="small warn-list">${b.rules.map((r) => `<li>${esc(r.text)}${r.until ? ` Berlaku sampai ${esc(r.until.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'short' }))}.` : ''}</li>`).join('')}</ul>` : ''}`;
    return b;
  }

  $('#gate-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const b = renderBreaker();
    const posture = todayPosture();
    const blocks = [];
    const reviews = [];

    if (!$('#g-plan').checked) blocks.push('Entri belum tertulis di rencana.');
    if (!$('#g-stop').checked) blocks.push('Stop belum ditentukan sebelum order.');
    if (!$('#g-size').checked) blocks.push('Ukuran posisi tidak sesuai rencana.');
    const planned = num('g-planned');
    const actual = num('g-actual');
    if (planned === null || actual === null || planned < 0 || actual < 0) reviews.push('Risiko terencana dan aktual (Rp) harus diisi.');
    else if (actual > planned) blocks.push(`Risiko aktual ${rp(actual)} lebih besar dari rencana ${rp(planned)}.`);

    if (!posture) reviews.push('Postur pasar hari ini belum dicek (tab Pasar).');
    else if (posture.rec !== 'NEW_ENTRY_ALLOWED') blocks.push(`Postur pasar: ${REC_LABEL[posture.rec][0]}.`);

    if (b.rec === 'REVIEW') reviews.push('Modal akun belum diatur di Setelan.');
    else if (b.rec !== 'ALLOWED') blocks.push(`Pemutus rugi aktif: ${BREAKER_LABEL[b.rec][0]}.`);

    const lossToday = trades.some((t) => isClosed(t) && t.exitDate === today() && tradePnl(t) < 0);
    if (lossToday) blocks.push('Ada trade rugi yang ditutup hari ini — risiko balas dendam (revenge trade).');

    let decision;
    let tone;
    if (blocks.length) { decision = 'NO GO'; tone = 'bad'; } else if (reviews.length) { decision = 'PERLU DITINJAU'; tone = 'warn'; } else { decision = 'GO'; tone = 'good'; }
    const symbol = $('#g-symbol').value.trim().toUpperCase();
    const box = $('#gate-result');
    box.innerHTML = `
      <div class="result-head"><div>${badge(decision, tone)} <span class="muted small">${esc(symbol)}</span></div></div>
      ${blocks.length ? `<h3>Pemblokir</h3><ul class="small warn-list">${blocks.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${reviews.length ? `<h3>Perlu dilengkapi</h3><ul class="small">${reviews.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${decision === 'GO' ? `<p>Semua pemeriksaan lolos. Order tetap kamu yang pasang sendiri di broker.</p>
        <div class="form-actions"><button type="button" id="g-to-journal">Catat sebagai trade terbuka →</button></div>` : ''}`;
    box.hidden = false;
    $('#g-to-journal')?.addEventListener('click', () => {
      resetTradeForm();
      setVal('t-symbol', symbol);
      setVal('t-edate', today());
      if (lastSizing && lastSizing.symbol === symbol) {
        setVal('t-entry', lastSizing.entry);
        setVal('t-stop', Number(lastSizing.stop.toFixed(2)));
        setVal('t-shares', lastSizing.shares || '');
      }
      history.replaceState(null, '', '#jurnal');
      showPanel('jurnal');
      $('#t-entry').focus();
    });
  });

  // =========================================================================
  // 5. Journal
  // =========================================================================

  let editingTrade = null;

  function saveTrades() {
    writeJSON(KEYS.trades, trades);
  }

  function resetTradeForm() {
    $('#trade-form').reset();
    $('#t-followed').checked = true;
    $('#t-edate').value = today();
    editingTrade = null;
    $('#t-mode').textContent = '';
    $('#t-cancel').hidden = true;
    $('#t-save').textContent = 'Simpan trade';
  }

  $('#t-cancel').addEventListener('click', resetTradeForm);

  $('#trade-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const entry = num('t-entry');
    const stop = num('t-stop');
    const shares = num('t-shares');
    const exit = num('t-exit');
    const exitDate = $('#t-xdate').value || null;
    if (!(entry > 0) || !(stop > 0) || !(shares > 0)) { alert('Harga masuk, stop, dan jumlah saham harus angka positif.'); return; }
    if (stop >= entry) { alert('Stop awal harus di bawah harga masuk.'); return; }
    if ((exit !== null) !== Boolean(exitDate)) { alert('Isi tanggal dan harga keluar bersamaan, atau kosongkan keduanya untuk trade terbuka.'); return; }
    if (exitDate && exitDate < $('#t-edate').value) { alert('Tanggal keluar tidak boleh sebelum tanggal masuk.'); return; }
    const data = {
      symbol: $('#t-symbol').value.trim().toUpperCase(),
      setup: $('#t-setup').value,
      entryDate: $('#t-edate').value,
      entry, stop, shares: Math.round(shares),
      exitDate, exit,
      notes: $('#t-notes').value.trim(),
      followed: $('#t-followed').checked,
      updatedAt: Date.now(),
    };
    if (editingTrade) {
      const t = trades.find((x) => x.id === editingTrade);
      if (t) Object.assign(t, data);
    } else {
      trades.push({ id: uid(), createdAt: Date.now(), ...data });
    }
    saveTrades();
    resetTradeForm();
    renderJournal();
  });

  function statTile(label, value, sub = '') {
    return `<div class="stat"><span class="muted small">${label}</span><b>${value}</b>${sub ? `<span class="muted small">${sub}</span>` : ''}</div>`;
  }

  function renderJournal() {
    const s = journalStats();
    const open = trades.filter((t) => !isClosed(t));
    const heat = open.reduce((a, t) => a + Math.max(0, (t.entry - t.stop) * t.shares), 0);
    $('#journal-stats').innerHTML = [
      statTile('Trade tertutup', nf0.format(s.n), `${open.length} terbuka`),
      statTile('Win rate', pct(s.winRate)),
      statTile('Ekspektansi', s.expectancyR === null ? '—' : `${n2(s.expectancyR)} R`, 'per trade'),
      statTile('Total P&amp;L', rp(s.total)),
      statTile('Profit factor', n2(s.profitFactor)),
      statTile('Ikuti rencana', pct(s.followed, 0)),
      statTile('Risiko terbuka', rp(heat), settings.account > 0 ? `${pct((heat / settings.account) * 100)} modal` : 'atur modal'),
    ].join('');

    const filter = $('#t-filter').value;
    const list = trades
      .filter((t) => (filter === 'open' ? !isClosed(t) : filter === 'closed' ? isClosed(t) : true))
      .sort((a, b) => ((b.exitDate || b.entryDate) > (a.exitDate || a.entryDate) ? 1 : -1));
    const table = $('#trade-table');
    $('#t-empty').hidden = list.length > 0;
    if (!list.length) { table.innerHTML = ''; return; }
    table.innerHTML = `<thead><tr><th>Saham</th><th>Masuk</th><th>Keluar</th><th class="num">Lembar</th><th class="num">P&amp;L</th><th class="num">R</th><th></th></tr></thead><tbody>${
      list.map((t) => {
        const pnl = tradePnl(t);
        const r = tradeR(t);
        const cls = pnl === null ? '' : pnl > 0 ? 'pos' : 'neg';
        return `<tr>
          <td><b>${esc(t.symbol)}</b><br><span class="muted small">${esc(t.setup)}${t.followed === false ? ' · ⚠ langgar rencana' : ''}</span>${t.notes ? `<br><span class="small note-text">${esc(t.notes)}</span>` : ''}</td>
          <td>${n2(t.entry)}<br><span class="muted small">${esc(fmtDate(t.entryDate))}</span></td>
          <td>${isClosed(t) ? `${n2(t.exit)}<br><span class="muted small">${esc(fmtDate(t.exitDate))}</span>` : `${badge('Terbuka', 'neutral')}<br><span class="muted small">stop ${n2(t.stop)}</span>`}</td>
          <td class="num">${nf0.format(t.shares)}</td>
          <td class="num ${cls}">${pnl === null ? '—' : rp(pnl)}</td>
          <td class="num ${cls}">${r === null ? '—' : n2(r)}</td>
          <td><div class="row-actions"><button type="button" class="ghost" data-edit="${esc(t.id)}">Ubah</button><button type="button" class="ghost danger" data-del="${esc(t.id)}">Hapus</button></div></td>
        </tr>`;
      }).join('')}</tbody>`;
  }

  $('#trade-table').addEventListener('click', (e) => {
    const edit = e.target.closest('[data-edit]');
    const del = e.target.closest('[data-del]');
    if (edit) {
      const t = trades.find((x) => x.id === edit.dataset.edit);
      if (!t) return;
      editingTrade = t.id;
      setVal('t-symbol', t.symbol);
      $('#t-setup').value = t.setup;
      setVal('t-edate', t.entryDate);
      setVal('t-entry', t.entry);
      setVal('t-stop', t.stop);
      setVal('t-shares', t.shares);
      setVal('t-xdate', t.exitDate);
      setVal('t-exit', t.exit);
      $('#t-notes').value = t.notes || '';
      $('#t-followed').checked = t.followed !== false;
      $('#t-mode').textContent = `Mengubah ${t.symbol}`;
      $('#t-cancel').hidden = false;
      $('#t-save').textContent = 'Simpan perubahan';
      $('#trade-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (del) {
      const t = trades.find((x) => x.id === del.dataset.del);
      if (!t || !confirm(`Hapus trade ${t.symbol} (${fmtDate(t.entryDate)})?`)) return;
      trades = trades.filter((x) => x.id !== t.id);
      if (editingTrade === t.id) resetTradeForm();
      saveTrades();
      renderJournal();
    }
  });

  $('#t-filter').addEventListener('change', renderJournal);

  $('#t-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), trades, market: marketLog }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `jurnal-trading-${today()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  function validTrade(t) {
    return t && typeof t.id === 'string' && typeof t.symbol === 'string' && Number(t.entry) > 0
      && Number(t.stop) > 0 && Number(t.shares) > 0 && typeof t.entryDate === 'string';
  }

  $('#t-import').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const incoming = (Array.isArray(data) ? data : data.trades || []).filter(validTrade).map((t) => ({
        ...t, entry: Number(t.entry), stop: Number(t.stop), shares: Number(t.shares),
        exit: t.exit === null || t.exit === undefined ? null : Number(t.exit),
      }));
      const ids = new Set(trades.map((t) => t.id));
      const added = incoming.filter((t) => !ids.has(t.id));
      trades.push(...added);
      if (data.market && typeof data.market === 'object' && !Array.isArray(data.market)) {
        Object.entries(data.market).forEach(([d, v]) => { if (!marketLog[d] && v?.result?.rec) marketLog[d] = v; });
        writeJSON(KEYS.market, marketLog);
        renderMarketHistory();
      }
      saveTrades();
      renderJournal();
      alert(`${added.length} trade diimpor${incoming.length - added.length ? `, ${incoming.length - added.length} dilewati karena sudah ada` : ''}.`);
    } catch {
      alert('File tidak bisa dibaca sebagai JSON jurnal.');
    }
  });

  // =========================================================================
  // Settings
  // =========================================================================

  function fillSettings() {
    setVal('st-account', settings.account);
    setVal('st-lot', settings.lot);
    setVal('st-feebuy', settings.feeBuy);
    setVal('st-feesell', settings.feeSell);
    setVal('st-daily', settings.daily);
    setVal('st-weekly', settings.weekly);
    setVal('st-monthly', settings.monthly);
    setVal('st-streak', settings.streak);
    if (settings.account > 0 && !$('#s-account').value) setVal('s-account', settings.account);
  }

  $('#settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const pick = (id, def) => { const v = num(id); return v === null || v < 0 ? def : v; };
    settings = {
      account: num('st-account') > 0 ? num('st-account') : null,
      lot: Math.max(1, Math.round(pick('st-lot', 100))),
      feeBuy: pick('st-feebuy', DEFAULT_SETTINGS.feeBuy),
      feeSell: pick('st-feesell', DEFAULT_SETTINGS.feeSell),
      daily: pick('st-daily', DEFAULT_SETTINGS.daily),
      weekly: pick('st-weekly', DEFAULT_SETTINGS.weekly),
      monthly: pick('st-monthly', DEFAULT_SETTINGS.monthly),
      streak: Math.max(1, Math.round(pick('st-streak', DEFAULT_SETTINGS.streak))),
    };
    writeJSON(KEYS.settings, settings);
    if (settings.account) setVal('s-account', settings.account);
    alert('Setelan disimpan.');
  });

  $('#st-wipe').addEventListener('click', () => {
    if (!confirm('Hapus semua trade, riwayat cek pasar, dan setelan trading di browser ini? Tindakan ini tidak bisa dibatalkan. Ekspor dulu jika perlu.')) return;
    Object.values(KEYS).forEach((k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } });
    settings = { ...DEFAULT_SETTINGS };
    trades = [];
    marketLog = {};
    fillSettings();
    resetTradeForm();
    renderJournal();
    renderMarketHistory();
    $('#market-result').hidden = true;
  });

  // --- Init ----------------------------------------------------------------

  fillSettings();
  updateMethodFields();
  const todayEntry = marketLog[today()];
  if (todayEntry) {
    fillMarketForm(todayEntry.inputs);
    $('#market-result').innerHTML = postureHTML(todayEntry.result, today());
    $('#market-result').hidden = false;
  }
  renderMarketHistory();
  $('#t-edate').value = today();
  let initial = location.hash.slice(1);
  if (!initial) { try { initial = localStorage.getItem(KEYS.tab) || 'pasar'; } catch { initial = 'pasar'; } }
  showPanel(initial);
})();
