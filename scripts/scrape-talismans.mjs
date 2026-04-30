/**
 * Scrapes ALL talismans from eldenring.wiki.gg.
 * Run with: npm run scrape:talismans
 * Output:   src/data/talismans.json
 *
 * Each entry:
 *   { name, effect, boosts? }
 *   boosts is only present when stat boosts are detected.
 *   boosts keys: str, dex, int, fai, arc — values are the numeric boost amount.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH   = path.join(__dirname, '..', 'src', 'data', 'talismans.json');
const BASE_URL   = 'https://eldenring.wiki.gg/api.php';
const DELAY_MS   = 800;
const BATCH_SIZE = 10;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── MediaWiki helpers ─────────────────────────────────────────────────────────

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
    console.error(`\n  Rate limited — waiting ${wait / 1000}s (retry ${attempt + 1}/5)...`);
    await sleep(wait);
    return apiGet(params, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}

async function getCategoryPages(category) {
  const pages = [];
  let cmcontinue;
  do {
    const params = {
      action: 'query',
      list: 'categorymembers',
      cmtitle: `Category:${category}`,
      cmlimit: 500,
      cmtype: 'page',
      cmnamespace: 0,
    };
    if (cmcontinue) params.cmcontinue = cmcontinue;
    const data = await apiGet(params);
    pages.push(...(data.query?.categorymembers ?? []));
    cmcontinue = data.continue?.cmcontinue;
    if (cmcontinue) await sleep(DELAY_MS);
  } while (cmcontinue);
  return pages;
}

async function getWikitextBatch(titles) {
  const data = await apiGet({
    action: 'query',
    titles: titles.join('|'),
    prop: 'revisions',
    rvprop: 'content',
    rvslots: 'main',
  });
  const result = {};
  for (const page of Object.values(data.query.pages)) {
    const rev = page.revisions?.[0];
    result[page.title] = rev?.slots?.main?.content
                      ?? rev?.slots?.main?.['*']
                      ?? rev?.['*']
                      ?? '';
  }
  return result;
}

// ── Wikitext utilities ────────────────────────────────────────────────────────

function stripMarkup(text) {
  return text
    .replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2') // [[Page|display]] → display
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<!--.*?-->/gs, '')
    .replace(/'''|''/g, '')
    .replace(/{{[^}]+}}/g, '')
    .trim();
}

function extractField(wikitext, key) {
  // Strip wikilinks first so that [[Page|display]] doesn't have a | that
  // terminates the field value regex early.
  const cleaned = wikitext.replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2');
  const m = cleaned.match(new RegExp(`\\|\\s*${key}\\s*=([^|}\n\r]*)`, 'i'));
  return m ? stripMarkup(m[1]) : '';
}

function extractEffectSection(wikitext) {
  // Grab everything between == Effect == and the next == heading ==
  const m = wikitext.match(/==\s*(?:\[\[.*?\]\]\s*)?Effect[^\n]*==\n([\s\S]*?)(?:\n==|$)/i);
  return m ? stripMarkup(m[1]) : '';
}

// ── Stat boost parser ─────────────────────────────────────────────────────────

// All the names/abbreviations the wiki uses for each weapon-equip stat
const STAT_ALIASES = {
  str: ['str', 'strength'],
  dex: ['dex', 'dexterity'],
  int: ['int', 'intelligence'],
  fai: ['fai', 'faith'],
  arc: ['arc', 'arcane'],
};

function lookupStat(word) {
  const w = word.trim().toLowerCase();
  for (const [stat, aliases] of Object.entries(STAT_ALIASES)) {
    if (aliases.includes(w)) return stat;
  }
  return null;
}

function parseBoosts(itemEffect, effectSection) {
  const text = `${itemEffect}\n${effectSection}`;
  const boosts = {};

  const add = (stat, val) => {
    if (stat && val > 0) boosts[stat] = Math.max(boosts[stat] ?? 0, val);
  };

  // ── Pattern A: "+N ABBREV1, ABBREV2, ..."
  // Example: "+5 VIG, END, STR, DEX"  (Radagon's Soreseal item_effect)
  for (const m of text.matchAll(/\+(\d+)\s+((?:[A-Za-z]+(?:,\s*)?)+)/g)) {
    const val = parseInt(m[1]);
    for (const part of m[2].split(/,\s*/))
      add(lookupStat(part), val);
  }

  // ── Pattern B: "increasing by +N the following Stats:\n* Stat\n* Stat..."
  // Example: Marika's Soreseal / Scarseal effect section
  const followingMatch = text.match(/increasing by \+(\d+)[^:]*:\n((?:[*\-]\s*[^\n]+\n?)+)/i);
  if (followingMatch) {
    const val = parseInt(followingMatch[1]);
    for (const line of followingMatch[2].matchAll(/[*\-]\s*([^\n]+)/g))
      add(lookupStat(line[1].trim()), val);
  }

  // ── Pattern C: "Raises/Boosts/Increases STAT by N"  (no + required before N)
  // Example: "Raises strength by 5", "Increases dexterity by 5"
  for (const m of text.matchAll(/(?:raises?|boosts?|increases?)\s+(\w+)\s+by\s+\+?(\d+)/gi))
    add(lookupStat(m[1]), parseInt(m[2]));

  // ── Pattern D: "+N to STAT" or "+N STAT" (standalone)
  // Example: "+5 to Faith"
  for (const m of text.matchAll(/\+(\d+)\s+(?:to\s+)?(\b(?:strength|dexterity|intelligence|faith|arcane)\b)/gi))
    add(lookupStat(m[2]), parseInt(m[1]));

  // ── Pattern E: "STAT +N"
  for (const m of text.matchAll(/\b(strength|dexterity|intelligence|faith|arcane)\s*\+(\d+)/gi))
    add(lookupStat(m[1]), parseInt(m[2]));

  return Object.keys(boosts).length ? boosts : undefined;
}

