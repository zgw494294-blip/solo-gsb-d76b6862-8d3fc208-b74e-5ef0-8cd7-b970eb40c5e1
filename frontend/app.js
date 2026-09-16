'use strict';

/* ================= 常量与状态 ================= */

const LABEL_W = 120;   // 与 --gutter-w 保持一致
const ROW_H = 34;
const LANE_PAD = 6;

const state = {
  cues: [],
  departments: [],
  pxPerSec: Number(localStorage.getItem('pxPerSec')) || 2,
  hiddenDepts: new Set(JSON.parse(localStorage.getItem('hiddenDepts') || '[]')),
  selectedId: null,
  rowOf: new Map(), // 渲染时计算：cue id -> 泳道内行号
};

const $ = (sel) => document.querySelector(sel);
const scroller = $('#timeline-scroll');

/* ================= 工具函数 ================= */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function fmt(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

// 解析 "90" / "1:30" / "1:02:00"；空串返回 null，非法返回 undefined
function parseTime(str) {
  str = String(str).trim();
  if (!str) return null;
  const parts = str.split(':');
  if (parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return undefined;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

function deptColor(dept) {
  let h = 0;
  for (const ch of dept) h = (h * 31 + ch.codePointAt(0)) % 360;
  return `hsl(${h} 55% 42%)`;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
}

function persistPrefs() {
  localStorage.setItem('pxPerSec', String(state.pxPerSec));
  localStorage.setItem('hiddenDepts', JSON.stringify([...state.hiddenDepts]));
}

/* ================= API ================= */

async function req(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `请求失败（${res.status}）`;
    try { msg = (await res.json()).detail || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

const api = {
  list: () => req('GET', '/api/cues'),
  create: (body) => req('POST', '/api/cues', body),
  update: (id, body) => req('PUT', `/api/cues/${id}`, body),
  remove: (id) => req('DELETE', `/api/cues/${id}`),
  addDep: (id, body) => req('POST', `/api/cues/${id}/dependencies`, body),
  removeDep: (id, depId) => req('DELETE', `/api/cues/${id}/dependencies/${depId}`),
};

async function refresh() {
  const data = await api.list();
  state.cues = data.cues;
  state.departments = data.departments;
  if (state.selectedId && !state.cues.some((c) => c.id === state.selectedId)) {
    state.selectedId = null;
  }
  renderAll();
}

/* ================= 渲染：部门筛选 ================= */

function renderFilter() {
  const panel = $('#filter-panel');
  panel.innerHTML = state.departments.map((d) =>
    `<label><input type="checkbox" data-dept="${esc(d)}" ${state.hiddenDepts.has(d) ? '' : 'checked'}> ${esc(d)}</label>`
  ).join('') + '<div class="filter-actions"><button type="button" id="filter-all">全选</button><button type="button" id="filter-none">清空</button></div>';

  panel.querySelectorAll('input[type=checkbox]').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) state.hiddenDepts.delete(cb.dataset.dept);
      else state.hiddenDepts.add(cb.dataset.dept);
      persistPrefs();
      renderTimeline();
    });
  });
  $('#filter-all').onclick = () => { state.hiddenDepts.clear(); persistPrefs(); renderFilter(); renderTimeline(); };
  $('#filter-none').onclick = () => {
    state.departments.forEach((d) => state.hiddenDepts.add(d));
    persistPrefs(); renderFilter(); renderTimeline();
  };
}

/* ================= 渲染：时间轴 ================= */

function visibleCues() {
  return state.cues.filter((c) => !state.hiddenDepts.has(c.department));
}

function layoutLane(list) {
  const sorted = [...list].sort((a, b) => a.start - b.start || a.id - b.id);
  const rowEnds = [];
  for (const c of sorted) {
    let r = rowEnds.findIndex((end) => end <= c.start);
    if (r === -1) { r = rowEnds.length; rowEnds.push(0); }
    rowEnds[r] = c.end;
    state.rowOf.set(c.id, r);
  }
  return rowEnds.length || 1;
}

