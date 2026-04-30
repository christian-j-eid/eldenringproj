/**
 * Fetches all 7 Great Runes from eldenring.wiki.gg.
 * Run with: npm run scrape:runes
 * Output:   src/data/great-runes.json
 *
 * Each entry: { name, effect, note?, boosts? }
 * boosts keys: str, dex, int, fai, arc — only present when the rune boosts weapon stats.
 * note: "Requires Rune Arc to activate" on all entries.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH  = path.join(__dirname, '..', 'src', 'data', 'great-runes.json');
const BASE_URL  = 'https://eldenring.wiki.gg/api.php';

const GREAT_RUNE_PAGES = [
  "Godrick's Great Rune",
  "Radahn's Great Rune",
  "Rykard's Great Rune",
  "Morgott's Great Rune",
  "Malenia's Great Rune",
  "Mohg's Great Rune",
  "Miquella's Great Rune",
];

async function apiGet(params, attempt = 0) {
  const url = new URL(BASE_URL);
  for (const [k, v] of Object.entries({ format: 'json', origin: '*', ...params }))
    url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': 'EldenRingBuildHelper/1.0 (educational project)' },
  });
  if (res.status === 429) {
    if (attempt >= 5) throw new Error(`HTTP 429 after ${attempt} retries`);
    const wait = 2000 * Math.pow(2, attempt);
    await new Promise(r => setTimeout(r, wait));
    return apiGet(params, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getWikitextBatch(titles) {
  const data = await apiGet({
    action: 'query', titles: titles.join('|'),
    prop: 'revisions', rvprop: 'content', rvslots: 'main',
  });
  const result = {};
  for (const page of Object.values(data.query.pages)) {
    const rev = page.revisions?.[0];
    result[page.title] = rev?.slots?.main?.content ?? rev?.slots?.main?.['*'] ?? '';
  }
  return result;
}

// ── Wikitext helpers ──────────────────────────────────────────────────────────

function stripMarkup(text) {
  return text
    .replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<!--.*?-->/gs, '')
    .replace(/'''|''/g, '')
    .replace(/{{[^}]+}}/g, '')
    .trim();
}

function extractField(wikitext, key) {
  const cleaned = wikitext.replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2');
  const m = cleaned.match(new RegExp(`\\|\\s*${key}\\s*=([^|}\n\r]*)`, 'i'));
  return m ? stripMarkup(m[1]) : '';
}

function extractSection(wikitext, sectionName) {
  const re = new RegExp(
    `==\\s*(?:\\[\\[.*?\\]\\]\\s*)?${sectionName}\\s*==\\n([\\s\\S]*?)(?:\\n==|$)`, 'i'
  );
  const m = wikitext.match(re);
  return m ? stripMarkup(m[1]) : '';
}

// ── Stat boost parser ─────────────────────────────────────────────────────────

const STAT_ALIASES = {
  str: ['str', 'strength'],
  dex: ['dex', 'dexterity'],
  int: ['int', 'intelligence'],
  fai: ['fai', 'faith'],
  arc: ['arc', 'arcane'],
};

function lookupStat(word) {
  const w = word.trim().toLowerCase();
  for (const [stat, aliases] of Object.entries(STAT_ALIASES))
    if (aliases.includes(w)) return stat;
  return null;
}

function parseBoosts(itemEffect, effectSection) {
  const text = `${itemEffect}\n${effectSection}`;
  const boosts = {};
  const add = (stat, val) => {
    if (stat && val > 0) boosts[stat] = Math.max(boosts[stat] ?? 0, val);
  };

  // "Boosts/Raises all stats by +N" — Godrick's Great Rune
  const allMatch = text.match(/(?:boosts?|raises?|increases?)\s+all\s+(?:stats?|attributes?)\s+by\s+\+?(\d+)/i);
  if (allMatch) {
    const val = parseInt(allMatch[1]);
    for (const s of ['str', 'dex', 'int', 'fai', 'arc']) boosts[s] = val;
  }

  // "+N to all attributes"
  const allMatch2 = text.match(/\+(\d+)\s+(?:to\s+)?all\s+(?:stats?|attributes?)/i);
  if (allMatch2) {
    const val = parseInt(allMatch2[1]);
    for (const s of ['str', 'dex', 'int', 'fai', 'arc']) boosts[s] = val;
  }

  // Individual stat patterns
  for (const m of text.matchAll(/(?:raises?|boosts?|increases?)\s+(\w+)\s+by\s+\+?(\d+)/gi))
    add(lookupStat(m[1]), parseInt(m[2]));
  for (const m of text.matchAll(/\+(\d+)\s+(?:to\s+)?(\b(?:strength|dexterity|intelligence|faith|arcane)\b)/gi))
    add(lookupStat(m[2]), parseInt(m[1]));

  return Object.keys(boosts).length ? boosts : undefined;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching Great Rune pages...');
  const wikitextMap = await getWikitextBatch(GREAT_RUNE_PAGES);

  const runes = [];
  for (const title of GREAT_RUNE_PAGES) {
    const wikitext = wikitextMap[title] ?? '';
    if (!wikitext) { console.warn(`  Missing page: ${title}`); continue; }

    const name        = extractField(wikitext, 'title') || title;
    const effect      = extractField(wikitext, 'item_effect');
    const effectSect  = extractSection(wikitext, 'Effects?') + '\n' + extractSection(wikitext, 'Notes?');
    const boosts      = parseBoosts(effect, effectSect);

    runes.push({
      name,
      effect,
      note: 'Requires Rune Arc to activate',
      ...(boosts ? { boosts } : {}),
    });

    console.log(`  ${name}: ${effect}${boosts ? ' → ' + JSON.stringify(boosts) : ''}`);
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(runes, null, 2));
  console.log(`\nWrote ${runes.length} Great Runes to ${OUT_PATH}`);
}

main().catch(e => { console.error(e); process.exit(1); });
