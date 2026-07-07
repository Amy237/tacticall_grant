/**
 * scripts/crawl.mjs
 * -------------------------------------------------------------
 * Best-effort daily crawler for the TactiCall Grant Radar.
 *
 * What it actually does:
 *   1. Reads data/keywords.json and data/sources.json.
 *   2. Per source, depending on its "type":
 *        - (default/"page") fetches the URL as plain HTML (no
 *          headless browser — so JS-rendered pages will yield little
 *          or nothing; known limitation, not a bug — see README),
 *          splits it into heading -> following-text sections, and
 *          checks whether any keyword appears in that section.
 *        - "search" runs a fixed query against the Brave Search API.
 *        - "claude" asks the Anthropic API (with its web_search tool)
 *          to actually go search and judge relevance semantically,
 *          instead of literal keyword matching — see
 *          crawlClaudeSource() below for why this exists.
 *   3. Extracts a loose "deadline hint" via regex if one is nearby
 *      (for "claude" sources, the model reports this itself instead).
 *   4. Merges matches into data/grants.json:
 *        - new match  -> appended, isNew:true, firstSeen:today
 *        - seen before -> lastSeen updated, isNew:false
 *        - not re-found in 45+ days -> flagged stale:true (not deleted)
 *
 * This is intentionally a heuristic lead-generator, not an
 * authoritative scraper. Every auto-added entry is source:"auto",
 * verified:false, and shows a "待核实" badge on the dashboard until
 * a person confirms it (which also flips verified:true through the
 * dashboard's inline editor).
 * -------------------------------------------------------------
 */

import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import * as cheerio from 'cheerio';

const KEYWORDS_PATH = 'data/keywords.json';
const SOURCES_PATH = 'data/sources.json';
const GRANTS_PATH = 'data/grants.json';
const LAST_CRAWL_PATH = 'data/last-crawl.json';

const STALE_AFTER_DAYS = 45;
const FETCH_TIMEOUT_MS = 20000;
const MAX_SECTIONS_PER_SOURCE = 40;

function hashId(str) {
  return crypto.createHash('sha1').update(str).digest('hex').slice(0, 12);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(aISO, bISO) {
  const a = new Date(aISO + 'T00:00:00Z').getTime();
  const b = new Date(bISO + 'T00:00:00Z').getTime();
  return Math.round((b - a) / 86400000);
}

const MONTHS = ['january','february','march','april','may','june','july','august',
  'september','october','november','december'];

function parseLooseDate(text) {
  if (!text) return null;
  const m = text.match(/(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(20\d{2})/i);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = MONTHS.indexOf(m[2].toLowerCase());
  const year = parseInt(m[3], 10);
  if (month < 0) return null;
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

function extractDeadlineHint(text) {
  const patterns = [
    /\b(deadline|closes?|closing date)[:\s]{0,10}[^.\n]{0,90}/i,
    /\b\d{1,2}\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+20\d{2}\b/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[0].trim().replace(/\s+/g, ' ').slice(0, 160);
  }
  return null;
}

async function fetchWithTimeout(url, ms, extraHeaders = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'TactiCallGrantRadar/1.0 (+personal research tool; contact via github issues)',
        'Accept': 'text/html',
        ...extraHeaders,
      },
    });
  } finally {
    clearTimeout(t);
  }
}

async function crawlSource(source, keywords) {
  const res = await fetchWithTimeout(source.url, FETCH_TIMEOUT_MS);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const headings = $('h1, h2, h3, h4').toArray().slice(0, MAX_SECTIONS_PER_SOURCE);
  const candidates = [];

  headings.forEach((h) => {
    const $h = $(h);
    const title = $h.text().trim().replace(/\s+/g, ' ');
    if (!title || title.length < 4 || title.length > 200) return;

    let text = '';
    let el = $h.next();
    let guard = 0;
    while (el.length && !/^h[1-4]$/i.test((el.prop('tagName') || '')) && guard < 25) {
      text += ' ' + el.text();
      el = el.next();
      guard++;
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) return;

    const hay = (title + ' ' + text).toLowerCase();
    const matched = keywords.filter(k => hay.includes(k.toLowerCase()));
    if (matched.length === 0) return;

    candidates.push({
      title,
      snippet: text.slice(0, 320),
      matchedKeywords: matched,
      deadlineHint: extractDeadlineHint(title + '. ' + text),
      url: source.url,
      sourceId: source.id,
      sourceName: source.name,
    });
  });

  return candidates;
}

/**
 * "search" sources don't point at a single page — they run a fixed
 * query against the Brave Search API (needs a BRAVE_API_KEY repo
 * secret; see README). This exists because a plain fetch() against
 * Google/Bing/DuckDuckGo's result pages was tested directly and gets
 * blocked by bot-detection every time, even with a normal browser
 * User-Agent — there's no server-rendered-HTML workaround for that,
 * so a real search API is the only option. If the key isn't set, the
 * source is skipped (throws, caught by the per-source try/catch in
 * main() same as any other fetch failure) rather than breaking the
 * whole crawl run.
 */