function selectedChain() {
  const sel = state.cues.find((c) => c.id === state.selectedId);
  return new Set(sel && sel.conflict ? sel.conflict_chain : []);
}

function renderTimeline() {
  state.rowOf = new Map();
  const lanes = $('#lanes');
  const maxEnd = Math.max(60, ...state.cues.map((c) => c.end));
  const trackW = Math.ceil((maxEnd + 60) * state.pxPerSec);

  // 时间刻度尺
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
  const step = steps.find((s) => s * state.pxPerSec >= 80) || 14400;
  let ticks = '';
  for (let t = 0; t <= maxEnd + 60; t += step) {
    ticks += `<div class="tick" style="left:${t * state.pxPerSec}px"><span>${fmt(t)}</span></div>`;
  }
  $('#ruler').innerHTML = `<div class="gutter"></div><div class="track" style="width:${trackW}px">${ticks}</div>`;

  // 按部门分泳道
  const byDept = new Map();
  for (const c of visibleCues()) {
    if (!byDept.has(c.department)) byDept.set(c.department, []);
    byDept.get(c.department).push(c);
  }
  if (byDept.size === 0) {
    lanes.innerHTML = '<div class="empty">暂无可见提示 —— 点击「＋ 新增提示」开始编排，或调整部门筛选</div>';
    return;
  }

  const chain = selectedChain();
  let html = '';
  for (const [dept, list] of byDept) {
    const rows = layoutLane(list);
    const laneH = rows * ROW_H + LANE_PAD * 2;
    const blocks = list.map((c) => {
      const cls = ['cue-block'];
      if (c.locked_start !== null) cls.push('locked');
      if (c.conflict) cls.push('conflict');
      if (c.id === state.selectedId) cls.push('selected');
      if (chain.has(c.id)) cls.push('chain');
      const icon = (c.locked_start !== null ? '🔒' : '') + (c.conflict ? '⚠' : '');
      return `<div class="${cls.join(' ')}" data-id="${c.id}"
        style="left:${c.start * state.pxPerSec}px;width:${Math.max(6, c.duration * state.pxPerSec)}px;top:${LANE_PAD + state.rowOf.get(c.id) * ROW_H}px;background:${deptColor(c.department)}"
        title="${esc(c.department)} / ${esc(c.name)}&#10;${fmt(c.start)} → ${fmt(c.end)}（时长 ${fmt(c.duration)}）">${icon}${esc(c.name)}<span class="cue-time">${fmt(c.start)}</span></div>`;
    }).join('');
    html += `<div class="lane" style="height:${laneH}px">
      <div class="gutter lane-label" style="border-left:4px solid ${deptColor(dept)}">${esc(dept)}</div>
      <div class="track" style="width:${trackW}px">${blocks}</div>
    </div>`;
  }
  lanes.innerHTML = html;
  lanes.querySelectorAll('.cue-block').forEach((el) => {
    el.addEventListener('click', () => selectCue(Number(el.dataset.id)));
  });
}

