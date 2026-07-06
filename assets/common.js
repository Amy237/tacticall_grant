/* ============================================================
   common.js — shared helpers for all three pages.
   No build step, no framework: plain browser JS, loaded via
   <script> tags. Everything here is safe to call multiple times.
   ============================================================ */

const TCG = (() => {

  /* ---------------- repo location ----------------
     On GitHub Pages a project site is served from
     https://OWNER.github.io/REPO/...  — we read owner/repo from
     the URL so nothing needs to be hardcoded. If you deploy on a
     custom domain, set window.TCG_REPO = "owner/repo" before
     these scripts load (see index.html for where to put it). */
  function detectRepo() {
    if (window.TCG_REPO) return window.TCG_REPO;
    const host = location.hostname; // owner.github.io
    const parts = location.pathname.split('/').filter(Boolean);
    const owner = host.endsWith('.github.io') ? host.split('.')[0] : null;
    const repo = parts[0] || null;
    if (owner && repo) return `${owner}/${repo}`;
    return localStorage.getItem('tcg_repo_override') || '';
  }

  function getBranch() {
    return localStorage.getItem('tcg_branch') || 'main';
  }

  function getToken() {
    return localStorage.getItem('tcg_gh_token') || '';
  }
  function setToken(t) {
    if (t) localStorage.setItem('tcg_gh_token', t);
    else localStorage.removeItem('tcg_gh_token');
  }
  function setRepoOverride(r) {
    if (r) localStorage.setItem('tcg_repo_override', r);
    else localStorage.removeItem('tcg_repo_override');
  }
  function setBranch(b) {
    if (b) localStorage.setItem('tcg_branch', b);
    else localStorage.removeItem('tcg_branch');
  }

  /* ---------------- GitHub Contents API ----------------
     Used by the "保存到 GitHub" buttons on the keywords/settings
     page, the grant editor, and the tracker. Requires a
     fine-grained Personal Access Token with **Contents:
     Read and write** on this one repo, pasted by the person and
     kept only in this browser's localStorage — it is sent
     directly to api.github.com and nowhere else. */

  async function ghGetFile(path) {
    const repo = detectRepo();
    if (!repo) throw new Error('无法识别仓库（owner/repo），请在设置页手动填写。');
    const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=${getBranch()}`, {
      headers: authHeaders(),
      cache: 'no-store',
    });
    if (res.status === 404) return { json: null, sha: null };
    if (!res.ok) throw new Error(`读取 ${path} 失败：${res.status}`);
    const data = await res.json();
    const text = decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))));
    return { json: JSON.parse(text), sha: data.sha };
  }

  async function ghPutFile(path, obj, sha, message) {
    const repo = detectRepo();
    const token = getToken();
    if (!repo) throw new Error('无法识别仓库（owner/repo）。');
    if (!token) throw new Error('还没有填写 GitHub Token，无法直接保存——见下方说明。');
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(obj, null, 2) + '\n')));
    const body = {
      message: message || `update ${path} via Grant Radar UI`,
      content,
      branch: getBranch(),
    };
    if (sha) body.sha = sha;
    const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
      method: 'PUT',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`保存 ${path} 失败：${res.status} ${t.slice(0, 200)}`);
    }
    return res.json();
  }

  function authHeaders() {
    const h = { Accept: 'application/vnd.github+json' };
    const t = getToken();
    if (t) h.Authorization = `Bearer ${t}`;
    return h;
  }

  /* ---------------- plain JSON fetch (read-only, no token needed) ----------------
     Used for the initial page render — reads the files GitHub Pages
     already serves as static assets. This always works, token or not. */
  async function fetchJSON(path) {
    const res = await fetch(path + '?_=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error(`读取 ${path} 失败：${res.status}`);
    return res.json();
  }

  /* ---------------- date / bucket helpers ---------------- */

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  function daysUntil(iso) {
    if (!iso) return null;
    const now = new Date(todayISO() + 'T00:00:00Z').getTime();
    const target = new Date(iso + 'T00:00:00Z').getTime();
    return Math.round((target - now) / 86400000);
  }

  function bucketFor(iso) {
    if (!iso) return 'rolling';
    const d = daysUntil(iso);
    if (d < 0) return 'expired';
    if (d <= 30) return 'within1';
    if (d <= 60) return 'within2';
    if (d <= 90) return 'within3';
    return 'beyond';
  }

  const BUCKET_LABELS = {
    within1: '1 个月内',
    within2: '1–2 个月内',
    within3: '2–3 个月内',
    beyond: '3 个月外',
    rolling: '无固定截止 / 滚动申请',
    expired: '已过期',
  };

  function urgencyLevel(iso) {
    if (!iso) return 0;
    const d = daysUntil(iso);
    if (d < 0) return 0;
    if (d <= 7) return 4;
    if (d <= 14) return 3;
    if (d <= 30) return 2;
    if (d <= 60) return 1;
    return 0;
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso + 'T00:00:00Z');
    return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  }

  /* best-effort "23 August 2026" style text -> ISO date, used both
     by the crawler (Node) and here (browser) so a person can also
     re-run parsing on a hint they edit by hand. */
  const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  function parseLooseDate(text) {
    if (!text) return null;
    const m = text.match(/(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(20\d{2})/i);
    if (!m) return null;
    const day = parseInt(m[1], 10);
    const month = MONTHS.indexOf(m[2].toLowerCase());
    const year = parseInt(m[3], 10);
    const d = new Date(Date.UTC(year, month, day));
    return d.toISOString().slice(0, 10);
  }

  function slugify(s) {
    return (s || '')
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 60) || 'item';
  }

  function escapeHTML(s) {
    return (s || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /* small inline SVG mark used in the header — concentric arcs,
     standing in for a sound/vibration pulse radiating outward. */
  function markSVG() {
    return `<svg viewBox="0 0 40 40" class="mark" aria-hidden="true">
      <circle cx="20" cy="20" r="4" fill="#1C1A16"/>
      <circle cx="20" cy="20" r="10" fill="none" stroke="#1C1A16" stroke-width="2.2"/>
      <circle cx="20" cy="20" r="17" fill="none" stroke="#1C1A16" stroke-width="2.2" opacity="0.55"/>
    </svg>`;
  }

  return {
    detectRepo, getBranch, getToken, setToken, setRepoOverride, setBranch,
    ghGetFile, ghPutFile, fetchJSON,
    todayISO, daysUntil, bucketFor, BUCKET_LABELS, urgencyLevel, fmtDate, parseLooseDate,
    slugify, escapeHTML, markSVG,
  };
})();