// ── Talisman parser ───────────────────────────────────────────────────────────

function parseTalisman(title, wikitext) {
  if (wikitext.startsWith('#REDIRECT') || wikitext.startsWith('#redirect')) return null;

  // Must have an infobox
  if (!wikitext.toLowerCase().includes('infobox')) return null;

  // Must be type = Talisman (filters out list/index pages)
  const typeField = extractField(wikitext, 'type');
  if (!typeField.toLowerCase().includes('talisman')) return null;

  const name  = extractField(wikitext, 'title') || title;
  const effect = extractField(wikitext, 'item_effect');
  const effectSection = extractEffectSection(wikitext);
  const boosts = parseBoosts(effect, effectSection);

  return { name, effect, ...(boosts ? { boosts } : {}) };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching Category:Talismans...');
  const pages = await getCategoryPages('Talismans');
  console.log(`Found ${pages.length} pages\n`);

  const talismans = [];
  let processed = 0;

  for (let i = 0; i < pages.length; i += BATCH_SIZE) {
    const batch = pages.slice(i, i + BATCH_SIZE);
    processed += batch.length;
    process.stdout.write(`\r[${processed}/${pages.length}] Processing...`);

    let wikitextMap;
    try {
      wikitextMap = await getWikitextBatch(batch.map(p => p.title));
    } catch (e) {
      console.error(`\nBatch failed: ${e.message}`);
      continue;
    }

    for (const { title } of batch) {
      const parsed = parseTalisman(title, wikitextMap[title] ?? '');
      if (parsed) talismans.push(parsed);
    }

    await sleep(DELAY_MS);
  }

  process.stdout.write('\n\n');

  // Sort alphabetically
  talismans.sort((a, b) => a.name.localeCompare(b.name));

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(talismans, null, 2));

  const withBoosts = talismans.filter(t => t.boosts);
  console.log(`Total talismans:       ${talismans.length}`);
  console.log(`With stat boosts:      ${withBoosts.length}`);
  console.log('\nStat-boosting talismans:');
  for (const t of withBoosts)
    console.log(`  ${t.name.padEnd(40)} ${JSON.stringify(t.boosts)}`);
  console.log(`\nWrote: ${OUT_PATH}`);
}

main().catch(e => { console.error(e); process.exit(1); });