function scrollToCue(id) {
  const el = document.querySelector(`.cue-block[data-id="${id}"]`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
}

function selectCue(id) {
  state.selectedId = id;
  renderTimeline();
  renderDetail();
}

/* ================= 渲染：详情面板 ================= */

function nameOf(id) {
  const c = state.cues.find((x) => x.id === id);
  return c ? `${c.department} / ${c.name}` : `#${id}`;
}

function renderDetail() {
  const el = $('#detail');
  const c = state.cues.find((x) => x.id === state.selectedId);
  if (!c) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');

  const deps = c.dependencies.map((d) =>
    `<li>${esc(nameOf(d.depends_on))} ＋延迟 ${fmt(d.delay)}
      <button class="link" data-del-dep="${d.id}">删除</button></li>`
  ).join('') || '<li class="muted">无前置依赖</li>';

  const conflictBox = c.conflict ? `
    <div class="conflict-box">
      ⚠ 锁定时间 ${fmt(c.locked_start)} 早于依赖允许时间 ${fmt(c.earliest)}，已保留锁定值。<br>
      完整冲突链：${c.conflict_chain.map((id) =>
        `<button class="chain-chip" data-goto="${id}">${esc(nameOf(id))}</button>`).join(' → ') || '（无）'}
    </div>` : '';

  el.innerHTML = `
    <h3>${esc(c.name)}</h3>
    <div class="dept-tag" style="background:${deptColor(c.department)}">${esc(c.department)}</div>
    <dl>
      <dt>开始</dt><dd>${fmt(c.start)}</dd>
      <dt>结束</dt><dd>${fmt(c.end)}</dd>
      <dt>时长</dt><dd>${fmt(c.duration)}</dd>
      <dt>最早可开始</dt><dd>${fmt(c.earliest)}</dd>
      <dt>锁定</dt><dd>${c.locked_start !== null ? '🔒 ' + fmt(c.locked_start) : '未锁定（自动排算）'}</dd>
    </dl>
    ${conflictBox}
    <h4>前置依赖</h4>
    <ul class="dep-ul">${deps}</ul>
    <div class="detail-actions">
      <button id="detail-edit" class="primary">编辑</button>
      <button id="detail-delete" class="danger">删除</button>
    </div>`;

  $('#detail-edit').onclick = () => openModal(c);
  $('#detail-delete').onclick = async () => {
    if (!confirm(`确定删除「${c.name}」？其相关依赖会一并移除。`)) return;
    try {
      await api.remove(c.id);
      state.selectedId = null;
      await refresh();
    } catch (err) { toast(err.message); }
  };
  el.querySelectorAll('[data-del-dep]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        await api.removeDep(c.id, Number(btn.dataset.delDep));
        await refresh();
      } catch (err) { toast(err.message); }
    };
  });
  el.querySelectorAll('[data-goto]').forEach((btn) => {
    btn.onclick = () => {
      selectCue(Number(btn.dataset.goto));
      scrollToCue(state.selectedId);
    };
  });
}

/* ================= 弹窗（新增 / 编辑） ================= */

let editingId = null;
let modalDeps = [];     // {id?, depends_on, delay}
let originalDeps = [];

function openModal(cue) {
  editingId = cue ? cue.id : null;
  $('#modal-title').textContent = cue ? '编辑提示' : '新增提示';
  const f = $('#cue-form');
  f.department.value = cue ? cue.department : '';
  f.name.value = cue ? cue.name : '';
  f.duration.value = cue ? fmt(cue.duration) : '';
  f.locked_start.value = cue && cue.locked_start !== null ? fmt(cue.locked_start) : '';
  originalDeps = cue ? cue.dependencies.map((d) => ({ ...d })) : [];
  modalDeps = originalDeps.map((d) => ({ ...d }));
  $('#dept-list').innerHTML = state.departments.map((d) => `<option value="${esc(d)}">`).join('');
  renderModalDeps();
  $('#modal').classList.remove('hidden');
  f.name.focus();
}

function closeModal() {
  $('#modal').classList.add('hidden');
  editingId = null;
  modalDeps = [];
  originalDeps = [];
}

function renderModalDeps() {
  const ul = $('#dep-list');
  ul.innerHTML = modalDeps.map((d, i) =>
    `<li>${esc(nameOf(d.depends_on))} ＋延迟 ${fmt(d.delay)}
      <button type="button" class="link" data-i="${i}">✕</button></li>`
  ).join('') || '<li class="muted">无前置依赖</li>';
  ul.querySelectorAll('button').forEach((b) => {
    b.onclick = () => { modalDeps.splice(Number(b.dataset.i), 1); renderModalDeps(); };
  });
  const chosen = new Set(modalDeps.map((d) => d.depends_on));
  const options = state.cues.filter((c) => c.id !== editingId && !chosen.has(c.id));
  $('#dep-cue').innerHTML = options.map((c) =>
    `<option value="${c.id}">${esc(c.department)} / ${esc(c.name)}</option>`).join('');
}