async function crawlSearchSource(source, keywords) {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) {
    throw new Error('BRAVE_API_KEY not set — add it as a repo secret to enable this source (see README)');
  }
  const endpoint = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(source.query)}&count=20`;
  const res = await fetchWithTimeout(endpoint, FETCH_TIMEOUT_MS, {
    Accept: 'application/json',
    'X-Subscription-Token': apiKey,
  });
  if (!res.ok) throw new Error(`Brave Search HTTP ${res.status}`);
  const data = await res.json();
  const results = (data.web && data.web.results) || [];

  const candidates = [];
  for (const r of results) {
    const title = (r.title || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const text = (r.description || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!title || !r.url) continue;

    const hay = (title + ' ' + text).toLowerCase();
    const matched = keywords.filter(k => hay.includes(k.toLowerCase()));
    if (matched.length === 0) continue;

    candidates.push({
      title,
      snippet: text.slice(0, 320),
      matchedKeywords: matched,
      deadlineHint: extractDeadlineHint(title + '. ' + text),
      url: r.url,
      sourceId: source.id,
      sourceName: source.name,
    });
  }
  return candidates;
}

const TAG_WHITELIST = new Set(['healthcare', 'ageing', 'tech-for-good', 'under-25', 'ai', 'new-grad']);

function buildClaudePrompt(knownNames) {
  return `You are helping a startup founder research non-dilutive funding opportunities (grants, accelerator programmes, innovation competitions, fellowships, prizes).

About the startup — TactiCall: a wearable device that detects household notification sounds (doorbell, smoke alarm, oven timer, etc.) and alerts Deaf / hard-of-hearing (D/HH) users via distinct wrist vibration patterns, without needing per-room hardware installs. Positioned as consumer electronics, not a medical device. Solo-founder stage, UK-based, incubated at UAL Greenhouse, applying to accelerators like Bethnal Green Ventures.

Task: use web search to find CURRENTLY OPEN or clearly upcoming funding opportunities this startup could realistically apply to. Prioritize, in roughly this order: UK-based or UK-founder-eligible programmes; accessibility / assistive technology / hearing loss / Deaf community focus; tech-for-good / social enterprise; deep tech / hardware startups; AI-in-accessibility. Also worth considering: ageing/elderly tech, disability inclusion, healthtech (non-medical-device framing), women or under-represented founders, new graduate / student entrepreneur schemes, Innovate UK / UKRI / Horizon Europe calls.

Run several distinct searches with genuinely different phrasing and angles (not just one query) — the way a person doing real due diligence would search multiple times, not the way a single keyword lookup would. Use your judgement on which programmes are real vs. expired vs. rumour; only report something if you found a real, currently-reachable page for it.

Opportunities already tracked — do not re-report these, focus on anything not in this list:
${knownNames || '(none yet)'}

When you are done researching, your FINAL reply must be ONLY a raw JSON array (no markdown code fences, no commentary before or after) of up to 20 objects, each shaped exactly like this:
{"title": string, "url": string, "summary": string (1-3 sentences, in Chinese, plain description of what it is and who it's for), "deadlineHint": string or null (any deadline wording you found, in its original language), "tags": array containing zero or more of "healthcare", "ageing", "tech-for-good", "under-25", "ai", "new-grad"}

Only include opportunities you found real evidence for via search (a working, specific URL — not a homepage). Do not invent anything. If you find fewer than 20 genuine opportunities, return fewer. If you find none, return [].`;
}

function extractJSONArray(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}

/**
 * "claude" sources use the Anthropic API's built-in web_search tool so
 * the model can actually search the live web and judge relevance the
 * way a person would, instead of the literal keyword-substring
 * matching every other source relies on. This exists because that
 * substring matching was diagnosed as the main cause of missed leads
 * (e.g. UnLtd and RAEng pages have real, relevant funding copy that
 * simply never contains an exact phrase from data/keywords.json).
 *
 * Needs an ANTHROPIC_API_KEY repo secret (see README) — this is a
 * paid API, separate from any Claude Code subscription, and the
 * web_search tool itself is billed per search on top of normal token
 * costs, so max_uses below caps it to a predictable, small daily
 * spend. If the key isn't set, this source is skipped like any other
 * source-level failure.
 */
async function crawlClaudeSource(source, grants) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set — add it as a repo secret to enable this source (see README)');
  }

  const knownNames = grants.slice(0, 60).map(g => g.name).join(' | ');
  const prompt = buildClaudePrompt(knownNames);

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 120000);
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 8000,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude API HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text);
  const lastText = textBlocks[textBlocks.length - 1] || '';
  const jsonSlice = extractJSONArray(lastText);
  if (!jsonSlice) throw new Error('Claude did not return a parseable JSON array');

  let items;
  try {
    items = JSON.parse(jsonSlice);
  } catch (e) {
    throw new Error(`Could not parse Claude's JSON output: ${e.message}`);
  }
  if (!Array.isArray(items)) throw new Error('Claude output was not a JSON array');

  return items
    .filter(it => it && it.title && it.url)
    .slice(0, 20)
    .map(it => ({
      title: String(it.title).trim(),
      snippet: String(it.summary || '').trim().slice(0, 320),
      matchedKeywords: ['claude-web-search'],
      deadlineHint: it.deadlineHint || null,
      url: it.url,
      tags: Array.isArray(it.tags) ? it.tags.filter(tg => TAG_WHITELIST.has(tg)) : [],
      sourceId: source.id,
      sourceName: source.name,
    }));
}

