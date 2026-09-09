/* Native SVG, no build or network dependency. Works over file://. */
'use strict';
const colors = ['#6750a4', '#007f86', '#bd4d27', '#306eb4', '#8c596e', '#64702a'];
const WEEK_JA = ['日', '月', '火', '水', '木', '金', '土'];
const DIR_JA = {up: '上昇', down: '下落', flat: '方向なし（横ばい）', mixed: '混合・不定'};
const STATUS_JA = {current: '予想期間中', expired: '評価終了'};

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

function availableTargets(data, runId, kind, status) {
  return (data.runs.find(r => r.run_id === runId)?.targets || [])
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
  const run = data.runs.find(r => r.run_id === runId);
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
      refEvents: $('refEvents').checked};
  }
  function statusJa(t) { return STATUS_JA[t.status] || t.status; }
  function fillTargets() {
    const old = checkedValues('targets');
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
    const x = date => 62 + (axis.length < 2 ? 435 : (pos.get(date) ?? -1) / (n - 1) * 870);
    const y = value => 285 - (toPct(value) - ymin) / (ymax - ymin) * 240;
    const H = laneMarkers.length ? 392 : 335;
    const svg = svgNode('svg', {viewBox: `0 0 970 ${H}`, role: 'img', 'aria-label': id === 'prediction' ? $('prediction-title').textContent : '実績比較'});
    svg.append(svgNode('title', {}, '点にフォーカスまたはマウスを置くと日付と値を表示。横軸は営業日のみ。縦軸は基準からの変化率（％）。詳細数値は下の表にも記録。'));
    pctTicks(ymin, ymax).forEach(value => {
      const isZero = value === 0;
      svg.append(svgNode('line', {x1: 62, x2: 932, y1: y(value + 100), y2: y(value + 100),
        stroke: isZero ? '#4a4a68' : '#e2e6ed', 'stroke-width': isZero ? 2.2 : 1}));
      svg.append(svgNode('text', {x: 54, y: y(value + 100) + 4, 'text-anchor': 'end',
        fill: isZero ? '#22223a' : '#657183', 'font-size': isZero ? 12 : 11,
        'font-weight': isZero ? 'bold' : 'normal'}, fmtPct(value)));
    });
    if (ymin <= 0 && ymax >= 0) {
      svg.append(svgNode('text', {x: 928, y: y(100) - 6, 'text-anchor': 'end', fill: '#22223a', 'font-size': 11, 'font-weight': 'bold'}, '基準 0%'));
    }
    const stride = Math.max(1, Math.ceil(n / 9));
    axis.forEach((d, i) => {
      if (i % stride) return;
      svg.append(svgNode('text', {x: x(d), y: 306, 'text-anchor': 'middle', fill: '#263444', 'font-size': 12}, formatDateJa(d)));
      svg.append(svgNode('line', {x1: x(d), x2: x(d), y1: 288, y2: 296, stroke: '#b8c3d0'}));
    });
    if (axis.length > 1) svg.append(svgNode('text', {x: 932, y: 322, 'text-anchor': 'end', fill: '#657183', 'font-size': 11}, '横軸＝営業日（休場日なし）'));
    // Gray gap connectors: visual only, never a forecast.
    gaps.forEach(g => {
      if (pos.get(g.fromSession) == null || pos.get(g.toSession) == null) return;
      const attrs = {x1: x(g.fromSession), x2: x(g.toSession), y1: y(g.from.value), y2: y(g.to.value), stroke: '#9aa3b2', 'stroke-width': 1.6, 'stroke-dasharray': '3 4'};
      const line = svgNode('line', attrs);
      const note = g.to && g.to.kind === 'official'
        ? `予想なし区間（表示のみ接続・方向予想なし）: ${formatDateJa(g.fromSession)} → ${formatDateJa(g.toSession)} の正式予想点まで。横ばい予想ではありません。`
        : `予想なし区間（表示のみ接続・方向予想なし）: ${formatDateJa(g.fromSession)} → ${formatDateJa(g.toSession)}。横ばい予想ではありません。`;
      line.append(svgNode('title', {}, note));
      svg.append(line);
    });
    series.forEach(s => {
      let part = [];
      function flush() {if (part.length > 1 && !s.pointsOnly) svg.append(svgNode('polyline', {points: part.join(' '), fill: 'none', stroke: s.color, 'stroke-width': s.kind === 'actual' ? 2.4 : 2, 'stroke-dasharray': s.dashed ? '7 5' : s.dotted ? '2 5' : 'none'})); part = [];}
      s.points.forEach(p => {
        if (p.value === null || p.value === undefined || pos.get(p.date) == null) {flush(); return;}
        part.push(`${x(p.date)},${y(p.value)}`);
        const isOfficial = s.kind === 'official' && p.kind === 'official';
        const dot = svgNode('circle', {cx: x(p.date), cy: y(p.value), r: isOfficial ? 5.5 : 2.5, fill: s.color, ...(isOfficial ? {stroke: '#fff', 'stroke-width': 1.5} : {}), tabindex: 0});
        let title;
        if (isOfficial) title = officialTitle(s.name, p);
        else if (s.segment) title = `${s.name}｜${formatDateJa(p.date)}｜${fmtPct(toPct(p.value))}｜方向 ${(DIR_JA[s.segment.direction] || s.segment.direction)}｜強度 ${Math.round((s.segment.signal_strength || 0) * 100)}/100｜正式1/5/20とは別推定（途中の強弱予想）｜${translateEventName(s.segment.rationale || '')}`;
        else title = `${s.name}｜${formatDateJa(p.date)}｜${typeof p.value === 'number' ? fmtPct(toPct(p.value)) : p.value}`;
        dot.append(svgNode('title', {}, title)); svg.append(dot);
      }); flush();
    });
    priceMarkers.forEach(m => {
      if (pos.get(m.date) == null) return;
      if (m.kind === 'segment_end') {
        const marker = svgNode('text', {x: x(m.date), y: y(m.value) - 9, fill: '#625879', 'font-size': 11, 'text-anchor': 'middle', tabindex: 0}, '○');
        marker.append(svgNode('title', {}, `期間終了 ${formatDateJa(m.date)}｜方向: ${(DIR_JA[m.direction] || m.direction || '—')}（期間の終了・シグナル発生日ではありません）｜${translateEventName(m.label || '')}`)); svg.append(marker);
        return;
      }
      const label = m.kind === 'up' ? '▲' : '▼';
      const marker = svgNode('text', {x: x(m.date), y: y(m.value) - 9, fill: m.kind === 'down' ? '#b03648' : '#097968', 'font-size': 10 + 8 * m.strength, 'text-anchor': 'middle', tabindex: 0}, label);
      marker.append(svgNode('title', {}, markerTitle(m))); svg.append(marker);
    });
    if (laneMarkers.length) {
      svg.append(svgNode('rect', {x: 62, y: 330, width: 870, height: 52, fill: '#f6f7fb', stroke: '#e2e6ed', rx: 6}));
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
      svg.append(svgNode('text', {x: 932, y: 343, 'text-anchor': 'end', fill: '#657183', 'font-size': 11}, '価格とは無関係の高さ'));
    }
    // Crosshair: vertical session guide + tooltip.
    const tip = document.createElement('div');
    tip.className = 'tooltip'; tip.hidden = true;
    $(id + '-chart').style.position = 'relative';
    const guide = svgNode('line', {y1: 5, y2: 288, stroke: '#7958b8', 'stroke-width': 1, 'stroke-dasharray': '4 3', visibility: 'hidden'});
    svg.append(guide);
    const catcher = svgNode('rect', {x: 62, y: 5, width: 870, height: 283, fill: 'transparent', 'pointer-events': 'none'});
    svg.append(catcher);
    // Crosshair listens on the svg root (bubbling) so dots/markers keep native hover titles.
    svg.addEventListener('mousemove', ev => {
      const rect = svg.getBoundingClientRect();
      const px = (ev.clientX - rect.left) / rect.width * 970;
      const frac = (px - 62) / 870 * (n - 1);
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
      tip.style.left = Math.min(px + 12, 640) + 'px'; tip.style.top = '8px';
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
  function render() {
    const options = settings(), rows = selectedTargets(data, options);
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
    const gaps = [...rows, ...overlay].flatMap(gapConnectors);
    plot('prediction', groups.upper, priceMarkers, laneMarkers, axis, [ymin, ymax], gaps);
    plot('actual', groups.lower, [], [], axis, [ymin, ymax], []);
    renderEvents(rows, options.refEvents);
    const runMeta = (data.runs || []).find(r => r.run_id === options.run) || {};
    const nA = (runMeta.analysis || []).length, nC = (runMeta.carried_forecasts || []).length,
      nI = (runMeta.identity_failures || []).length;
    // 最新分析 (this run) と過去Forecast継続 (carried) を混同させない。
    // 正式予想0件のrunでも分析自体は表示する（消さない）。
    $('message').textContent = rows.length ? rows.map(t => `${displayOf(t)}［${statusJa(t)}］基準 ${t.issued_at}${t.forecast_origin === 'this_run' ? '（今回作成）' : ''}${t.reason ? ' · ' + t.reason : ''}`).join(' / ')
      : (nA || nC || nI ? `このrunに正式予想はありません（今回の分析 ${nA}件・対象確認失敗 ${nI}件・過去から継続の予測 ${nC}件）。詳細は派生JSONの analysis / carried_forecasts を参照。`
        : 'この条件の予想はありません。実行日・種別・期間を選んでください。');
    const table = document.createElement('table'), head = document.createElement('tr');
    ['対象 / 窓', '状態', '判定', '予想方向', '予想変化', '実現変化', '符号一致', '差 / 絶対誤差', '取得後評価時刻'].forEach(v => {const th = document.createElement('th'); th.textContent = v; head.append(th);}); table.append(head);
    rows.forEach(t => (t.results || []).forEach(r => {
      const tr = document.createElement('tr'), percent = v => v === null ? '—' : (v * 100).toFixed(3) + '%';
      const dirJa = DIR_JA[r.predicted_direction] || r.predicted_direction;
      [displayOf(t) + ' / ' + r.item_key + ' / ' + r.effect_window.start_session + ' → ' + r.effect_window.end_session, r.status, verdictOf(r), dirJa, percent(r.predicted_expected_move), percent(r.actual_move), r.sign_agreement === null ? '—' : String(r.sign_agreement), percent(r.magnitude_difference) + ' / ' + percent(r.magnitude_error), r.available_at].forEach(v => {const td = document.createElement('td'); td.textContent = v; tr.append(td);}); table.append(tr);
    }));
    $('results').replaceChildren(table); $('evidence').textContent = JSON.stringify(rows, null, 2);
  }
  $('source').textContent = `実績基準 ${data.as_of}${data.source_ref ? ' · Git ' + data.source_ref : ' · 公開版'} · 横軸は営業日のみ・縦軸は基準からの変化率（％）`;
  $('run').replaceChildren(...data.runs.map(r => {
    const extra = `分析${(r.analysis || []).length}件・継続${(r.carried_forecasts || []).length}件`;
    return option(r.run_id, `${r.label || `${r.run_date} 基準 ${r.run_id.slice(0, 8)}`}［正式${(r.targets || []).length}・${extra}］`, `${r.run_date} · ${r.issued_at} · ${r.run_kind || ''} · ${r.run_id} · ${extra}`);
  }));
  ['run', 'kind', 'mode', 'status'].forEach(k => $(k).addEventListener('change', fillTargets));
  ['up', 'down', 'turn', 'spiritual', 'raw', 'benchmark', 'refEvents'].forEach(k => $(k).addEventListener('change', render));
  $('targets').addEventListener('change', render);
  $('related').addEventListener('change', render);
  $('all').addEventListener('click', () => {$('mode').value = 'multiple'; fillTargets(); [...document.querySelectorAll('#targets input')].forEach(o => o.checked = true); render();});
  $('none').addEventListener('click', () => {[...document.querySelectorAll('#targets input')].forEach(o => o.checked = false); render();});
  fillTargets();
}
