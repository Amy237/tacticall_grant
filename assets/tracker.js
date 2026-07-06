/* tracker.js — renders tracker.html */

const PX_PER_DAY = 26;

let GRANTS = [];
let GRANT = null;
let TASKS = [];

function qs(name) {
  return new URLSearchParams(location.search).get(name);
}

async function init() {
  document.getElementById('markHolder').innerHTML = TCG.markSVG();

  try { GRANTS = await TCG.fetchJSON('data/grants.json'); } catch (e) { GRANTS = []; }

  const id = qs('id');
  if (!id) {
    await showPicker();
  } else {
    await showTracker(id);
  }
}

/* ---------------- picker (no grant selected yet) ---------------- */

async function showPicker() {
  document.getElementById('pickerPanel').style.display = 'block';
  document.getElementById('trackerPanel').style.display = 'none';

  const sel = document.getElementById('grantPicker');
  sel.innerHTML = GRANTS.map(g => `<option value="${g.id}">${TCG.escapeHTML(g.name)}</option>`).join('');
  document.getElementById('pickBtn').addEventListener('click', () => {
    location.href = 'tracker.html?id=' + encodeURIComponent(sel.value);
  });

  const box = document.getElementById('existingTrackers');
  const ids = new Set();
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k.startsWith('tcg_tracker_')) ids.add(k.replace('tcg_tracker_', ''));
  }
  let remote = {};
  try {
    const { json } = await TCG.ghGetFile('data/trackers.json');
    if (json) Object.keys(json).forEach(k => ids.add(k));
    remote = json || {};
  } catch (e) { /* no token / no file yet — fine, local list still works */ }

  if (ids.size === 0) {
    box.innerHTML = '<p class="hint">还没有任何跟踪记录。</p>';
    return;
  }

  box.innerHTML = '';
  ids.forEach(id => {
    const local = readLocal(id);
    const tasks = (local && local.tasks) || (remote[id] && remote[id].tasks) || [];
    const done = tasks.filter(t => t.status === 'done').length;
    const grant = GRANTS.find(g => g.id === id);
    const row = document.createElement('div');
    row.className = 'card';
    row.style.marginBottom = '10px';
    row.innerHTML = `
      <div class="card-top">
        <div>
          <h3 style="font-size:15px">${TCG.escapeHTML(grant ? grant.name : id)}</h3>
          <p class="summary">${tasks.length ? `${done} / ${tasks.length} 项任务已完成` : '尚未添加任务'}</p>
        </div>
        <a class="btn ghost" href="tracker.html?id=${encodeURIComponent(id)}">打开 →</a>
      </div>
    `;
    box.appendChild(row);
  });
}

