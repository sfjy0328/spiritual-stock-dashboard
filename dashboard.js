/* Native SVG, no build or network dependency. Works over file://. */
'use strict';
const colors = ['#6750a4', '#007f86', '#bd4d27', '#306eb4', '#8c596e', '#64702a'];
const WEEK_JA = ['日', '月', '火', '水', '木', '金', '土'];
const DIR_JA = {up: '上昇', down: '下落', flat: '方向なし（横ばい）', mixed: '混合・不定'};
const STATUS_JA = {current: '予想期間中', expired: '予想期間終了', unavailable: '表示できません'};

/* Internal chart values stay base-100; presentation converts to percent change. */
function toPct(internal) {
  if (internal === null || internal === undefined) return null;
  return internal - 100;
}
function fmtPct(pct, digits) {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return '—';
  if (pct === 0) return '0%';
  const fixed = pct.toFixed(digits === undefined ? 2 : digits).replace(/\.?0+$/, '');
  return (pct > 0 ? '+' : '') + fixed + '%';
}
function fmtMove(rate) {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '—';
  return fmtPct(rate * 100);
}

function weekdayJa(isoDate) {
  return WEEK_JA[new Date(isoDate + 'T12:00:00Z').getUTCDay()];
}
function formatDateJa(isoDate) {
  if (!isoDate) return '—';
  const [y, m, d] = isoDate.split('-').map(Number);
  return `${m}/${d}(${weekdayJa(isoDate)})`;
}
function formatDateTimeJa(at, timezone) {
  try {
    const parts = new Intl.DateTimeFormat('ja-JP', {timeZone: timezone, month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false}).formatToParts(new Date(at));
    const get = t => (parts.find(p => p.type === t) || {}).value || '';
    return `${get('month')}/${get('day')}(${get('weekday')}) ${get('hour')}:${get('minute')}`;
  } catch (e) {
    return at;
  }
}
function tzShort(timezone) {
  const m = {'Asia/Tokyo': '日本時間', 'America/New_York': 'NY時間', 'America/Los_Angeles': 'LA時間', 'Europe/London': 'ロンドン時間'}[timezone];
  if (m) return m;
  const tail = (timezone || '').split('/').pop();
  return tail ? tail + '時間' : '';
}

const PLANETS = [['Mercury', '水星'], ['Venus', '金星'], ['Mars', '火星'], ['Jupiter', '木星'], ['Saturn', '土星'], ['Uranus', '天王星'], ['Neptune', '海王星'], ['Pluto', '冥王星'], ['Sun', '太陽'], ['Moon', '月']];
const ASPECTS = [['retrograde station', '逆行開始'], ['direct station', '順行開始'], ['opposite', '☍'], ['opposition', '☍'], ['trine', '△'], ['square', '□'], ['sextile', '⚹'], ['conjunction', '合'], ['ingress', '入宮'], ['New Moon', '新月'], ['Full Moon', '満月'], ['solar eclipse', '日食'], ['lunar eclipse', '月食']];
function translateEventName(text) {
  if (!text) return '';
  let out = String(text);
  PLANETS.forEach(([en, ja]) => { out = out.replace(new RegExp(en, 'g'), ja); });
  ASPECTS.forEach(([en, ja]) => { out = out.replace(new RegExp(en, 'gi'), ja); });
  return out;
}
function displayOf(t) { return t.display_name || t.name; }

function findRun(data, runId) {
  if (runId === 'tracking') return {run_id: 'tracking', targets: (data.subjects || []).map(s => s.latest)};
  return runId === 'current' ? data.current : data.runs.find(r => r.run_id === runId);
}
function availableTargets(data, runId, kind, status) {
  return (findRun(data, runId)?.targets || [])
    .filter(t => t.target_type === kind && (status === 'all' || t.status === status));
}
function selectedTargets(data, options) {
  const rows = availableTargets(data, options.run, options.kind, options.status)
    .filter(t => options.targets.includes(t.target_id));
  return options.mode === 'single' ? rows.slice(0, 1) : rows;
}
/* Related theme overlay candidates: same-run themes linked from frozen slice membership. */
function relatedThemes(data, runId, stockRow) {
  const ids = stockRow?.related_themes || [];
  if (!ids.length) return [];
  const run = findRun(data, runId);
  if (!run) return [];
  return ids.map(id => run.targets.find(t => t.target_type === 'theme' && t.target_id === id)).filter(Boolean);
}
/* Session axis: union of trading sessions only, so weekends/holidays take no width. */
function sessionAxis(rows) {
  const set = new Set();
  rows.forEach(t => {
    (t.sessions || []).forEach(s => set.add(s));
    if (!t.sessions) [...(t.official || []), ...(t.actual || [])].forEach(p => { if (p.date) set.add(p.date); });
  });
  return [...set].sort();
}
/* Gray visual connectors across sparse-path gaps. Presentation only: no forecast implied.
   Colored lines are the Path GPT actually forecast; gray lines only join known
   Forecast endpoints / formal 1/5/20 prediction points (●) across gaps where no
   Path was issued:
   - segment → blank gap → next segment (anchor of the next segment); formal ●
     points sitting inside that gap join the chain instead of floating
   - last segment → blank gap → every remaining formal point, chained up to ●20
   - no segments at all: the formal ●1/5/20 points still form a gray chain
   A formal point inside a colored segment never gets a duplicate gray line.
   A segment's signal starts at start_session; its anchor_session is the session
   just before (index start_index - 1). The connector ends at the anchor session
   so it never overlaps the colored signal line that runs anchor -> end. The ●'s
   date/value are never altered; connectors stay pure Dashboard presentation
   (no proposal/path/prediction/result/scoring data). */
