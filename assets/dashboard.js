/* dashboard.js — renders index.html */

const TAG_LABELS = {
  'healthcare': 'Healthcare',
  'ageing': 'Ageing',
  'tech-for-good': 'Tech for Good',
  'under-25': 'Under 25',
  'ai': 'AI Grant',
  'new-grad': 'New Grad',
};

const BUCKET_ORDER = ['within1', 'within2', 'within3', 'beyond', 'rolling'];

let ALL_GRANTS = [];
let ACTIVE_TAGS = new Set();
let SEARCH_Q = '';

async function init() {
  document.getElementById('markHolder').innerHTML = TCG.markSVG();
  wireActionLink();

  try {
    ALL_GRANTS = await TCG.fetchJSON('data/grants.json');
  } catch (e) {
    ALL_GRANTS = [];
    console.error(e);
  }

  try {
    const meta = await TCG.fetchJSON('data/last-crawl.json');
    document.getElementById('lastCrawl').textContent =
      new Date(meta.ranAt).toLocaleString('zh-CN', { timeZone: 'UTC' }) + ' (UTC)';
  } catch (e) {
    document.getElementById('lastCrawl').textContent = '尚未运行过每日抓取';
  }

  renderFilters();
  renderAll();

  document.getElementById('searchInput').addEventListener('input', (e) => {
    SEARCH_Q = e.target.value.trim().toLowerCase();
    renderAll();
  });
}

function wireActionLink() {
  const repo = TCG.detectRepo();
  const el = document.getElementById('actionLink');
  if (repo) {
    el.innerHTML = `<a href="https://github.com/${repo}/actions/workflows/daily-crawl.yml" target="_blank" rel="noopener">在 GitHub 上手动触发一次抓取 →</a>`;
  }
}

function renderFilters() {
  const box = document.getElementById('filters');
  Object.entries(TAG_LABELS).forEach(([tag, label]) => {
    const id = 'tag-' + tag;
    const el = document.createElement('label');
    el.className = 'tagbox';
    el.id = id;
    el.innerHTML = `<input type="checkbox" data-tag="${tag}"> ${label}`;
    el.querySelector('input').addEventListener('change', (e) => {
      if (e.target.checked) ACTIVE_TAGS.add(tag); else ACTIVE_TAGS.delete(tag);
      el.classList.toggle('on', e.target.checked);
      renderAll();
    });
    box.appendChild(el);
  });
}

function passesFilter(g) {
  if (ACTIVE_TAGS.size > 0) {
    const tags = g.tags || [];
    if (![...ACTIVE_TAGS].some(t => tags.includes(t))) return false;
  }
  if (SEARCH_Q) {
    const hay = (g.name + ' ' + (g.summary || '')).toLowerCase();
    if (!hay.includes(SEARCH_Q)) return false;
  }
  return true;
}

function isRecentlyNew(g) {
  if (!g.firstSeen) return false;
  const days = -TCG.daysUntil(g.firstSeen); // firstSeen is in the past, so daysUntil is negative
  return g.isNew || days <= 5;
}

function renderAll() {
  const container = document.getElementById('buckets');
  container.innerHTML = '';

  const visible = ALL_GRANTS.filter(passesFilter).filter(g => TCG.bucketFor(g.deadlineDate) !== 'expired');
  const total = ALL_GRANTS.length;
  const newTotal = ALL_GRANTS.filter(isRecentlyNew).length;
  document.getElementById('totalCount').textContent = total;
  document.getElementById('newCount').textContent = newTotal;

  const groups = {};
  BUCKET_ORDER.forEach(b => groups[b] = []);
  visible.forEach(g => {
    const b = TCG.bucketFor(g.deadlineDate);
    if (!groups[b]) groups[b] = [];
    groups[b].push(g);
  });

  BUCKET_ORDER.forEach(bucketKey => {
    const items = groups[bucketKey].sort((a, b) => (a.deadlineDate || '9999').localeCompare(b.deadlineDate || '9999'));
    const section = document.createElement('section');
    section.className = 'bucket';
    section.innerHTML = `
      <h2>${TCG.BUCKET_LABELS[bucketKey]} <span class="count">${items.length} 条</span></h2>
      <div class="rule"></div>
    `;
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '这个时间段内暂无匹配结果。';
      section.appendChild(empty);
    } else {
      items.forEach(g => section.appendChild(renderCard(g)));
    }
    container.appendChild(section);
  });
}

