/**
 * Fetches missing DLC weapon categories and merges them into elden-ring.json.
 * Run with: node scripts/patch-missing-weapons.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, '..', 'src', 'data', 'elden-ring.json');
const BASE_URL  = 'https://eldenring.wiki.gg/api.php';

const MISSING_CATS = [
  'Light Greatswords', 'Backhand Blades', 'Throwing Blades',
  'Beast Claws', 'Perfume Bottles', 'Thrusting Shields',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
    const params = { action: 'query', list: 'categorymembers', cmtitle: `Category:${category}`, cmlimit: 500, cmtype: 'page', cmnamespace: 0 };
    if (cmcontinue) params.cmcontinue = cmcontinue;
    const data = await apiGet(params);
    pages.push(...(data.query?.categorymembers ?? []));
    cmcontinue = data.continue?.cmcontinue;
    if (cmcontinue) await sleep(600);
  } while (cmcontinue);
  return pages;
}

async function getWikitextBatch(titles) {
  const data = await apiGet({ action: 'query', titles: titles.join('|'), prop: 'revisions', rvprop: 'content', rvslots: 'main' });
  const result = {};
  for (const page of Object.values(data.query.pages)) {
    const rev = page.revisions?.[0];
    result[page.title] = rev?.slots?.main?.content ?? rev?.slots?.main?.['*'] ?? '';
  }
  return result;
}

function field(wikitext, ...keys) {
  for (const key of keys) {
    const re = new RegExp(`\\|\\s*${key}\\s*=([^|}\n\r]*)`, 'i');
    const m = wikitext.match(re);
    if (m) {
      const val = m[1].replace(/<!--.*?-->/gs, '').replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2').replace(/{{[^}]+}}/g, '').trim();
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
  const hasWeaponInfobox = /Infobox_?Weapon/i.test(wikitext);
  if (!hasWeaponInfobox && Object.values(requirements).every(v => v === 0)) return null;
  return { name: title, type, requirements };
}

async function main() {
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const existing = new Set(data.weapons.map(w => w.name));
  const added = [];

  for (const cat of MISSING_CATS) {
    console.log(`\nFetching Category:${cat}...`);
    const pages = await getCategoryPages(cat);
    const newPages = pages.filter(p => !existing.has(p.title));
    console.log(`  ${pages.length} pages, ${newPages.length} new`);
    if (newPages.length === 0) continue;

    for (let i = 0; i < newPages.length; i += 10) {
      const batch = newPages.slice(i, i + 10);
      const wikitextMap = await getWikitextBatch(batch.map(p => p.title));
      for (const { title } of batch) {
        const parsed = parseWeapon(title, wikitextMap[title] ?? '');
        if (parsed) {
          data.weapons.push(parsed);
          existing.add(parsed.name);
          added.push(parsed.name);
          console.log(`  + ${parsed.name} (${parsed.type})`);
        }
      }
      await sleep(600);
    }
  }

  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
  console.log(`\nAdded ${added.length} weapons. Total: ${data.weapons.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