function readLocal(id) {
  try {
    const raw = localStorage.getItem('tcg_tracker_' + id);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

/* ---------------- tracker (grant selected) ---------------- */

async function showTracker(id) {
  document.getElementById('pickerPanel').style.display = 'none';
  document.getElementById('trackerPanel').style.display = 'block';

  GRANT = GRANTS.find(g => g.id === id) || { id, name: id, link: '#', deadlineDate: null };
  document.getElementById('grantName').textContent = GRANT.name;
  document.getElementById('grantLink').href = GRANT.link || '#';
  document.getElementById('grantDeadline').textContent = GRANT.deadlineDate ? TCG.fmtDate(GRANT.deadlineDate) : '滚动 / 无固定截止';

  const local = readLocal(id);
  if (local && local.tasks && local.tasks.length) {
    TASKS = local.tasks;
  } else {
    try {
      const { json } = await TCG.ghGetFile('data/trackers.json');
      TASKS = (json && json[id] && json[id].tasks) || [];
    } catch (e) { TASKS = []; }
  }

  renderTaskList();
  renderGantt();

  document.getElementById('addTaskBtn').addEventListener('click', () => {
    const today = TCG.todayISO();
    TASKS.push({ id: 't' + Date.now(), name: '新任务', start: today, end: today, status: 'todo' });
    renderTaskList();
    renderGantt();
  });

  document.getElementById('templateBtn').addEventListener('click', () => {
    if (TASKS.length && !confirm('这会替换掉当前的任务清单，确定吗？')) return;
    TASKS = defaultTasks();
    renderTaskList();
    renderGantt();
  });

  document.getElementById('saveLocalBtn').addEventListener('click', saveLocal);
  document.getElementById('saveGithubBtn').addEventListener('click', saveGithub);
}

function addDaysISO(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function defaultTasks() {
  const steps = [
    ['通读完整申请要求与资格条件', 2],
    ['起草项目 / 方案说明', 5],
    ['整理预算与财务材料', 3],
    ['收集支持信 / 推荐信 / 合作方证明', 5],
    ['内部或导师审阅反馈', 3],
    ['根据反馈修改定稿', 3],
    ['正式提交', 1],
  ];
  let cursor = TCG.todayISO();
  return steps.map(([name, days], i) => {
    const start = cursor;
    const end = addDaysISO(cursor, Math.max(days - 1, 0));
    cursor = addDaysISO(cursor, days);
    return { id: 't' + i + '-' + Date.now(), name, start, end, status: 'todo' };
  });
}

function renderTaskList() {
  const box = document.getElementById('taskList');
  box.innerHTML = '';
  TASKS.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'taskrow';
    row.innerHTML = `
      <input type="text" value="${TCG.escapeHTML(t.name)}" data-f="name">
      <input type="date" value="${t.start}" data-f="start">
      <input type="date" value="${t.end}" data-f="end">
      <select data-f="status">
        <option value="todo" ${t.status === 'todo' ? 'selected' : ''}>未开始</option>
        <option value="progress" ${t.status === 'progress' ? 'selected' : ''}>进行中</option>
        <option value="done" ${t.status === 'done' ? 'selected' : ''}>已完成</option>
      </select>
      <button class="del" aria-label="删除任务" data-i="${i}">×</button>
    `;
    row.querySelectorAll('[data-f]').forEach(input => {
      input.addEventListener('input', () => {
        TASKS[i][input.dataset.f] = input.value;
        renderGantt();
      });
    });
    row.querySelector('.del').addEventListener('click', () => {
      TASKS.splice(i, 1);
      renderTaskList();
      renderGantt();
    });
    box.appendChild(row);
  });
}

function dayIdx(iso) {
  return Math.floor(new Date(iso + 'T00:00:00Z').getTime() / 86400000);
}

function renderGantt() {
  const container = document.getElementById('ganttChart');
  container.innerHTML = '';

  if (TASKS.length === 0) {
    container.innerHTML = '<p class="hint" style="padding:16px">先加几个任务，或者点「使用默认模板」，时间线会出现在这里。</p>';
    return;
  }

  const todayIdx = dayIdx(TCG.todayISO());
  let startIdx = Math.min(todayIdx, ...TASKS.map(t => dayIdx(t.start)));
  let endIdx = Math.max(todayIdx + 7, ...TASKS.map(t => dayIdx(t.end)));
  if (GRANT.deadlineDate) endIdx = Math.max(endIdx, dayIdx(GRANT.deadlineDate));
  startIdx -= 2;
  endIdx += 2;

  const totalDays = endIdx - startIdx + 1;
  const totalWidth = totalDays * PX_PER_DAY;

  const header = document.createElement('div');
  header.className = 'gantt-header';
  header.style.width = totalWidth + 'px';
  for (let d = startIdx; d <= endIdx; d += 7) {
    const cellDays = Math.min(7, endIdx - d + 1);
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.style.width = (cellDays * PX_PER_DAY) + 'px';
    const date = new Date(d * 86400000);
    cell.textContent = date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', timeZone: 'UTC' });
    header.appendChild(cell);
  }

  const body = document.createElement('div');
  body.className = 'gantt-body';
  body.style.width = totalWidth + 'px';

  TASKS.forEach(t => {
    const row = document.createElement('div');
    row.className = 'gantt-row';
    row.style.width = totalWidth + 'px';

    const grid = document.createElement('div');
    grid.className = 'grid-bg';
    grid.style.backgroundSize = `${PX_PER_DAY}px 100%`;
    row.appendChild(grid);

    const s = dayIdx(t.start), e = dayIdx(t.end);
    const bar = document.createElement('div');
    bar.className = 'gantt-bar status-' + (t.status || 'todo');
    bar.style.left = ((s - startIdx) * PX_PER_DAY) + 'px';
    bar.style.width = Math.max(((e - s + 1) * PX_PER_DAY) - 4, 18) + 'px';
    bar.title = `${t.name}: ${t.start} → ${t.end}`;
    bar.textContent = t.name;
    row.appendChild(bar);

    body.appendChild(row);
  });

  // today marker
  const todayLine = document.createElement('div');
  todayLine.style.position = 'absolute';
  todayLine.style.top = '0';
  todayLine.style.bottom = '0';
  todayLine.style.left = ((todayIdx - startIdx) * PX_PER_DAY) + 'px';
  todayLine.style.borderLeft = '1.5px solid var(--ink)';
  todayLine.style.opacity = '0.5';
  body.appendChild(todayLine);

  // deadline marker
  if (GRANT.deadlineDate) {
    const dIdx = dayIdx(GRANT.deadlineDate);
    const line = document.createElement('div');
    line.className = 'deadline-line';
    line.style.left = ((dIdx - startIdx) * PX_PER_DAY) + 'px';
    const label = document.createElement('div');
    label.className = 'deadline-label';
    label.style.left = ((dIdx - startIdx) * PX_PER_DAY) + 'px';
    label.textContent = '截止 ' + TCG.fmtDate(GRANT.deadlineDate);
    line.appendChild(label);
    body.appendChild(line);
  }

  body.style.position = 'relative';
  container.appendChild(header);
  container.appendChild(body);
}

function saveLocal() {
  localStorage.setItem('tcg_tracker_' + GRANT.id, JSON.stringify({ tasks: TASKS, savedAt: new Date().toISOString() }));
  const s = document.getElementById('saveStatus');
  s.textContent = '已保存到本地浏览器 ✓';
  setTimeout(() => (s.textContent = ''), 3000);
}

async function saveGithub() {
  const s = document.getElementById('saveStatus');
  s.textContent = '正在同步…';
  try {
    saveLocal();
    const { json, sha } = await TCG.ghGetFile('data/trackers.json');
    const all = json || {};
    all[GRANT.id] = { grantName: GRANT.name, tasks: TASKS, savedAt: new Date().toISOString() };
    await TCG.ghPutFile('data/trackers.json', all, sha, `update tracker: ${GRANT.name}`);
    s.textContent = '已同步到 GitHub ✓';
  } catch (err) {
    console.error(err);
    s.textContent = '';
    alert('同步失败：' + err.message + '\n\n本地浏览器里的记录已经保存好了，不会丢；填好 GitHub Token 后可以再试一次同步。');
  }
}

init();
