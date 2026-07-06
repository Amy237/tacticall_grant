/**
 * scripts/crawl.mjs
 * -------------------------------------------------------------
 * Best-effort daily crawler for the TactiCall Grant Radar.
 *
 * What it actually does:
 *   1. Reads data/keywords.json and data/sources.json.
 *   2. Fetches each source URL as plain HTML (no headless browser —
 *      so JS-rendered pages will yield little or nothing; that's a
 *      known limitation, not a bug — see README).
 *   3. Splits each page into heading -> following-text sections and
 *      checks whether any keyword appears in that section.
 *   4. Extracts a loose "deadline hint" via regex if one is nearby.
 *   5. Merges matches into data/grants.json:
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

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'TactiCallGrantRadar/1.0 (+personal research tool; contact via github issues)',
        'Accept': 'text/html',
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

async function main() {
  const keywords = JSON.parse(await readFile(KEYWORDS_PATH, 'utf8'));
  const sources = JSON.parse(await readFile(SOURCES_PATH, 'utf8'));
  const grants = JSON.parse(await readFile(GRANTS_PATH, 'utf8'));
  const byId = new Map(grants.map(g => [g.id, g]));

  const runLog = [];
  let totalCandidates = 0;

  for (const source of sources) {
    try {
      const found = await crawlSource(source, keywords);
      totalCandidates += found.length;
      runLog.push({ source: source.name, ok: true, matches: found.length });

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
            tags: [],
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

export { crawlSource, extractDeadlineHint, parseLooseDate, hashId };
