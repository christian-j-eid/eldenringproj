/**
 * Scrapes stat-boosting armor pieces from eldenring.wiki.gg.
 * Run with: npm run scrape:armor
 * Output:   src/data/armor.json
 *
 * Each entry: { name, slot, boosts }
 * boosts keys: str, dex, int, fai, arc
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH  = path.join(__dirname, '..', 'src', 'data', 'armor.json');
const BASE_URL  = 'https://eldenring.wiki.gg/api.php';
const DELAY_MS  = 800;
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
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getCategoryPages(category) {
  const pages = [];
  let cmcontinue;
  do {
    const params = {
      action: 'query', list: 'categorymembers',
      cmtitle: `Category:${category}`, cmlimit: 500,
      cmtype: 'page', cmnamespace: 0,
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
    action: 'query', titles: titles.join('|'),
    prop: 'revisions', rvprop: 'content', rvslots: 'main',
  });
  const result = {};
  for (const page of Object.values(data.query.pages)) {
    const rev = page.revisions?.[0];
    result[page.title] = rev?.slots?.main?.content ?? rev?.slots?.main?.['*'] ?? rev?.['*'] ?? '';
  }
  return result;
}

// ── Wikitext helpers ──────────────────────────────────────────────────────────

function stripMarkup(text) {
  return text
    .replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2') // [[Page|display]] → display
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<!--.*?-->/gs, '')
    .replace(/'''|''/g, '')                          // '''bold''' / ''italic''
    .replace(/{{[^}]+}}/g, '')
    .trim();
}

function extractField(wikitext, key) {
  const cleaned = wikitext.replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2');
  const m = cleaned.match(new RegExp(`\\|\\s*${key}\\s*=([^|}\n\r]*)`, 'i'));
  return m ? stripMarkup(m[1]) : '';
}

// Extract a potentially multi-line bullet-list field like:
//   | effects =
//   *Raises strength
//   *Reduces potency...
function extractBulletField(wikitext, key) {
  const m = wikitext.match(new RegExp(`\\|\\s*${key}\\s*=([\\s\\S]*?)(?=\\n\\s*\\|[^|]|\\n}}|$)`, 'i'));
  return m ? stripMarkup(m[1]) : '';
}

// Extract a named == Section == body. Matches in raw wikitext so
// [[File:...|50px|label]] style headings don't break the regex.
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

function parseBoosts(effectsField, effectsSection) {
  // Combine the infobox bullet field and the free-text Effects section.
  // Both have been through stripMarkup so bold/italic/wikilinks are clean.
  const text = `${effectsField}\n${effectsSection}`;
  const boosts = {};

  const add = (stat, val) => {
    if (stat && val > 0) boosts[stat] = Math.max(boosts[stat] ?? 0, val);
  };

  // "Raises/Boosts/Increases STAT by N"  (with or without leading +)
  for (const m of text.matchAll(/(?:raises?|boosts?|increases?)\s+(\w+)\s+by\s+\+?(\d+)/gi))
    add(lookupStat(m[1]), parseInt(m[2]));

  // "+N to STAT" or "+N STAT"
  for (const m of text.matchAll(/\+(\d+)\s+(?:to\s+)?(\b(?:strength|dexterity|intelligence|faith|arcane)\b)/gi))
    add(lookupStat(m[2]), parseInt(m[1]));

  // "STAT +N"
  for (const m of text.matchAll(/\b(strength|dexterity|intelligence|faith|arcane)\s*\+(\d+)/gi))
    add(lookupStat(m[1]), parseInt(m[2]));

  // "+N ABBREV" where ABBREV is str/dex/int/fai/arc
  for (const m of text.matchAll(/\+(\d+)\s+(str|dex|int|fai|arc)\b/gi))
    add(lookupStat(m[2]), parseInt(m[1]));

  return Object.keys(boosts).length ? boosts : undefined;
}

// ── Armor parser ──────────────────────────────────────────────────────────────

function parseArmor(title, wikitext, slot) {
  if (wikitext.startsWith('#REDIRECT') || wikitext.startsWith('#redirect')) return null;
  // Armor pages use {{Infobox Armor}} or {{Infobox_Armor}}
  if (!/Infobox.{0,1}Armor/i.test(wikitext)) return null;

  const effectsField   = extractBulletField(wikitext, 'effects');
  // Some armor stores the boost in ==Effects==, others in ==Notes==
  const effectsSection = extractSection(wikitext, 'Effects?') + '\n' + extractSection(wikitext, 'Notes?');
  const boosts         = parseBoosts(effectsField, effectsSection);
  if (!boosts) return null;

  const name = extractField(wikitext, 'title') || title;
  return { name, slot, boosts };
}

// ── Main ──────────────────────────────────────────────────────────────────────

const ARMOR_SLOTS = [
  { category: 'Head',  slot: 'Head' },
  { category: 'Chest', slot: 'Chest' },
  { category: 'Arms',  slot: 'Arms' },
  { category: 'Legs',  slot: 'Legs' },
];

async function scrapeSlot(category, slot) {
  console.log(`\n[${slot}] Fetching Category:${category}...`);
  let pages;
  try {
    pages = await getCategoryPages(category);
  } catch (e) {
    console.error(`  Failed: ${e.message}`);
    return [];
  }
  console.log(`  Found ${pages.length} pages`);

  const results = [];
  let processed = 0;

  for (let i = 0; i < pages.length; i += BATCH_SIZE) {
    const batch = pages.slice(i, i + BATCH_SIZE);
    processed += batch.length;
    process.stdout.write(`\r  [${processed}/${pages.length}] Processing...`);

    let map;
    try {
      map = await getWikitextBatch(batch.map(p => p.title));
    } catch (e) {
      console.error(`\n  Batch failed: ${e.message}`);
      continue;
    }

    for (const { title } of batch) {
      const parsed = parseArmor(title, map[title] ?? '', slot);
      if (parsed) results.push(parsed);
    }

    await sleep(DELAY_MS);
  }

  process.stdout.write('\n');
  console.log(`  Kept ${results.length} stat-boosting pieces`);
  return results;
}

async function main() {
  const seen  = new Set();
  const armor = [];

  for (const { category, slot } of ARMOR_SLOTS) {
    const batch = await scrapeSlot(category, slot);
    for (const a of batch) {
      if (!seen.has(a.name)) { seen.add(a.name); armor.push(a); }
    }
  }

  armor.sort((a, b) => a.slot.localeCompare(b.slot) || a.name.localeCompare(b.name));

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(armor, null, 2));

  console.log('\n── Results ──────────────────────────────────');
  console.log(`  Total stat-boosting armor: ${armor.length}`);
  for (const a of armor)
    console.log(`  [${a.slot.padEnd(6)}] ${a.name.padEnd(40)} ${JSON.stringify(a.boosts)}`);
  console.log(`\nWrote: ${OUT_PATH}`);
}

main().catch(e => { console.error(e); process.exit(1); });
