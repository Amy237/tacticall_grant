/* settings.js — renders keywords.html */

let KEYWORDS = [];
let SOURCES = [];

function init() {
  document.getElementById('markHolder').innerHTML = TCG.markSVG();

  document.getElementById('repoInput').value = TCG.detectRepo();
  document.getElementById('branchInput').value = TCG.getBranch();
  document.getElementById('tokenInput').value = TCG.getToken();

  document.getElementById('saveConnBtn').addEventListener('click', () => {
    TCG.setRepoOverride(document.getElementById('repoInput').value.trim());
    TCG.setBranch(document.getElementById('branchInput').value.trim());
    TCG.setToken(document.getElementById('tokenInput').value.trim());
    const el = document.getElementById('connStatus');
    el.textContent = '已保存到这台设备的浏览器 ✓';
    setTimeout(() => (el.textContent = ''), 3000);
  });

  loadKeywords();
  loadSources();

  document.getElementById('kwAddBtn').addEventListener('click', () => {
    const input = document.getElementById('kwInput');
    const v = input.value.trim();
    if (v && !KEYWORDS.includes(v)) {
      KEYWORDS.push(v);
      input.value = '';
      renderKeywords();
    }
  });
  document.getElementById('kwInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('kwAddBtn').click(); }
  });
  document.getElementById('kwSaveBtn').addEventListener('click', saveKeywords);

  document.getElementById('srcAddBtn').addEventListener('click', () => {
    const name = document.getElementById('srcNameInput');
    const url = document.getElementById('srcUrlInput');
    if (name.value.trim() && url.value.trim()) {
      SOURCES.push({ id: TCG.slugify(name.value), name: name.value.trim(), url: url.value.trim(), note: '手动添加' });
      name.value = ''; url.value = '';
      renderSources();
    }
  });
  document.getElementById('srcSaveBtn').addEventListener('click', saveSources);
}

async function loadKeywords() {
  try {
    KEYWORDS = await TCG.fetchJSON('data/keywords.json');
  } catch (e) { KEYWORDS = []; }
  renderKeywords();
}

async function loadSources() {
  try {
    SOURCES = await TCG.fetchJSON('data/sources.json');
  } catch (e) { SOURCES = []; }
  renderSources();
}

function renderKeywords() {
  const box = document.getElementById('kwList');
  box.innerHTML = '';
  KEYWORDS.forEach((kw, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `${TCG.escapeHTML(kw)} <button aria-label="删除">×</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      KEYWORDS.splice(i, 1);
      renderKeywords();
    });
    box.appendChild(chip);
  });
}

function renderSources() {
  const box = document.getElementById('srcList');
  box.innerHTML = '';
  SOURCES.forEach((src, i) => {
    const row = document.createElement('div');
    row.className = 'chip';
    row.style.display = 'flex';
    row.style.width = '100%';
    row.style.marginBottom = '8px';
    row.style.justifyContent = 'space-between';
    row.innerHTML = `
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:80%">
        <strong>${TCG.escapeHTML(src.name)}</strong> — <a href="${src.url}" target="_blank" rel="noopener" style="color:var(--ink-soft)">${TCG.escapeHTML(src.url)}</a>
      </span>
      <button aria-label="删除">×</button>
    `;
    row.querySelector('button').addEventListener('click', () => {
      SOURCES.splice(i, 1);
      renderSources();
    });
    box.appendChild(row);
  });
}

async function saveKeywords() {
  const status = document.getElementById('kwSaveStatus');
  const banner = document.getElementById('kwBanner');
  status.textContent = '正在保存…';
  try {
    const { sha } = await TCG.ghGetFile('data/keywords.json');
    await TCG.ghPutFile('data/keywords.json', KEYWORDS, sha, 'update keywords via settings UI');
    status.textContent = '已保存 ✓';
    banner.innerHTML = '<div class="banner ok">关键词已更新，明天的自动抓取会用上新词表。</div>';
  } catch (err) {
    status.textContent = '';
    banner.innerHTML = `<div class="banner err">保存失败：${TCG.escapeHTML(err.message)}</div>`;
  }
}

async function saveSources() {
  const status = document.getElementById('srcSaveStatus');
  const banner = document.getElementById('srcBanner');
  status.textContent = '正在保存…';
  try {
    const { sha } = await TCG.ghGetFile('data/sources.json');
    await TCG.ghPutFile('data/sources.json', SOURCES, sha, 'update sources via settings UI');
    status.textContent = '已保存 ✓';
    banner.innerHTML = '<div class="banner ok">来源列表已更新。</div>';
  } catch (err) {
    status.textContent = '';
    banner.innerHTML = `<div class="banner err">保存失败：${TCG.escapeHTML(err.message)}</div>`;
  }
}

init();