async function onSubmit(e) {
  e.preventDefault();
  const f = e.target;
  const duration = parseTime(f.duration.value);
  const locked = parseTime(f.locked_start.value);
  if (!duration || duration < 1) { toast('时长无效：请输入正整数秒或 mm:ss'); return; }
  if (locked === undefined) { toast('锁定时间格式无效'); return; }
  const payload = {
    department: f.department.value.trim(),
    name: f.name.value.trim(),
    duration,
    locked_start: locked,
  };
  if (!payload.department || !payload.name) { toast('部门和名称不能为空'); return; }

  try {
    let cid = editingId;
    if (cid) await api.update(cid, payload);
    else cid = (await api.create(payload)).id;

    // 同步依赖：删掉移除的，加上新增的（成环会被后端拒绝）
    const removed = originalDeps.filter((od) => !modalDeps.some((d) => d.id === od.id));
    const added = modalDeps.filter((d) => !d.id);
    for (const d of removed) await api.removeDep(cid, d.id);
    for (const d of added) await api.addDep(cid, { depends_on: d.depends_on, delay: d.delay });

    closeModal();
    state.selectedId = cid;
    await refresh();
  } catch (err) {
    toast(err.message);
    await refresh(); // 部分修改可能已生效，刷新以保持一致
  }
}

/* ================= 缩放 ================= */

function setZoom(p) {
  state.pxPerSec = Math.min(60, Math.max(0.05, p));
  persistPrefs();
  renderTimeline();
  updateZoomLabel();
}

function updateZoomLabel() {
  $('#zoom-label').textContent = `${state.pxPerSec.toFixed(2).replace(/\.?0+$/, '')} px/s`;
}

/* ================= 事件绑定与初始化 ================= */

function bindEvents() {
  $('#btn-add').onclick = () => openModal(null);
  $('#modal-cancel').onclick = closeModal;
  $('#cue-form').addEventListener('submit', onSubmit);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  $('#dep-add-btn').onclick = () => {
    const id = Number($('#dep-cue').value);
    if (!id) { toast('请先选择前置提示'); return; }
    const delay = parseTime($('#dep-delay').value);
    if (delay === undefined) { toast('延迟格式无效'); return; }
    modalDeps.push({ depends_on: id, delay: delay ?? 0 });
    $('#dep-delay').value = '';
    renderModalDeps();
  };

  $('#filter-toggle').onclick = (e) => {
    e.stopPropagation();
    $('#filter-panel').classList.toggle('hidden');
  };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.filter')) $('#filter-panel').classList.add('hidden');
  });

  $('#zoom-in').onclick = () => setZoom(state.pxPerSec * 1.5);
  $('#zoom-out').onclick = () => setZoom(state.pxPerSec / 1.5);
  $('#zoom-fit').onclick = () => {
    const maxEnd = Math.max(60, ...state.cues.map((c) => c.end));
    setZoom((scroller.clientWidth - LABEL_W - 24) / (maxEnd + 60));
  };
  scroller.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const rect = scroller.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const t = (scroller.scrollLeft + mouseX - LABEL_W) / state.pxPerSec;
    setZoom(state.pxPerSec * (e.deltaY < 0 ? 1.2 : 1 / 1.2));
    scroller.scrollLeft = t * state.pxPerSec + LABEL_W - mouseX;
  }, { passive: false });
}

function renderAll() {
  renderFilter();
  renderTimeline();
  renderDetail();
  updateZoomLabel();
}

bindEvents();
refresh().catch((err) => toast(err.message));