function renderCard(g) {
  const card = document.createElement('article');
  const isNew = isRecentlyNew(g);
  card.className = 'card' + (isNew ? ' is-new' : '') + (g.stale ? ' stale' : '');
  card.id = 'grant-' + g.id;

  const tagsHTML = (g.tags || []).map(t => `<span class="tag">${TAG_LABELS[t] || t}</span>`).join('')
    + (g.verified === false ? `<span class="tag unverified">待核实</span>` : '');

  const urgency = TCG.urgencyLevel(g.deadlineDate);
  const pulseHTML = `<span class="pulse" data-urgency="${urgency}"><i></i><i></i><i></i><i></i><i></i></span>`;
  const daysText = g.deadlineDate
    ? (TCG.daysUntil(g.deadlineDate) >= 0 ? `剩 ${TCG.daysUntil(g.deadlineDate)} 天` : '已过期')
    : '滚动 / 无固定截止';

  card.innerHTML = `
    <div class="card-top">
      <div style="flex:1">
        <h3>${TCG.escapeHTML(g.name)}</h3>
        <div class="tags">${tagsHTML}</div>
      </div>
    </div>
    <p class="summary">${TCG.escapeHTML(g.summary || '')}</p>
    ${g.deadlineHint ? `<p class="summary" style="color:var(--ink-soft);font-size:13px">${TCG.escapeHTML(g.deadlineHint)}</p>` : ''}
    <div class="meta-row">
      <div class="deadline">
        ${pulseHTML}
        <span class="days">${daysText}</span>
        ${g.deadlineDate ? ` · ${TCG.fmtDate(g.deadlineDate)}` : ''}
      </div>
      <div class="actions">
        <a class="btn ghost" href="${g.link}" target="_blank" rel="noopener">查看原文 →</a>
        <button class="btn ghost" data-act="edit">编辑</button>
        <a class="btn pink" href="tracker.html?id=${encodeURIComponent(g.id)}">开始跟踪申请 →</a>
      </div>
    </div>
    <form class="editform" data-form>
      <div class="full"><label>名称</label><input type="text" name="name" value="${attr(g.name)}"></div>
      <div><label>截止日期（留空 = 滚动申请）</label><input type="date" name="deadlineDate" value="${g.deadlineDate || ''}"></div>
      <div><label>标签（逗号分隔：healthcare, ageing, tech-for-good, under-25, ai, new-grad）</label><input type="text" name="tags" value="${(g.tags||[]).join(', ')}"></div>
      <div class="full"><label>截止日期备注</label><input type="text" name="deadlineHint" value="${attr(g.deadlineHint)}"></div>
      <div class="full"><label>摘要</label><textarea name="summary">${TCG.escapeHTML(g.summary || '')}</textarea></div>
      <div class="full"><label>链接</label><input type="url" name="link" value="${attr(g.link)}"></div>
      <div class="full chk"><label><input type="checkbox" name="verified" ${g.verified !== false ? 'checked' : ''}> 已人工核实</label></div>
      <div class="row-actions">
        <span class="save-status" style="font-family:var(--mono);font-size:11px;color:var(--ink-soft)"></span>
        <button type="button" class="btn ghost" data-act="cancel">取消</button>
        <button type="submit" class="btn">保存到 GitHub</button>
      </div>
    </form>
  `;

  card.querySelector('[data-act="edit"]').addEventListener('click', () => {
    card.querySelector('.editform').classList.toggle('open');
  });
  card.querySelector('[data-act="cancel"]').addEventListener('click', () => {
    card.querySelector('.editform').classList.remove('open');
  });
  card.querySelector('form[data-form]').addEventListener('submit', (e) => onSaveGrant(e, g.id));

  return card;
}

function attr(s) {
  return TCG.escapeHTML(s || '').replace(/"/g, '&quot;');
}

async function onSaveGrant(e, id) {
  e.preventDefault();
  const form = e.target;
  const status = form.querySelector('.save-status');
  const fd = new FormData(form);
  const patch = {
    name: fd.get('name').trim(),
    deadlineDate: fd.get('deadlineDate') || null,
    tags: fd.get('tags').split(',').map(s => s.trim()).filter(Boolean),
    deadlineHint: fd.get('deadlineHint').trim(),
    summary: fd.get('summary').trim(),
    link: fd.get('link').trim(),
    verified: !!fd.get('verified'),
  };

  status.textContent = '正在读取仓库…';
  try {
    const { json, sha } = await TCG.ghGetFile('data/grants.json');
    const list = json || ALL_GRANTS;
    const idx = list.findIndex(x => x.id === id);
    if (idx === -1) throw new Error('在仓库里找不到这条记录（可能刚被抓取脚本改动过），刷新页面后重试。');
    list[idx] = { ...list[idx], ...patch, isNew: false };
    status.textContent = '正在保存…';
    await TCG.ghPutFile('data/grants.json', list, sha, `edit grant: ${patch.name}`);
    status.textContent = '已保存 ✓（几秒后 GitHub Pages 会更新，刷新页面可见）';
    ALL_GRANTS = list;
    setTimeout(() => renderAll(), 800);
  } catch (err) {
    console.error(err);
    status.textContent = '';
    alert('保存失败：' + err.message + '\n\n如果还没设置 GitHub Token，请先前往「关键词与来源」页面填写。');
  }
}

init();