async function main() {
  const keywords = JSON.parse(await readFile(KEYWORDS_PATH, 'utf8'));
  const sources = JSON.parse(await readFile(SOURCES_PATH, 'utf8'));
  const grants = JSON.parse(await readFile(GRANTS_PATH, 'utf8'));
  const byId = new Map(grants.map(g => [g.id, g]));

  // "minDaysBetweenRuns" on a source (e.g. the paid Claude source) lets
  // it skip most days instead of running with every daily crawl — read
  // back when each source last actually ran from the previous
  // last-crawl.json so this survives across runs.
  let sourceLastRun = {};
  try {
    const prev = JSON.parse(await readFile(LAST_CRAWL_PATH, 'utf8'));
    sourceLastRun = prev.sourceLastRun || {};
  } catch (e) { /* no previous run log yet — fine */ }

  const todayStr = today();
  const runLog = [];
  let totalCandidates = 0;

  for (const source of sources) {
    const minGap = source.minDaysBetweenRuns || 0;
    const lastRun = sourceLastRun[source.id];
    if (minGap > 0 && lastRun && daysBetween(lastRun, todayStr) < minGap) {
      runLog.push({
        source: source.name,
        ok: true,
        matches: 0,
        skipped: true,
        reason: `throttled — last ran ${lastRun}, runs every ${minGap} day(s)`,
      });
      continue;
    }

    try {
      const found = source.type === 'search'
        ? await crawlSearchSource(source, keywords)
        : source.type === 'claude'
        ? await crawlClaudeSource(source, grants)
        : await crawlSource(source, keywords);
      totalCandidates += found.length;
      runLog.push({ source: source.name, ok: true, matches: found.length });
      sourceLastRun[source.id] = todayStr;

      for (const c of found) {
        const id = 'auto-' + hashId(c.sourceId + '::' + c.title.toLowerCase());
        const existing = byId.get(id);
        const parsedDate = parseLooseDate(c.deadlineHint);

        if (existing) {
          existing.lastSeen = today();
          existing.snippet = existing.verified ? existing.summary : c.snippet;
          if (!existing.verified) {
            existing.summary = c.snippet;
            existing.deadlineHint = c.deadlineHint || existing.deadlineHint;
            if (parsedDate && !existing.deadlineDateLocked) existing.deadlineDate = parsedDate;
          }
          existing.matchedKeywords = c.matchedKeywords;
          existing.stale = false;
        } else {
          const fresh = {
            id,
            name: c.title,
            tags: c.tags || [],
            deadlineDate: parsedDate,
            deadlineHint: c.deadlineHint,
            summary: c.snippet,
            link: c.url,
            source: 'auto',
            verified: false,
            matchedKeywords: c.matchedKeywords,
            firstSeen: today(),
            lastSeen: today(),
            isNew: true,
            stale: false,
          };
          grants.push(fresh);
          byId.set(id, fresh);
        }
      }
    } catch (err) {
      runLog.push({ source: source.name, ok: false, error: String(err.message || err) });
      console.warn(`[skip] ${source.name}: ${err.message || err}`);
    }
  }

  // clear isNew flag on anything older than 5 days so the dashboard
  // highlight fades naturally even without a person editing it
  const fiveDaysAgo = Date.now() - 5 * 86400000;
  for (const g of grants) {
    if (g.isNew && g.firstSeen && new Date(g.firstSeen).getTime() < fiveDaysAgo) {
      g.isNew = false;
    }
  }

  // flag auto entries not re-confirmed recently as stale (visual only)
  const staleCutoff = Date.now() - STALE_AFTER_DAYS * 86400000;
  for (const g of grants) {
    if (g.source === 'auto') {
      g.stale = g.lastSeen ? new Date(g.lastSeen).getTime() < staleCutoff : true;
    }
  }

  grants.sort((a, b) => (a.deadlineDate || '9999-99-99').localeCompare(b.deadlineDate || '9999-99-99'));

  await writeFile(GRANTS_PATH, JSON.stringify(grants, null, 2) + '\n');
  await writeFile(LAST_CRAWL_PATH, JSON.stringify({
    ranAt: new Date().toISOString(),
    sourcesChecked: sources.length,
    candidatesFound: totalCandidates,
    totalGrants: grants.length,
    log: runLog,
    sourceLastRun,
  }, null, 2) + '\n');

  console.log(`Done. ${sources.length} source(s) checked, ${totalCandidates} candidate match(es), ${grants.length} grant(s) total.`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { crawlSource, crawlSearchSource, crawlClaudeSource, extractDeadlineHint, parseLooseDate, hashId };