function gapConnectors(row) {
  const segs = [...(row.segments || [])].sort((a, b) => a.start_index - b.start_index);
  const officials = (row.official || []).filter(p => p.value != null && p.kind === 'official')
    .sort((a, b) => a.date < b.date ? -1 : 1);
  const out = [];
  for (let i = 1; i < segs.length; i++) {
    const prev = segs[i - 1], next = segs[i];
    if (prev.end_index == null || next.start_index == null) continue;
    if (next.start_index > prev.end_index + 1) {
      const anchor = next.anchor_session || (next.points[0] || {}).date || next.start_session;
      let cur = {point: prev.points[prev.points.length - 1], session: prev.end_session};
      officials.filter(p => p.date > prev.end_session && p.date < anchor).forEach(p => {
        out.push({from: cur.point, to: p, fromSession: cur.session, toSession: p.date});
        cur = {point: p, session: p.date};
      });
      out.push({from: cur.point, to: next.points[0], fromSession: cur.session, toSession: anchor});
    }
  }
  const last = segs[segs.length - 1];
  if (last && last.end_session != null && Array.isArray(last.points) && last.points.length) {
    let cur = {point: last.points[last.points.length - 1], session: last.end_session};
    officials.filter(p => p.date > last.end_session).forEach(p => {
      out.push({from: cur.point, to: p, fromSession: cur.session, toSession: p.date});
      cur = {point: p, session: p.date};
    });
  } else if (!segs.length) {
    for (let i = 1; i < officials.length; i++) {
      out.push({from: officials[i - 1], to: officials[i],
        fromSession: officials[i - 1].date, toSession: officials[i].date});
    }
  }
  return out;
}
function verdictOf(r) {
  if (!r || r.status !== 'scored') return '… 未評価';
  if (r.sign_agreement === true) return '○ 的中';
  if (r.sign_agreement === false) return '× 不一致';
  return '－ 方向評価なし';
}
/* Latest canonical result for one path item: a scored record wins, else the newest. */
function resultFor(results, itemKey) {
  const rows = (results || []).filter(r => r.item_key === itemKey);
  if (!rows.length) return null;
  const byTime = [...rows].sort((a, b) => String(a.available_at) < String(b.available_at) ? 1 : -1);
  return byTime.find(r => r.status === 'scored') || byTime[0];
}
function formatResult(r) {
  if (!r || r.status !== 'scored') return '… 未評価';
  const move = (r.actual_move === null || r.actual_move === undefined) ? '実績 —' : `実績 ${fmtMove(r.actual_move)}`;
  if (r.sign_agreement === true) return `○ 的中（${move}）`;
  if (r.sign_agreement === false) return `× 不一致（${move}）`;
  return `－ 方向評価なし（${move}）`;
}
/* UI event identity is target-scoped so multi-target views never cross-highlight. */
function eventKey(t, e) { return `${t.target_type}|${t.target_id}|${e.event_at}|${e.start_session}`; }
/* Default event view shows formal path events only; reference facts need opt-in. */
function isReferenceEvent(e) { return e.source !== 'path_event'; }
function visibleEvents(events, showRef) { return (events || []).filter(e => !isReferenceEvent(e) || showRef); }
/* Percent ticks always include 0%; the zero line is drawn prominently as the baseline. */
function pctTicks(ymin, ymax) {
  const span = Math.max(ymax - ymin, 0.5);
  const steps = [0.25, 0.5, 1, 2, 5, 10, 20];
  const step = steps.find(s => span / s <= 5) || 20;
  const ticks = [];
  for (let v = Math.floor(ymin / step) * step; v <= Math.ceil(ymax / step) * step + 1e-9; v += step) {
    ticks.push(Math.round(v * 100) / 100);
  }
  if (!ticks.some(v => v === 0) && ymin <= 0 && ymax >= 0) ticks.push(0);
  return ticks.sort((a, b) => a - b);
}
function officialTitle(name, p) {
  const dir = DIR_JA[p.direction] || p.direction || '—';
  const pct = v => (v === null || v === undefined) ? '—' : fmtMove(v);
  const probs = p.direction_probability ? `上昇${pct(p.direction_probability.up)}・横ばい${pct(p.direction_probability.flat)}・下落${pct(p.direction_probability.down)}` : '';
  return `● ${p.horizon}営業日正式予想 ${pct(p.expected_move)}｜${name}｜${formatDateJa(p.date)}｜方向: ${dir}${probs ? '｜' + probs : ''}｜直接予測（途中の強弱予想とは別推定）`;
}
function markerTitle(m) {
  if (m.kind === 'decision') {
    // 重要日 (decision_points): 方向・強度の捏造なし。節目ラベルのみ表示する。
    const dir = m.direction ? (DIR_JA[m.direction] || m.direction) : '方向指定なし（節目のみ）';
    const at = m.session || m.date;
    return `${formatDateJa(m.date)} ● ${translateEventName(m.label || '')}｜方向: ${dir}${at && at !== m.date ? '｜市場影響 ' + formatDateJa(at) : ''}｜${translateEventName(m.rationale || '')}`;
  }
  const isRef = m.source && m.source !== 'path_event';
  const dir = isRef ? '—' : (m.direction ? (DIR_JA[m.direction] || m.direction) : '方向指定なし');
  const strength = isRef ? '—' : `${Math.round((m.strength || 0) * 100)}/100`;
  const when = m.event_at ? `発生 ${formatDateTimeJa(m.event_at, m.timezone)} ${tzShort(m.timezone)}（${m.event_at}）` : formatDateJa(m.date);
  const impact = (m.start_session || m.session) ? `｜市場影響 ${formatDateJa(m.start_session || m.session)}${m.end_session && m.end_session !== (m.start_session || m.session) ? '→' + formatDateJa(m.end_session) : ''}` : '';
  return `${when}${impact}｜方向: ${dir}｜強度 ${strength}${isRef ? '｜参考情報' : ''}｜${translateEventName(m.rationale || m.label || '')}`;
}
/* Axis meaning differs even on the same % axis: return vs benchmark-excess. */
function xAxisNote(rows) {
  const cals = [...new Set((rows || []).map(t => t.calendar).filter(Boolean))];
  if (cals.length <= 1) return '横軸＝営業日（その市場の休場日は省略）';
  return '横軸＝選択対象の営業日を日付順に統合。市場ごとの休場日は、その系列に点がありません。';
}
function axisNote(rows, overlay) {
  const lines = [];
  if (new Set([...rows, ...(overlay || [])].map(t => t.entry_session).filter(Boolean)).size > 1) lines.push('対象ごとに基準日が異なります。各対象の基準からの変化率です');
  if (rows.some(t => (t.basis || t.target_type) !== 'benchmark_excess') || !rows.length) lines.push('銘柄（Stock）の縦軸＝基準日からの騰落率（％）');
  if (rows.some(t => (t.basis || t.target_type) === 'benchmark_excess')) lines.push('テーマ（Theme）の縦軸＝比較指標に対する累積超過率（％）');
  if ((overlay || []).length) lines.push('関連テーマは参考表示（超過率）。同じ％軸でも意味が異なります。');
  else if (lines.length > 1) lines.push('同じ％軸でも意味が異なります。');
  return lines.join('。') + (lines.length ? '。0%が基準。' : '0%が基準。') + xAxisNote(rows);
}
/* Target-scoped chart session for an event row. Presentation only: never invents a point. */
function sessionForEvent(e) { return (e && (e.start_session || e.impact_session || e.session)) || ''; }
function chartGroups(rows, options) {
  const prediction = [], actual = [];
  rows.forEach((t, i) => {
    const color = colors[i % colors.length];
    const base = displayOf(t);
    if (!t.official) return;
    prediction.push({name: `${base}｜正式予想（1・5・20営業日）`, kind: 'official', color, points: t.official, pointsOnly: true});
    t.segments.forEach(s => prediction.push({name: `${base}｜期間予想（表示用補間）`, kind: 'segment', color, points: s.points, dashed: true, segment: s}));
    actual.push({name: `${base}｜実績`, kind: 'actual', color, points: t.actual});
    if (options.raw && t.target_type === 'theme') actual.push({name: `${base}｜構成銘柄バスケット`, kind: 'raw', color, points: t.raw_basket, dashed: true});
    if (options.benchmark && t.target_type === 'theme') actual.push({name: `${base}｜比較指標`, kind: 'benchmark', color, points: t.benchmark, dotted: true});
  });
  /* Reference overlay: related Theme official forecast + path only (no actual).
     Stock shows price return; Theme shows benchmark-excess: same % axis, distinct meaning. */
  (options.overlay || []).forEach((t, j) => {
    if (!t || !t.official) return;
    const color = colors[(rows.length + j) % colors.length];
    const base = displayOf(t) + '［参考・超過率］';
    prediction.push({name: `${base}｜正式予想（1・5・20営業日）`, kind: 'official', color, points: t.official, pointsOnly: true, overlay: true});
    (t.segments || []).forEach(s => prediction.push({name: `${base}｜期間予想（表示用補間）`, kind: 'segment', color, points: s.points, dashed: true, segment: s, overlay: true}));
  });
  return {upper: options.mode === 'single' ? [...prediction, ...actual] : prediction,
          lower: options.mode === 'multiple' ? actual : []};
}
if (typeof module !== 'undefined') module.exports = {availableTargets, selectedTargets, relatedThemes, chartGroups, sessionAxis, gapConnectors, verdictOf, resultFor, formatResult, eventKey, isReferenceEvent, visibleEvents, pctTicks, officialTitle, markerTitle, axisNote, xAxisNote, sessionForEvent, translateEventName, formatDateJa, formatDateTimeJa, weekdayJa, toPct, fmtPct, fmtMove, DIR_JA, STATUS_JA};
if (typeof document !== 'undefined') {
  const $ = id => document.getElementById(id);
  const data = JSON.parse($('chart-data').textContent);
  const ns = 'http://www.w3.org/2000/svg';
  let savedTargets = [];
  let snapshotKey = '';
  let comparisons = [];

  function svgNode(tag, attrs = {}, text = '') {
    const node = document.createElementNS(ns, tag);
    Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
    if (text) node.textContent = text;
    return node;
  }
  function option(value, text, title = '') {const node = document.createElement('option'); node.value = value; node.textContent = text; if (title) node.title = title; return node;}
  function checkedValues(rootId) {return [...document.querySelectorAll(`#${rootId} input:checked`)].map(o => o.value);}
  function settings() {
    const base = Object.fromEntries(['up','down','turn','spiritual','raw','benchmark'].map(k => [k, $(k).checked]));
    // 期間終了マーカーは方向シグナルではないため、up/down のいずれかが有効なら表示する。
    base.segment_end = base.up || base.down;
    // 構造化された重要日 (decision_points) は省略禁止のため常に表示する。
    base.decision = true;
    return {run: $('run').value, kind: $('kind').value, status: $('status').value, mode: $('mode').value,
      targets: checkedValues('targets'), related: checkedValues('related'),
      ...base,
      refEvents: $('refEvents').checked, zoom: Number($('zoom').value)};
  }
  function statusJa(t) { return STATUS_JA[t.status] || t.status; }
  function fillTargets() {
    if (data.runs.some(r => r.run_id === $('run').value)) $('audit-run').value = $('run').value;
    const old = checkedValues('targets').length ? checkedValues('targets') : savedTargets;
    savedTargets = [];
    const single = $('mode').value === 'multiple' ? false : true;
    const list = availableTargets(data, $('run').value, $('kind').value, $('status').value);
    $('targets').replaceChildren(...list.map(t => {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = single ? 'radio' : 'checkbox';
      if (single) box.name = 'target-single';
      box.value = t.target_id;
      box.checked = old.includes(t.target_id);
      label.append(box, document.createTextNode(`${displayOf(t)}［${statusJa(t)}］`));
      label.title = `${t.name} · ${t.status} · 基準 ${t.issued_at}`;
      return label;
    }));
    const boxes = [...document.querySelectorAll('#targets input')];
    if (boxes.length && !boxes.some(b => b.checked)) boxes[0].checked = true;
    render();
  }
  function fillRelated(stockRow) {
    const keep = new Set(checkedValues('related'));
    const box = $('related-box');
    if (!stockRow || !$('kind') || $('mode').value !== 'single' || $('kind').value !== 'stock') {
      box.hidden = true; $('related').replaceChildren(); return;
    }
    const themes = relatedThemes(data, $('run').value, stockRow).filter(t => t.official);
    if (!themes.length) { box.hidden = true; $('related').replaceChildren(); return; }
    box.hidden = false;
    $('related-note').textContent = `${displayOf(stockRow)} に関連するテーマ（参考・超過率・正式予想のみ重ねます）`;
    $('related').replaceChildren(...themes.map(t => {
      const label = document.createElement('label');
      const cell = document.createElement('input');
      cell.type = 'checkbox'; cell.value = t.target_id;
      cell.checked = keep.has(t.target_id);
      label.append(cell, document.createTextNode(`${displayOf(t)}（参考・超過率）`));
      label.title = 'Stockは騰落率・Themeは超過率。同じ％軸でも意味が異なります。';
      return label;
    }));
  }
  function plot(id, series, priceMarkers, laneMarkers, axis, limits, gaps) {
    const [yminI, ymaxI] = limits;
    const ymin = yminI - 100, ymax = ymaxI - 100;
    const pos = new Map(axis.map((d, i) => [d, i]));
    const n = Math.max(axis.length, 1);
    const zoom = Number($('zoom').value), width = 970 * zoom, span = width - 100;
    const x = date => 62 + (axis.length < 2 ? span / 2 : (pos.get(date) ?? -1) / (n - 1) * span);
    const y = value => 285 - (toPct(value) - ymin) / (ymax - ymin) * 240;
    const H = laneMarkers.length ? 392 : 335;
    const svg = svgNode('svg', {viewBox: `0 0 ${width} ${H}`, role: 'img', 'aria-label': id === 'prediction' ? $('prediction-title').textContent : '実績比較'});
    svg.append(svgNode('title', {}, '点にフォーカスまたはマウスを置くと日付と値を表示。横軸は営業日のみ。縦軸は基準からの変化率（％）。詳細数値は下の表にも記録。'));
    pctTicks(ymin, ymax).forEach(value => {
      const isZero = value === 0;
      svg.append(svgNode('line', {x1: 62, x2: width - 38, y1: y(value + 100), y2: y(value + 100),
        stroke: isZero ? '#4a4a68' : '#e2e6ed', 'stroke-width': isZero ? 2.2 : 1}));
      svg.append(svgNode('text', {x: 54, y: y(value + 100) + 4, 'text-anchor': 'end',
        fill: isZero ? '#22223a' : '#657183', 'font-size': isZero ? 12 : 11,
        'font-weight': isZero ? 'bold' : 'normal'}, fmtPct(value)));
    });
    if (ymin <= 0 && ymax >= 0) {
      svg.append(svgNode('text', {x: width - 42, y: y(100) - 6, 'text-anchor': 'end', fill: '#22223a', 'font-size': 11, 'font-weight': 'bold'}, '基準 0%'));
    }
    if (zoom > 1) svg.style.width = `${970 * zoom}px`;
    const stride = zoom > 1 ? 1 : Math.max(1, Math.ceil(n / 9));
    axis.forEach((d, i) => {
      if (i % stride) return;
      svg.append(svgNode('text', {x: x(d), y: 306, 'text-anchor': 'middle', fill: '#263444', 'font-size': 12}, formatDateJa(d)));
      svg.append(svgNode('line', {x1: x(d), x2: x(d), y1: 288, y2: 296, stroke: '#b8c3d0'}));
    });
    if (axis.length > 1) svg.append(svgNode('text', {x: width - 38, y: 322, 'text-anchor': 'end', fill: '#657183', 'font-size': 11}, '横軸＝営業日（休場日なし）'));
    const clip = svgNode('clipPath', {id: `${id}-clip`});
    clip.append(svgNode('rect', {x: 56, y: 40, width: span + 12, height: 250}));
    const defs = svgNode('defs'); defs.append(clip); svg.append(defs);
    const ink = svgNode('g', {'clip-path': `url(#${id}-clip)`}); svg.append(ink);
    // Gray gap connectors: visual only, never a forecast.
    gaps.forEach(g => {
      if (pos.get(g.fromSession) == null || pos.get(g.toSession) == null) return;
      const attrs = {x1: x(g.fromSession), x2: x(g.toSession), y1: y(g.from.value), y2: y(g.to.value), stroke: '#9aa3b2', 'stroke-width': 1.6, 'stroke-dasharray': '3 4'};
      const line = svgNode('line', attrs);
      const note = g.to && g.to.kind === 'official'
        ? `予想なし区間（表示のみ接続・方向予想なし）: ${formatDateJa(g.fromSession)} → ${formatDateJa(g.toSession)} の正式予想点まで。横ばい予想ではありません。`
        : `予想なし区間（表示のみ接続・方向予想なし）: ${formatDateJa(g.fromSession)} → ${formatDateJa(g.toSession)}。横ばい予想ではありません。`;
      line.append(svgNode('title', {}, note));
      ink.append(line);
    });
    series.forEach(s => {
      let part = [];
      function flush() {if (part.length > 1 && !s.pointsOnly) ink.append(svgNode('polyline', {points: part.join(' '), fill: 'none', stroke: s.color, 'stroke-width': s.kind === 'actual' ? 2.4 : s.segment ? 1 + 3 * s.segment.signal_strength : 2, 'stroke-dasharray': s.dashed ? '7 5' : s.dotted ? '2 5' : 'none'})); part = [];}
      s.points.forEach(p => {
        if (p.value === null || p.value === undefined || pos.get(p.date) == null) {flush(); return;}
        part.push(`${x(p.date)},${y(p.value)}`);
        const isOfficial = s.kind === 'official' && p.kind === 'official';
        const dot = svgNode('circle', {cx: x(p.date), cy: y(p.value), r: isOfficial ? 5.5 : 2.5, fill: s.color, ...(isOfficial ? {stroke: '#fff', 'stroke-width': 1.5} : {}), tabindex: 0});
        let title;
        if (isOfficial) title = officialTitle(s.name, p);
        else if (s.segment) title = `${s.name}｜${formatDateJa(p.date)}｜${fmtPct(toPct(p.value))}｜方向 ${(DIR_JA[s.segment.direction] || s.segment.direction)}｜強度 ${Math.round((s.segment.signal_strength || 0) * 100)}/100｜正式1/5/20とは別推定（途中の強弱予想）｜${translateEventName(s.segment.rationale || '')}`;
        else title = `${s.name}｜${formatDateJa(p.date)}｜${typeof p.value === 'number' ? fmtPct(toPct(p.value)) : p.value}`;
        dot.append(svgNode('title', {}, title)); ink.append(dot);
      }); flush();
    });
    priceMarkers.forEach(m => {
      if (pos.get(m.date) == null) return;
      if (m.kind === 'segment_end') {
        const marker = svgNode('text', {x: x(m.date), y: y(m.value) - 9, fill: '#625879', 'font-size': 11, 'text-anchor': 'middle', tabindex: 0}, '○');
        marker.append(svgNode('title', {}, `期間終了 ${formatDateJa(m.date)}｜方向: ${(DIR_JA[m.direction] || m.direction || '—')}（期間の終了・シグナル発生日ではありません）｜${translateEventName(m.label || '')}`)); ink.append(marker);
        return;
      }
      const label = m.kind === 'up' ? '▲' : '▼';
      const marker = svgNode('text', {x: x(m.date), y: y(m.value) - 9, fill: m.kind === 'down' ? '#b03648' : '#097968', 'font-size': 10 + 8 * m.strength, 'text-anchor': 'middle', tabindex: 0}, label);
      marker.append(svgNode('title', {}, markerTitle(m))); ink.append(marker);
    });
    if (laneMarkers.length) {
      svg.append(svgNode('rect', {x: 62, y: 330, width: span, height: 52, fill: '#f6f7fb', stroke: '#e2e6ed', rx: 6}));
      svg.append(svgNode('text', {x: 66, y: 343, fill: '#657183', 'font-size': 11}, 'イベント'));
      const order = {up: 0, down: 1, turn: 2, spiritual: 3, decision: 4, segment_end: 5};
      laneMarkers.forEach((m, idx) => {
        const session = m.session || m.start_session;
        if (session == null || pos.get(session) == null) return;
        const label = m.kind === 'up' ? '▲' : m.kind === 'down' ? '▼' : m.kind === 'turn' ? '◆' : m.kind === 'decision' ? '●' : m.kind === 'segment_end' ? '○' : '✦';
        const marker = svgNode('text', {x: x(session), y: 352 + (order[m.kind] ?? 3) * 7 - 7, fill: m.kind === 'down' ? '#b03648' : m.kind === 'up' ? '#097968' : '#625879', 'font-size': 10 + 8 * (m.strength || 0), 'text-anchor': 'middle', tabindex: 0, class: 'evmark', 'data-ev': m.evKey || ''});
        marker.style.cursor = 'pointer';
        marker.append(svgNode('title', {}, markerTitle(m)));
        if (m.evKey) marker.addEventListener('click', () => flashEventRow(m.evKey));
        svg.append(marker);
      });
      svg.append(svgNode('text', {x: width - 38, y: 343, 'text-anchor': 'end', fill: '#657183', 'font-size': 11}, '価格とは無関係の高さ'));
    }
    // Crosshair: vertical session guide + tooltip.
    const tip = document.createElement('div');
    tip.className = 'tooltip'; tip.hidden = true;
    $(id + '-chart').style.position = 'relative';
    const guide = svgNode('line', {y1: 5, y2: 288, stroke: '#7958b8', 'stroke-width': 1, 'stroke-dasharray': '4 3', visibility: 'hidden'});
    svg.append(guide);
    const catcher = svgNode('rect', {x: 62, y: 5, width: span, height: 283, fill: 'transparent', 'pointer-events': 'none'});
    svg.append(catcher);
    // Crosshair listens on the svg root (bubbling) so dots/markers keep native hover titles.
    svg.addEventListener('mousemove', ev => {
      const rect = svg.getBoundingClientRect();
      const px = (ev.clientX - rect.left) / rect.width * width;
      const frac = (px - 62) / span * (n - 1);
      const idx = Math.max(0, Math.min(n - 1, Math.round(frac)));
      const date = axis[idx];
      if (date == null) return;
      guide.setAttribute('x1', x(date)); guide.setAttribute('x2', x(date)); guide.setAttribute('visibility', 'visible');
      // Dynamic series/Theme names are untrusted presentation strings: never use innerHTML.
      tip.replaceChildren();
      const head = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = `${formatDateJa(date)}（${axis[idx]}）`;
      head.append(strong);
      tip.append(head);
      series.forEach(s => {
        const p = s.points.find(q => q.date === date);
        if (p && p.value != null) {
          const line = document.createElement('div');
          line.append(document.createTextNode(`${s.name}: ${fmtPct(toPct(p.value))}`));
          tip.append(line);
        }
      });
      tip.hidden = false;
      tip.style.left = Math.max(0, Math.min(ev.clientX - rect.left + 12, rect.width - 300)) + 'px'; tip.style.top = '8px';
    });
    catcher.addEventListener('mouseleave', () => {guide.setAttribute('visibility', 'hidden'); tip.hidden = true;});
    svg.addEventListener('mouseleave', () => {guide.setAttribute('visibility', 'hidden'); tip.hidden = true;});
    $(id + '-chart').replaceChildren(svg, tip);
    const seen = new Set();
    $(id + '-legend').replaceChildren(...series.filter(s => {if (seen.has(s.name)) return false; seen.add(s.name); return true;}).map(s => {
      const span = document.createElement('span'); const swatch = document.createElement('i');
      swatch.className = 'swatch' + (s.dashed ? ' dashed' : ''); swatch.style.background = s.color; swatch.style.color = s.color;
      span.append(swatch, document.createTextNode(s.name)); return span;
    }));
  }
  function flashEventRow(evKey) {
    document.querySelectorAll('#events tr[data-ev]').forEach(tr => tr.classList.remove('flash'));
    const rows = [...document.querySelectorAll(`#events tr[data-ev="${CSS.escape(evKey)}"]`)];
    if (rows.length) {rows[0].scrollIntoView({block: 'nearest'}); rows.forEach(tr => tr.classList.add('flash')); setTimeout(() => rows.forEach(tr => tr.classList.remove('flash')), 1300);}
  }
  /* Bidirectional navigation state: latest prediction-chart session axis. */
  const chartState = {axis: []};
  function focusEventOnChart(evKey, session) {
    const panel = document.getElementById('prediction-panel');
    if (panel) panel.scrollIntoView({block: 'start'});
    document.querySelectorAll('#prediction-chart .evmark.focus').forEach(n => {n.classList.remove('focus'); n.style.outline = '';});
    document.querySelectorAll('#events tr[data-ev]').forEach(tr => tr.classList.remove('flash'));
    const rows = [...document.querySelectorAll(`#events tr[data-ev="${CSS.escape(evKey)}"]`)];
    rows.forEach(tr => tr.classList.add('flash'));
    setTimeout(() => rows.forEach(tr => tr.classList.remove('flash')), 2600);
    const inAxis = !!session && chartState.axis.includes(session);
    const marks = [...document.querySelectorAll(`#prediction-chart .evmark[data-ev="${CSS.escape(evKey)}"]`)];
    if (marks.length && inAxis) {
      marks.forEach(m => {m.classList.add('focus'); m.style.outline = '2px solid #7958b8'; m.style.outlineOffset = '1px';});
      try { marks[0].scrollIntoView({block: 'nearest', inline: 'center'}); } catch (e) {}
      const tip = document.querySelector('#prediction-chart .tooltip');
      if (tip) {tip.replaceChildren(); const line = document.createElement('div'); line.append(document.createTextNode(`選択イベントの市場影響日: ${formatDateJa(session)}（${session}）`)); tip.append(line); tip.hidden = false; setTimeout(() => {tip.hidden = true;}, 2600);}
      setTimeout(() => marks.forEach(m => {m.classList.remove('focus'); m.style.outline = '';} ), 2600);
      return {status: 'focused', session};
    }
    const msg = document.getElementById('message');
    if (msg && session && !inAxis) {
      const note = document.createElement('span');
      note.append(document.createTextNode(`（選択イベントの市場影響日 ${formatDateJa(session)} は現在の表示範囲外です）`));
      msg.append(note);
      setTimeout(() => note.remove(), 4000);
    }
    return {status: inAxis ? 'marker-missing' : 'out-of-range', session};
  }
  function renderEvents(rows, showRef) {
    const table = document.createElement('table');
    const head = document.createElement('tr');
    ['発生日時（現地）', '市場影響', '方向', '強度', '対象 / 出所', '内容', '評価'].forEach(v => {const th = document.createElement('th'); th.textContent = v; head.append(th);});
    table.append(head);
    let n = 0;
    rows.forEach(t => {
      visibleEvents(t.events, showRef).forEach(e => {
        const isRef = isReferenceEvent(e);
        n++;
        const key = eventKey(t, e);
        const tr = document.createElement('tr'); tr.dataset.ev = key;
        const dirSym = isRef ? '' : e.direction === 'up' ? '▲ ' : e.direction === 'down' ? '▼ ' : e.direction === 'flat' ? '— ' : e.direction === 'mixed' ? '※ ' : '';
        const rawRationale = e.rationale || '';
        // Reference-only facts carry raw JSON: keep it in the tooltip, show a compact cell.
        const body = isRef ? '（参照データ・詳細は注釈）' : rawRationale.trim().startsWith('{') ? '（参照データ・詳細は注釈）' : translateEventName(rawRationale);
        const verdict = isRef ? '—' : formatResult(resultFor(t.results, e.item_key));
        const cells = [
          `${formatDateTimeJa(e.event_at, e.timezone)} ${tzShort(e.timezone)}（${e.local_date}）`,
          `${formatDateJa(e.start_session)}${e.end_session && e.end_session !== e.start_session ? '→' + formatDateJa(e.end_session) : ''}`,
          isRef ? '—' : dirSym + (DIR_JA[e.direction] || '—'),
          isRef ? '—' : `${e.strength_100}/100`,
          isRef ? `${displayOf(t)} / 参考情報` : `${displayOf(t)} / ${e.source === 'path_event' ? '期間予想' : e.source}`,
          body, verdict];
        cells.forEach((v, ci) => {const td = document.createElement('td'); td.textContent = v; if (ci === 5) td.title = rawRationale; tr.append(td);});
        tr.style.cursor = 'pointer';
        tr.title = '選択で上段チャートへ移動';
        tr.addEventListener('click', () => focusEventOnChart(key, sessionForEvent(e)));
        table.append(tr);
      });
    });
    if (!n) {const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 7; td.textContent = showRef ? 'この条件の占術イベントはありません。' : '重要な期間予想イベントはありません。参考イベントも表示を有効にすると参照データを表示します。'; tr.append(td); table.append(tr);}
    $('events').replaceChildren(table);
    return n;
  }
  function tableAt(id, headers, rows) {
    const table = document.createElement('table'), head = document.createElement('tr');
    headers.forEach(v => {const th = document.createElement('th'); th.textContent = v; head.append(th);});
    table.append(head);
    rows.forEach(row => {
      const tr = document.createElement('tr');
      row.forEach(value => {const td = document.createElement('td'); td.textContent = value ?? '—'; tr.append(td);});
      table.append(tr);
    });
    if (!rows.length) {const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = headers.length; td.textContent = '記録はまだありません。'; tr.append(td); table.append(tr);}
    $(id).replaceChildren(table);
  }
  function renderAudit(run, rows) {
    const exploration = run.exploration || [];
    const summary = run.exploration_summary || {};
    const names = {signal:'方向性あり', no_signal:'方向性なし', insufficient_input:'入力不足', identity_unresolved:'対象確認失敗', compared:'軽量比較のみ', discovered:'出典確認のみ・未比較'};
    const formal = {prediction:'正式予想あり', no_prediction:'正式予想なし', excluded:'発行対象外'};
    $('exploration-summary').textContent = run.warnings?.length ? run.warnings.join(' / ') : `${run.label || ''}：出典確認候補 ${summary.sourced_candidates ?? '不明'}・比較 ${summary.compared ?? exploration.length}（銘柄 ${summary.tracks?.stock ?? '不明'} / テーマ ${summary.tracks?.theme ?? '不明'} / 区分不明 ${summary.tracks?.unknown ?? 0}）・詳細分析 ${summary.detailed ?? '不明'}・正式発行 ${summary.formal_targets ?? '不明'}。signal ${summary.outcomes?.signal ?? 0} / no_signal ${summary.outcomes?.no_signal ?? 0} / insufficient_input ${summary.outcomes?.insufficient_input ?? 0} / 対象確認失敗 ${summary.identity_unresolved ?? 0}（分析結果とは別軸）。検索全体の件数は未記録です。`;
    tableAt('exploration', ['対象','比較方向','分析結果','対象確認','発行','判断理由','占術ごとの内訳'], exploration.map(r => [r.name, DIR_JA[r.direction] || '未比較', names[r.status] || r.status, ({unresolved:'未解決',resolved:'確認済み',unknown:'記録なし'}[r.identity] || '記録なし'), formal[r.formal], [r.comparison_reason,r.reason].filter((v,i,a) => v && a.indexOf(v) === i).join(' / '), (r.expert_assessments || []).map(e => `${e.expert}: ${e.status} ${e.reason}`).join(' / ') || '過去の記録には内訳がありません']));
    tableAt('decisions', ['対象','日付 / 期間','方向 / 強度','理由'], rows.flatMap(t => [
      ...(t.segments || []).map(s => [displayOf(t),`${s.start_session} → ${s.end_session}`,`${DIR_JA[s.direction]} / ${Math.round(s.signal_strength*100)}/100`,s.rationale]),
      ...(t.decision_points || []).map(d => [displayOf(t),d.date,DIR_JA[d.direction] || '節目',d.rationale])
    ]));
    tableAt('revisions', ['対象','版','採用日時','変更理由','1営業日','5営業日','20営業日'], rows.flatMap(t => (t.revisions || []).map(r => [displayOf(t),r.revision,formatDateTimeJa(r.issued_at,'Asia/Tokyo'),r.change_reason.map(reason => ({new_target:'新しい対象',turn:'転換点の変更',confidence:'確信度の変更'}[reason] || reason.replace('direction:', '方向の変更・').replace('probability:', '確率の変更・').replace('move:', '値幅の変更・') + '営業日')).join(' / '), ...['1','5','20'].map(h => r.outlook?.[h] ? `${DIR_JA[r.outlook[h].direction]} ${fmtMove(r.outlook[h].expected_move)}（基準 ${formatDateTimeJa(r.outlook[h].issued_at,'Asia/Tokyo')}）` : '—')])));
    tableAt('daily-values', ['対象','営業日','正式予想','期間の方向','実績'], rows.flatMap(t => (t.sessions || []).map(day => [displayOf(t),formatDateJa(day),(t.official || []).filter(p => p.date === day && p.kind === 'official').map(p => `${p.horizon}日: ${fmtMove(p.expected_move)}`).join(' / ') || '—', (t.segments || []).filter(s => s.start_session <= day && day <= s.end_session).map(s => `${DIR_JA[s.direction]} / 強度${Math.round(s.signal_strength*100)}`).join(' / ') || '未予想',fmtPct(toPct((t.actual || []).find(p => p.date === day)?.value))])));
    const perf = data.performance || [], loss = v => v == null ? '未評価' : v.toFixed(4);
    const poolName = p => p.replace('stock:', '銘柄・').replace('theme:', 'テーマ・') + '営業日';
    tableAt('performance', ['区分','発行した比較','評価済み','重み付き損失','均等重み損失','横ばい予測の損失'], perf.map(p => [poolName(p.pool),p.issued,p.evaluated,loss(p.weighted),loss(p.equal),loss(p.zero)]));
    tableAt('calibration', ['区分','方向','観測数','平均予測確率','実際の頻度'], perf.flatMap(p => Object.entries(p.calibration || {}).flatMap(([direction,bins]) => bins.filter(b => b.count).map(b => [poolName(p.pool),DIR_JA[direction],b.count,fmtMove(b.mean_probability),fmtMove(b.observed_frequency)]))));
  }
  function renderContinuity(rows, options) {
    const subject = options.mode === 'single' && options.run === 'tracking'
      ? (data.subjects || []).find(s => s.target_type === options.kind && s.target_id === rows[0]?.target_id) : null;
    $('continuity-panel').hidden = !subject;
    if (!subject) return rows;
    const key = `${subject.target_type}:${subject.target_id}`;
    if (snapshotKey !== key) {snapshotKey = key; comparisons = [];}
    $('snapshot-options').replaceChildren(...subject.snapshots.map((s, index) => {
      const label = document.createElement('label'), input = document.createElement('input');
      input.type = 'checkbox'; input.checked = comparisons.includes(index);
      const current = s.issued_at === subject.latest.issued_at;
      input.disabled = current;
      const name = `${formatDateTimeJa(s.issued_at, 'Asia/Tokyo')} / ${s.adopted ? `採用 第${s.target.revision ?? '—'}版` : '再分析（未採用）'}${current ? ' / 表示中' : ''}`;
      label.append(input, document.createTextNode(name));
      input.addEventListener('change', () => {comparisons = input.checked ? [...comparisons, index] : comparisons.filter(i => i !== index); render();});
      return label;
    }));
    tableAt('timeline', ['分析日時','Forecast判断','分析結果 / 理由'], subject.timeline.map(e => [
      formatDateTimeJa(e.issued_at,'Asia/Tokyo'), e.action === 'NO_CHANGE' ? 'NO_CHANGE / 採用予想を継続' : e.action === 'UPDATE' ? 'UPDATE / 予想を更新' : '分析のみ',
      [...e.reasons, ...e.analysis.map(a => `${a.status}: ${a.reason}`)].join(' / ') || '変更なし'
    ]));
    return [...rows, ...comparisons.map(i => {
      const snapshot = subject.snapshots[i], target = snapshot.target;
      return {...target, forecast_origin: 'historical', display_name: `${displayOf(target)} / ${formatDateTimeJa(snapshot.issued_at,'Asia/Tokyo')} ${snapshot.adopted ? '旧採用版' : '未採用分析'}`};
    })];
  }
  function renderWeights() {
    const pool = $('weight-pool').value, history = (data.weight_history || []).filter(s => s.pools[pool]);
    const experts = ['astrology','four_pillars','sanmeigaku','nine_star_ki','sukuyo','koyomi','numerology','lunar','space_weather'].filter(e => e in (history[0]?.pools[pool].weights || {}));
    const palette = ['#6750a4','#007f86','#bd4d27','#306eb4','#8c596e','#64702a','#9c2e70','#555','#a56800'];
    const svg = svgNode('svg', {viewBox:'0 0 970 300',role:'img','aria-label':'9系統の重みの時系列'});
    const start = history.length ? Date.parse(history[0].as_of) : 0;
    const end = Math.max(start + 1, Date.parse(data.as_of));
    const x = at => 62 + (Date.parse(at) - start) / (end - start) * 870;
    const max = Math.max(.15, ...history.flatMap(s => Object.values(s.pools[pool].weights))) * 1.1;
    const y = value => 245 - value / max * 220;
    [0, max/2, max].forEach(value => {
      svg.append(svgNode('line',{x1:62,x2:932,y1:y(value),y2:y(value),stroke:'#ddd'}));
      svg.append(svgNode('text',{x:55,y:y(value)+4,'text-anchor':'end','font-size':12},`${(value*100).toFixed(1)}%`));
    });
    experts.forEach((expert,index) => {
      let path = '';
      history.forEach((s,i) => {
        const value = s.pools[pool].weights[expert];
        path += i ? ` H${x(s.as_of)} V${y(value)}` : `M${x(s.as_of)},${y(value)}`;
      });
      if (history.length) path += ' H932';
      svg.append(svgNode('path',{d:path,fill:'none',stroke:palette[index],'stroke-width':2}));
    });
    if (history.length) {
      [history[0].as_of, data.as_of].forEach((at,i) => svg.append(svgNode('text',{x:i?932:62,y:275,'text-anchor':i?'end':'start','font-size':12},formatDateTimeJa(at,'Asia/Tokyo'))));
    }
    $('weight-chart').replaceChildren(svg);
    $('weight-legend').replaceChildren(...experts.map((e,i) => {const label=document.createElement('span');label.textContent=e;label.style.color=palette[i];return label;}));
    tableAt('weight-values', ['状態の基準日時','状態','sample_count',...experts], history.map(s => {
      const p = s.pools[pool];
      return [formatDateTimeJa(s.as_of,'Asia/Tokyo'),p.phase === 'initial' ? '初期均等（未学習）' : '学習後',p.sample_count,
        ...experts.map(e => `${(p.weights[e]*100).toFixed(3)}% / coverage ${p.coverage[e]} (${p.sample_count ? (100*p.coverage[e]/p.sample_count).toFixed(0)+'%' : '未評価'})`)];
    }));
  }
  function render() {
    const options = settings(), rows = renderContinuity(selectedTargets(data, options), options);
    try { localStorage.setItem('spiritual-stock-view', JSON.stringify({targets: options.targets,
      controls: Object.fromEntries(['run','kind','mode','status','zoom','yscale','ymin','ymax'].map(k => [k, $(k).value]))})); } catch {}
    const stockRow = options.mode === 'single' && options.kind === 'stock' ? rows[0] : null;
    fillRelated(stockRow);
    const overlay = stockRow ? relatedThemes(data, options.run, stockRow).filter(t => options.related.includes(t.target_id)) : [];
    const groups = chartGroups(rows, {...options, overlay});
    $('theme-options').hidden = options.kind !== 'theme';
    $('actual-panel').hidden = options.mode !== 'multiple';
    $('prediction-title').textContent = options.mode === 'single' ? '予想と実績' : '予想比較';
    $('axis-note').textContent = axisNote(rows, overlay);
    const axis = sessionAxis([...rows, ...overlay]);
    chartState.axis = axis;
    const markers = rows.flatMap(t => (t.markers || []).filter(m => options[m.kind]));
    const visible = m => m.source === 'path_event' || m.source == null || m.kind === 'turn' || m.kind === 'decision' || options.refEvents;
    const priceMarkers = markers.filter(m => m.value !== null && m.value !== undefined);
    const laneMarkers = [...rows, ...overlay].flatMap(t => (t.markers || []).filter(m => options[m.kind] && visible(m) && (m.value === null || m.value === undefined))
      .map(m => ({...m, evKey: m.event_at ? eventKey(t, {event_at: m.event_at, start_session: m.start_session || m.session || ''}) : ''})));
    const values = [...groups.upper, ...groups.lower].flatMap(s => s.points).filter(p => Number.isFinite(p.value)).map(p => p.value);
    values.push(100);
    let ymin = Math.min(...values), ymax = Math.max(...values);
    const padding = Math.max((ymax - ymin) * .12, .5); ymin -= padding; ymax += padding;
    if ($('yscale').value === 'fixed') {
      const low = Number($('ymin').value), high = Number($('ymax').value);
      if (Number.isFinite(low) && Number.isFinite(high) && low < high) { ymin = low + 100; ymax = high + 100; }
    }
    const gaps = [...rows, ...overlay].flatMap(gapConnectors);
    plot('prediction', groups.upper, priceMarkers, laneMarkers, axis, [ymin, ymax], gaps);
    plot('actual', groups.lower, [], [], axis, [ymin, ymax], []);
    renderEvents(rows, options.refEvents);
    const runMeta = findRun(data, options.run) || {};
    renderAudit(data.runs.find(r => r.run_id === $('audit-run').value) || {}, rows);
    const nA = (runMeta.analysis || []).length, nC = (runMeta.carried_forecasts || []).length,
      nI = new Set((runMeta.identity_failures || []).map(r => r.target_id)).size;
    // 最新分析 (this run) と過去Forecast継続 (carried) を混同させない。
    // 正式予想0件のrunでも分析自体は表示する（消さない）。
    $('message').textContent = rows.length ? rows.map(t => `${displayOf(t)}［${statusJa(t)}］基準 ${formatDateTimeJa(t.issued_at,'Asia/Tokyo')} 日本時間${t.forecast_origin === 'adopted' ? `（${t.status === 'current' ? '採用中' : '最終採用'}・第${t.revision ?? '—'}版）` : t.forecast_origin === 'this_run' ? '（今回作成）' : ''}${t.reason ? ' · ' + t.reason : ''}`).join(' / ')
      : (nA || nC || nI ? `このrunに正式予想はありません（今回の分析 ${nA}件・対象確認失敗 ${nI}件・過去から継続の予測 ${nC}件）。上の探索・選別結果と「現在有効な予想」を確認してください。`
        : 'この条件の予想はありません。実行日・種別・期間を選んでください。');
    const table = document.createElement('table'), head = document.createElement('tr');
    ['対象 / 窓', '状態', '判定', '予想方向', '予想変化', '実現変化', '符号一致', '差 / 絶対誤差', '取得後評価時刻'].forEach(v => {const th = document.createElement('th'); th.textContent = v; head.append(th);}); table.append(head);
    rows.forEach(t => (t.results || []).forEach(r => {
      const tr = document.createElement('tr'), percent = v => v === null ? '—' : (v * 100).toFixed(3) + '%';
      const dirJa = DIR_JA[r.predicted_direction] || r.predicted_direction;
      [displayOf(t) + ' / ' + r.item_key + ' / ' + r.effect_window.start_session + ' → ' + r.effect_window.end_session, r.status, verdictOf(r), dirJa, percent(r.predicted_expected_move), percent(r.actual_move), r.sign_agreement === null ? '—' : String(r.sign_agreement), percent(r.magnitude_difference) + ' / ' + percent(r.magnitude_error), r.available_at].forEach(v => {const td = document.createElement('td'); td.textContent = v; tr.append(td);}); table.append(tr);
    }));
    rows.forEach(t => (t.retained_outlooks || []).forEach(o => {
      const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 9;
      td.textContent = `${displayOf(t)}：継続する${o.horizon}日予想 ${fmtMove(o.expected_move)}（基準 ${o.issued_at}、期限 ${o.date}）。基準が異なるため現在の線には接続しません。`;
      tr.append(td); table.append(tr);
    }));
    $('results').replaceChildren(table); $('evidence').textContent = JSON.stringify(rows, null, 2);
  }
  $('data-warnings').textContent = (data.warnings || []).length ? `履歴の一部を表示できません（${data.warnings.length}件）。欠落を分析なし・0件と判断しないでください。` : '';
  $('source').textContent = `実績基準 ${data.as_of}${data.source_ref ? ' · Git ' + data.source_ref : ' · 公開版'} · 横軸は営業日のみ・縦軸は基準からの変化率（％）`;
  $('run').replaceChildren(...[...(data.subjects ? [{run_id:'tracking', targets:[], label:'銘柄・テーマを継続追跡'}] : []), ...(data.current ? [data.current] : []), ...data.runs].map(r => {
    if (r.run_id === 'tracking') return option('tracking', r.label);
    if (r.run_id === 'current') return option('current', `現在有効な予想（銘柄${r.targets.filter(t => t.target_type === 'stock').length}・テーマ${r.targets.filter(t => t.target_type === 'theme').length}）`);
    const extra = `分析${(r.analysis || []).length}件・継続${(r.carried_forecasts || []).length}件`;
    return option(r.run_id, `${r.label || `${r.run_date} 基準 ${r.run_id.slice(0, 8)}`}［正式${(r.targets || []).length}・${extra}］`, `${r.run_date} · ${r.issued_at} · ${r.run_kind || ''} · ${r.run_id} · ${extra}`);
  }));
  $('audit-run').replaceChildren(...data.runs.map(r => option(r.run_id, r.label)));
  $('audit-run').addEventListener('change', render);
  $('weight-pool').replaceChildren(...['stock','theme'].flatMap(k => [1,5,20].map(h => option(`${k}:${h}`, `${k === 'stock' ? '銘柄' : 'テーマ'}・${h}営業日`))));
  $('weight-pool').addEventListener('change', renderWeights);
  renderWeights();
  ['run', 'kind', 'mode', 'status'].forEach(k => $(k).addEventListener('change', fillTargets));
  ['up', 'down', 'turn', 'spiritual', 'raw', 'benchmark', 'refEvents', 'zoom', 'yscale', 'ymin', 'ymax'].forEach(k => $(k).addEventListener('change', render));
  $('targets').addEventListener('change', render);
  $('related').addEventListener('change', render);
  $('all').addEventListener('click', () => {$('mode').value = 'multiple'; fillTargets(); [...document.querySelectorAll('#targets input')].forEach(o => o.checked = true); render();});
  $('none').addEventListener('click', () => {[...document.querySelectorAll('#targets input')].forEach(o => o.checked = false); render();});
  try {
    const saved = JSON.parse(localStorage.getItem('spiritual-stock-view') || 'null');
    if (saved) {
      Object.entries(saved.controls || {}).forEach(([key,value]) => {
        if (!['run','kind','mode','status','zoom','yscale','ymin','ymax'].includes(key)) return;
        const node = $(key);
        if (node.tagName !== 'SELECT' || [...node.options].some(o => o.value === value)) node.value = value;
      });
      savedTargets = Array.isArray(saved.targets) ? saved.targets : [];
    }
  } catch {}
  if (data.subjects && $('run').value === 'current') $('run').value = 'tracking';
  fillTargets();
}
