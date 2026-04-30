/**
 * Scrapes Elden Ring item data from eldenring.wiki.gg via the MediaWiki API.
 * Run with: npm run scrape
 * Output:   src/data/elden-ring.json
 *
 * Sections scraped:
 *   - weapons      (name, type, stat requirements)
 *   - talismans    (name, stat boosts — permanent while equipped)
 *   - crystalTears (name, stat boosts — temporary, via Physick flask)
 *   - armor        (name, slot, stat boosts)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH   = path.join(__dirname, '..', 'src', 'data', 'elden-ring.json');
const DEBUG_PATH = path.join(__dirname, '..', 'src', 'data', 'debug-samples.json');
const BASE_URL   = 'https://eldenring.wiki.gg/api.php';

// Delay between batch requests (ms). Higher = safer against 429.
const DELAY_MS  = 800;
// Pages to fetch per API call (MediaWiki allows up to 50)
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
    if (attempt >= 5) throw new Error(`HTTP 429 after ${attempt} retries — ${url}`);
    const wait = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s, 16s, 32s
    console.error(`\n  Rate limited, waiting ${wait / 1000}s before retry ${attempt + 1}/5...`);
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

// Fetch wikitext for multiple pages in one API call (up to BATCH_SIZE)
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
    const text = rev?.slots?.main?.content
               ?? rev?.slots?.main?.['*']
               ?? rev?.['*']
               ?? '';
    result[page.title] = text;
  }
  return result;
}

// ── Wikitext field extractors ─────────────────────────────────────────────────

function field(wikitext, ...keys) {
  for (const key of keys) {
    const re = new RegExp(`\\|\\s*${key}\\s*=([^|}\n\r]*)`, 'i');
    const m = wikitext.match(re);
    if (m) {
      const val = m[1]
        .replace(/<!--.*?-->/gs, '')
        .replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2')
        .replace(/{{[^}]+}}/g, '')
        .trim();
      if (val && val !== '-' && val !== 'N/A' && val !== '–') return val;
    }
  }
  return null;
}

function fieldInt(wikitext, ...keys) {
  const val = field(wikitext, ...keys);
  if (!val) return 0;
  const n = parseInt(val.replace(/[^\d]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

// ── Weapon parser ─────────────────────────────────────────────────────────────

const WEAPON_TYPE_KEYS = ['weapon_type', 'weapontype', 'type', 'Type', 'category'];
const REQ_KEYS = {
  str: ['str_req', 'strength_req', 'req_str'],
  dex: ['dex_req', 'dexterity_req', 'req_dex'],
  int: ['int_req', 'intelligence_req', 'req_int'],
  fai: ['fai_req', 'faith_req', 'req_fai'],
  arc: ['arc_req', 'arcane_req', 'req_arc'],
};

function parseWeapon(title, wikitext) {
  if (wikitext.startsWith('#REDIRECT') || wikitext.startsWith('#redirect')) return null;
  if (!wikitext.toLowerCase().includes('infobox')) return null;

  const requirements = {
    str: fieldInt(wikitext, ...REQ_KEYS.str),
    dex: fieldInt(wikitext, ...REQ_KEYS.dex),
    int: fieldInt(wikitext, ...REQ_KEYS.int),
    fai: fieldInt(wikitext, ...REQ_KEYS.fai),
    arc: fieldInt(wikitext, ...REQ_KEYS.arc),
  };

  const type = field(wikitext, ...WEAPON_TYPE_KEYS) ?? 'Unknown';

  // Allow zero-requirement weapons (e.g. Serpent-Hunter) as long as the page
  // has a weapon-specific infobox. Reject pages that just happen to contain
  // "infobox" but aren't weapon pages (list pages, category pages, etc.).
  const hasWeaponInfobox = /Infobox_?Weapon/i.test(wikitext);
  if (!hasWeaponInfobox && Object.values(requirements).every(v => v === 0)) return null;

  return { name: title, type, requirements };
}

// ── Stat-boost parser (talismans, tears, armor) ───────────────────────────────

// For each stat, check several natural-language patterns used in the wiki.
// The wiki uses "Raises strength by 5" (no +) in item_effect/effect sections.
function findBoostForStat(text, statName) {
  const n = statName;
  const patterns = [
    new RegExp(`raises?\\s+${n}(?:\\s+(?:stat|attribute))?\\s+by\\s+\\+?(\\d+)`, 'i'),  // "Raises strength by 5"
    new RegExp(`\\+(\\d+)\\s+(?:to\\s+)?${n}`, 'i'),                                      // "+5 to Strength"
    new RegExp(`${n}\\s*\\+(\\d+)`, 'i'),                                                  // "Strength +5"
    new RegExp(`\\+(\\d+)\\s+${n}`, 'i'),                                                  // "+5 Strength"
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return parseInt(m[1], 10);
  }
  return 0;
}

function parseStatBoosts(wikitext) {
  if (wikitext.startsWith('#REDIRECT') || wikitext.startsWith('#redirect')) return null;

  // Strip wikilinks so [[Strength]] becomes Strength
  const cleaned = wikitext.replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2');

  // Prefer effect/description fields to avoid false positives in lore text.
  // item_effect is used in Infobox_Item (talismans, crystal tears, armor).
  const effectLines = [];
  for (const m of cleaned.matchAll(/\|\s*(?:item_effect|description|effect\d*|passive|bonus|notes?)\s*=([^|}\n][^|}]*)/gi))
    effectLines.push(m[0]);
  // Also include the ==Effect== free-text section
  const effectSection = cleaned.match(/==\s*(?:\[\[.*?\]\]\s*)?Effect[^\n]*==\n([\s\S]*?)(?:\n==|$)/i);
  if (effectSection) effectLines.push(effectSection[1]);

  const searchText = effectLines.length ? effectLines.join('\n') : cleaned;

  const boosts = {};

  // Check "all attributes" first (e.g. Godrick's Great Rune)
  const allMatch = searchText.match(/raises?\s+all\s+(?:attributes|stats)\s+by\s+\+?(\d+)|\+(\d+)\s+(?:to\s+)?all\s+(?:attributes|stats)/i);
  if (allMatch) {
    const val = parseInt(allMatch[1] ?? allMatch[2], 10);
    for (const s of ['str', 'dex', 'int', 'fai', 'arc']) boosts[s] = val;
  }

  for (const [stat, name] of [['str','strength'],['dex','dexterity'],['int','intelligence'],['fai','faith'],['arc','arcane']]) {
    const val = findBoostForStat(searchText, name);
    if (val > 0) boosts[stat] = Math.max(boosts[stat] ?? 0, val);
  }

  return Object.keys(boosts).length ? boosts : null;
}

// ── Generic batch scraper ─────────────────────────────────────────────────────

async function scrapeCategory(category, parser, label, debugSamples) {
  console.log(`\n[${label}] Fetching Category:${category}...`);
  let pages;
  try {
    pages = await getCategoryPages(category);
  } catch (e) {
    console.error(`  Failed to get category members: ${e.message}`);
    return [];
  }
  console.log(`  Found ${pages.length} pages`);

  const results = [];
  const debugList = (debugSamples[label] ??= []);
  const missedList = (debugSamples[`${label}:missed`] ??= []);
  let processed = 0;

  // Process pages in batches to minimise API calls
  for (let i = 0; i < pages.length; i += BATCH_SIZE) {
    const batch = pages.slice(i, i + BATCH_SIZE);
    processed += batch.length;
    process.stdout.write(`\r  Processed ${processed}/${pages.length}...`);

    let wikitextMap;
    try {
      wikitextMap = await getWikitextBatch(batch.map(p => p.title));
    } catch (e) {
      console.error(`\n  Batch fetch failed: ${e.message}`);
      continue;
    }

    for (const { title } of batch) {
      const wikitext = wikitextMap[title] ?? '';
      const parsed = parser(title, wikitext);
      if (parsed) {
        results.push(parsed);
        if (debugList.length < 3)
          debugList.push({ title, wikitext: wikitext.slice(0, 2000) });
      } else if (missedList.length < 3 && !wikitext.startsWith('#REDIRECT') && !wikitext.startsWith('#redirect')) {
        missedList.push({ title, wikitext: wikitext.slice(0, 2000) });
      }
    }

    await sleep(DELAY_MS);
  }

  process.stdout.write('\n');
  console.log(`  Kept ${results.length} ${label}`);
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const debugSamples = {};

  // Top-level "Weapons" category on this wiki contains sub-category pages (Daggers, etc.)
  // and some individual weapon pages. The named subcategories cover individual weapons.
  const WEAPON_SUBCATEGORIES = [
    'Daggers', 'Straight Swords', 'Greatswords', 'Colossal Swords',
    'Thrusting Swords', 'Heavy Thrusting Swords',
    'Curved Swords', 'Curved Greatswords',
    'Katanas', 'Twinblades', 'Great Katanas',
    'Axes', 'Greataxes',
    'Hammers', 'Flails', 'Great Hammers', 'Colossal Weapons',
    'Spears', 'Great Spears', 'Halberds', 'Reapers',
    'Whips', 'Fists', 'Claws',
    'Light Bows', 'Bows', 'Greatbows', 'Crossbows', 'Ballistas',
    'Glintstone Staves', 'Sacred Seals',
    'Small Shields', 'Medium Shields', 'Greatshields', 'Thrusting Shields',
    'Torches',
    // Shadow of the Erdtree additions
    'Light Greatswords', 'Backhand Blades', 'Throwing Blades',
    'Beast Claws', 'Perfume Bottles',
  ];

  const weaponsSeen = new Set();
  const weapons = [];

  for (const cat of WEAPON_SUBCATEGORIES) {
    const batch = await scrapeCategory(cat, parseWeapon, `weapons:${cat}`, debugSamples);
    for (const w of batch) {
      if (!weaponsSeen.has(w.name)) {
        weaponsSeen.add(w.name);
        weapons.push(w);
      }
    }
  }

  // ── Talismans ──
  const talismans = await scrapeCategory(
    'Talismans',
    (title, wikitext) => {
      const boosts = parseStatBoosts(wikitext);
      if (!boosts) return null;
      return { name: title, temporary: false, boosts };
    },
    'talismans',
    debugSamples,
  );

  // ── Crystal Tears ──
  const crystalTears = await scrapeCategory(
    'Crystal Tears',
    (title, wikitext) => {
      const boosts = parseStatBoosts(wikitext);
      if (!boosts) return null;
      return { name: title, temporary: true, boosts };
    },
    'crystalTears',
    debugSamples,
  );

  // ── Armor (split by slot) ──
  const ARMOR_CATEGORIES = [
    { cat: 'Head',  slot: 'Head' },
    { cat: 'Chest', slot: 'Chest' },
    { cat: 'Arms',  slot: 'Arms' },
    { cat: 'Legs',  slot: 'Legs' },
  ];
  const armorSeen = new Set();
  const armor = [];

  for (const { cat, slot } of ARMOR_CATEGORIES) {
    const batch = await scrapeCategory(
      cat,
      (title, wikitext) => {
        const boosts = parseStatBoosts(wikitext);
        if (!boosts) return null;
        return { name: title, slot, boosts };
      },
      `armor:${cat}`,
      debugSamples,
    );
    for (const a of batch) {
      if (!armorSeen.has(a.name)) {
        armorSeen.add(a.name);
        armor.push(a);
      }
    }
  }

  // ── Write output ──
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify({ weapons, talismans, crystalTears, armor }, null, 2));
  fs.writeFileSync(DEBUG_PATH, JSON.stringify(debugSamples, null, 2));

  console.log('\n── Results ────────────────────────────────────');
  console.log(`  weapons:      ${weapons.length}`);
  console.log(`  talismans:    ${talismans.length}  (w/ stat boosts)`);
  console.log(`  crystalTears: ${crystalTears.length}  (w/ stat boosts)`);
  console.log(`  armor:        ${armor.length}  (w/ stat boosts)`);
  console.log(`\nWrote: ${OUT_PATH}`);
  console.log(`Debug: ${DEBUG_PATH}`);
  if (!talismans.length || !crystalTears.length)
    console.log('\n⚠  Low counts — inspect debug-samples.json to tune the parsers.');
}

main().catch(e => { console.error(e); process.exit(1); });
