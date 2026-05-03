import { useState, useMemo, useEffect, useRef } from 'react'
import rawData from './data/elden-ring.json'

// ── Constants ─────────────────────────────────────────────────────────────────

const STATS = ['STR', 'DEX', 'INT', 'FTH', 'ARC']
const STAT_HUE = { STR: 28, DEX: 145, INT: 220, FTH: 50, ARC: 305 }
const BASE_STATS = { STR: 10, DEX: 10, INT: 10, FTH: 10, ARC: 10 }
// data uses fai; UI uses FTH
const STAT_KEY_IN = { str: 'STR', dex: 'DEX', int: 'INT', fai: 'FTH', arc: 'ARC' }
const ATK_ORDER = ['phy', 'mag', 'fir', 'lit', 'hol']
const ATK_LABEL = { phy: 'Phys', mag: 'Magic', fir: 'Fire', lit: 'Ltng', hol: 'Holy' }
const ATK_HUE = { mag: 220, fir: 22, lit: 80, hol: 50 }

// ── Data normalization ────────────────────────────────────────────────────────

const wikiImg = filename =>
  `https://eldenring.wiki.gg/wiki/Special:FilePath/${encodeURIComponent(filename)}`

function normStats(obj) {
  if (!obj) return {}
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    const key = STAT_KEY_IN[k]
    if (key && v) out[key] = v
  }
  return out
}

let _id = 0
const uid = p => `${p}${++_id}`

const WEAPONS = rawData.weapons.map(w => ({
  id: uid('w'),
  name: w.name,
  cat: w.type,
  req: normStats(w.requirements),
  scaling: w.scaling
    ? Object.fromEntries(
        Object.entries(w.scaling)
          .filter(([, v]) => v && v !== '-')
          .map(([k, v]) => [STAT_KEY_IN[k] || k, v])
      )
    : {},
  attackType: w.attackType || null,
  dlc: !!w.dlc,
  stats: w.stats || {},
}))

const TALISMANS = rawData.talismans.map(t => ({
  id: uid('t'),
  name: t.name,
  flavor: t.effect,
  bonus: normStats(t.boosts),
  dlc: !!t.dlc,
}))

const TALISMAN_MUTEX_PAIRS = [
  ["Marika's Scarseal", "Marika's Soreseal"],
  ["Radagon's Scarseal", "Radagon's Soreseal"],
]
const TALISMAN_BY_NAME = Object.fromEntries(TALISMANS.map(t => [t.name, t.id]))
const TALISMAN_COUNTERPART = Object.fromEntries(
  TALISMAN_MUTEX_PAIRS.flatMap(([a, b]) => [[a, b], [b, a]])
)

const TEARS = rawData.crystalTears.map(t => ({
  id: uid('cr'),
  name: t.name,
  flavor: t.effect,
  bonus: normStats(t.boosts),
  dlc: !!t.dlc,
}))

const ARMOR = rawData.armor.map(a => ({
  id: uid('a'),
  name: a.name,
  slot: a.slot.toLowerCase(),
  bonus: normStats(a.boosts),
  dlc: !!a.dlc,
}))

const RUNES = [
  { id: 'rune_none', name: 'None', bonus: {} },
  ...rawData.greatRunes.map(r => ({
    id: uid('rune'),
    name: r.name,
    flavor: r.effect,
    bonus: normStats(r.boosts),
    image: r.image || null,
  })),
]

// ── Solver ────────────────────────────────────────────────────────────────────

function applyTwoHand(have, twoHand) {
  if (!twoHand) return have
  return { ...have, STR: Math.floor(have.STR * 1.5) }
}

function sumBonus(items) {
  const out = { STR: 0, DEX: 0, INT: 0, FTH: 0, ARC: 0 }
  for (const it of items) {
    if (!it?.bonus) continue
    for (const k of STATS) if (it.bonus[k]) out[k] += it.bonus[k]
  }
  return out
}

function shortfall(have, req, twoHand) {
  const eff = applyTwoHand(have, twoHand)
  const out = {}
  for (const k of STATS) {
    const d = (req[k] || 0) - eff[k]
    if (d > 0) out[k] = d
  }
  return out
}

function scoreCost(loadout) {
  const w = { rune: 0.5, twoHand: 0.1, tear: 1, talisman: 1.2, armor: 1.5 }
  let s = 0
  if (loadout.rune?.id !== 'rune_none') s += w.rune
  if (loadout.twoHand) s += w.twoHand
  s += (loadout.tears?.length || 0) * w.tear
  s += (loadout.talismans?.length || 0) * w.talisman
  s += (loadout.armor?.length || 0) * w.armor
  return s
}

function subsetsUpTo(pool, maxSize) {
  const result = [[]]
  function dfs(start, chosen) {
    if (chosen.length >= maxSize) return
    for (let i = start; i < pool.length; i++) {
      chosen.push(pool[i])
      result.push([...chosen])
      dfs(i + 1, chosen)
      chosen.pop()
    }
  }
  dfs(0, [])
  return result
}

function armorSubsets(armorPool) {
  const bySlot = {}
  for (const a of armorPool) {
    if (!bySlot[a.slot]) bySlot[a.slot] = []
    bySlot[a.slot].push(a)
  }
  const slots = Object.keys(bySlot)
  const result = []
  function dfs(si, chosen) {
    if (si === slots.length) { result.push([...chosen]); return }
    dfs(si + 1, chosen)
    for (const a of bySlot[slots[si]]) {
      chosen.push(a); dfs(si + 1, chosen); chosen.pop()
    }
  }
  dfs(0, [])
  return result
}

function solveAll(weapon, { allowGreatRune = true, allowArmor = true, allowTwoHand = true, allowTear = true, talismanPool = TALISMANS, tearPool = TEARS, runeData = RUNES } = {}) {
  const req = weapon.req
  const results = []

  const runePool = allowGreatRune
    ? runeData.filter(r => r.id === 'rune_none' || Object.keys(r.bonus).length > 0)
    : [runeData.find(r => r.id === 'rune_none') ?? RUNES[0]]
  const thOptions = allowTwoHand ? [false, true] : [false]

  for (const rune of runePool) {
    for (const th of thOptions) {
      if (th && (!req.STR || req.STR <= BASE_STATS.STR)) continue

      const haveBase = sumBonus([{ bonus: BASE_STATS }, { bonus: rune.bonus }])
      const baseNeed = shortfall(haveBase, req, th)

      if (Object.keys(baseNeed).length === 0) {
        const lo = { tears: [], talismans: [], armor: [], rune, twoHand: th }
        results.push({ ...lo, score: scoreCost(lo) })
        continue
      }

      const neededStats = new Set(Object.keys(baseNeed))
      const relTears = allowTear
        ? tearPool.filter(t => STATS.some(k => neededStats.has(k) && t.bonus[k] > 0))
        : []
      const relTals = talismanPool.filter(t => STATS.some(k => neededStats.has(k) && t.bonus[k] > 0))
      const relArmor = ARMOR.filter(a => STATS.some(k => neededStats.has(k) && a.bonus[k] > 0))

      const tearCombos = subsetsUpTo(relTears, 2)
      const armorCombos = allowArmor ? armorSubsets(relArmor) : [[]]

      for (const tears of tearCombos) {
        const haveT = sumBonus([{ bonus: haveBase }, ...tears])
        const needT = shortfall(haveT, req, th)

        if (Object.keys(needT).length === 0) {
          const lo = { tears, talismans: [], armor: [], rune, twoHand: th }
          results.push({ ...lo, score: scoreCost(lo) })
            continue
        }

        // Feasibility: can talismans + armor possibly cover remaining need?
        const feasible = STATS.every(k => {
          const need = needT[k] || 0
          if (!need) return true
          const talMax = relTals.map(t => t.bonus[k] || 0).sort((a, b) => b - a).slice(0, 4).reduce((s, v) => s + v, 0)
          const armMax = ['head', 'chest', 'arms', 'legs'].reduce((s, slot) => {
            return s + Math.max(0, ...relArmor.filter(a => a.slot === slot).map(a => a.bonus[k] || 0), 0)
          }, 0)
          return talMax + armMax >= need
        })
        if (!feasible) continue

        const talCombos = subsetsUpTo(relTals, 4).filter(combo =>
          !TALISMAN_MUTEX_PAIRS.some(([a, b]) => combo.some(t => t.name === a) && combo.some(t => t.name === b))
        )
        for (const talismans of talCombos) {
          const haveTT = sumBonus([{ bonus: haveT }, ...talismans])
          const needTT = shortfall(haveTT, req, th)

          if (Object.keys(needTT).length === 0) {
            const lo = { tears, talismans, armor: [], rune, twoHand: th }
            results.push({ ...lo, score: scoreCost(lo) })
                continue
          }

          for (const armor of armorCombos) {
            if (!armor.length) continue
            const haveAll = sumBonus([{ bonus: haveTT }, ...armor])
            const ok = STATS.every(k => {
              const eff = k === 'STR' && th ? Math.floor(haveAll[k] * 1.5) : haveAll[k]
              return eff >= (req[k] || 0)
            })
            if (ok) {
              const lo = { tears, talismans, armor, rune, twoHand: th }
              results.push({ ...lo, score: scoreCost(lo) })
                  }
          }
        }
      }
    }
  }

  return results.sort((a, b) => a.score - b.score)
}

function solve(weapon, { allowTwoHand = true, allowGreatRune = true, allowTear = true, talismanPool = TALISMANS, tearPool = TEARS, runeData = RUNES } = {}) {
  const req = weapon.req
  let best = null
  let bestAttempt = null

  const runePool = allowGreatRune ? runeData : [runeData.find(r => r.id === 'rune_none') ?? RUNES[0]]
  const thOptions = allowTwoHand ? [false, true] : [false]

  for (const rune of runePool) {
    for (const th of thOptions) {
      if (th && (!req.STR || req.STR <= BASE_STATS.STR)) continue

      const haveBase = sumBonus([{ bonus: BASE_STATS }, { bonus: rune.bonus }])
      const chosen = { tears: [], talismans: [], armor: [], rune, twoHand: th }
      let have = { ...haveBase }

      const need = () => shortfall(have, req, th)
      const stillNeed = () => Object.keys(need()).length > 0

      function pickBest(pool, excludeIds, filter = () => true) {
        const sf = need()
        let bestItem = null, bestVal = 0
        for (const it of pool) {
          if (excludeIds.has(it.id) || !filter(it)) continue
          let v = 0
          for (const k of STATS) if (sf[k] && it.bonus[k]) v += Math.min(it.bonus[k], sf[k])
          if (v <= 0) continue
          v = v * 100 - STATS.reduce((a, k) => a + (it.bonus[k] || 0), 0) * 0.01
          if (v > bestVal) { bestVal = v; bestItem = it }
        }
        return bestItem
      }

      const usedTears = new Set()
      if (allowTear) for (let i = 0; i < 2 && stillNeed(); i++) {
        const it = pickBest(tearPool, usedTears)
        if (!it) break
        usedTears.add(it.id)
        chosen.tears.push(it)
        have = sumBonus([{ bonus: haveBase }, ...chosen.tears, ...chosen.talismans, ...chosen.armor])
      }

      const usedTal = new Set()
      for (let i = 0; i < 4 && stillNeed(); i++) {
        const it = pickBest(talismanPool, usedTal)
        if (!it) break
        usedTal.add(it.id)
        const cpName = TALISMAN_COUNTERPART[it.name]
        if (cpName && TALISMAN_BY_NAME[cpName]) usedTal.add(TALISMAN_BY_NAME[cpName])
        chosen.talismans.push(it)
        have = sumBonus([{ bonus: haveBase }, ...chosen.tears, ...chosen.talismans, ...chosen.armor])
      }

      const filledSlots = new Set()
      for (let i = 0; i < 4 && stillNeed(); i++) {
        const it = pickBest(ARMOR, new Set(), a => !filledSlots.has(a.slot))
        if (!it) break
        filledSlots.add(it.slot)
        chosen.armor.push(it)
        have = sumBonus([{ bonus: haveBase }, ...chosen.tears, ...chosen.talismans, ...chosen.armor])
      }

      const finalEff = applyTwoHand(have, th)
      const ok = STATS.every(k => finalEff[k] >= (req[k] || 0))
      const sc = scoreCost(chosen)
      if (ok && (!best || sc < best.score)) {
        best = { ...chosen, score: sc }
      } else if (!ok) {
        const remaining = Object.values(shortfall(have, req, th)).reduce((a, b) => a + b, 0)
        if (!bestAttempt || remaining < bestAttempt.remaining ||
            (remaining === bestAttempt.remaining && sc < bestAttempt.score)) {
          bestAttempt = { ...chosen, score: sc, remaining }
        }
      }
    }
  }

  return best
    ? { solvable: true, loadout: best }
    : { solvable: false, loadout: null, bestAttempt }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtBonus(bonus) {
  if (!bonus) return ''
  return STATS.filter(k => bonus[k]).map(k => `+${bonus[k]} ${k}`).join(' · ')
}

// ── StatPip ───────────────────────────────────────────────────────────────────

function StatPip({ stat, have, need, twoHand }) {
  const eff = stat === 'STR' && twoHand ? Math.floor(have * 1.5) : have
  const ok = eff >= need
  const bonus = eff - 10
  const hue = STAT_HUE[stat]
  return (
    <div className="stat-pip" data-ok={ok ? '1' : '0'}>
      <div className="stat-pip-label">{stat}</div>
      <div className="stat-pip-num">
        <span className="stat-eff" style={{ color: `oklch(0.78 0.14 ${hue})` }}>{eff}</span>
        <span className="stat-need"> / {need || '—'}</span>
      </div>
      {bonus > 0 && (
        <div className="stat-pip-bonus">+{bonus}{stat === 'STR' && twoHand ? ' (2H)' : ''}</div>
      )}
    </div>
  )
}

// ── SlotCard ──────────────────────────────────────────────────────────────────

function SlotCard({ kind, item, onClear, onClick, locked, showFlavor, active }) {
  const empty = !item
  const slotLabel = kind === 'talisman' ? 'Talisman'
    : kind === 'tear' ? 'Crystal Tear'
    : kind === 'rune' ? 'Great Rune'
    : `Armor · ${locked || 'any'}`
  const bonusText = item ? fmtBonus(item.bonus) : ''
  return (
    <button className="slot" data-empty={empty ? '1' : '0'} data-active={active ? '1' : '0'} data-kind={kind} onClick={onClick}>
      <div className="slot-frame">
        <div className="slot-corner tl" /><div className="slot-corner tr" />
        <div className="slot-corner bl" /><div className="slot-corner br" />
        {empty ? (
          <div className="slot-empty">
            <div className="slot-icon" data-kind={kind} />
            <div className="slot-empty-label">{slotLabel}</div>
            <div className="slot-empty-hint">tap to equip</div>
          </div>
        ) : (
          <div className="slot-filled">
            {/* item.image && <img className="slot-item-img" src={wikiImg(item.image)} alt="" onError={e => { e.target.style.display = 'none' }} /> */}
            <div className="slot-name">{item.name}</div>
            {bonusText && <div className="slot-bonus">{bonusText}</div>}
            {showFlavor && item.flavor && <div className="slot-flavor">{item.flavor}</div>}
            <div className="slot-actions">
              <span className="slot-clear" onClick={e => { e.stopPropagation(); onClear() }}>remove</span>
            </div>
          </div>
        )}
      </div>
    </button>
  )
}

// ── Picker ────────────────────────────────────────────────────────────────────

function Picker({ open, kind, slotConstraint, excludeIds, onPick, onClose, activeTalismans, activeTears, activeArmor }) {
  const [q, setQ] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    if (open) { setQ(''); setTimeout(() => inputRef.current?.focus(), 0) }
  }, [open])

  if (!open) return null

  let pool = []
  if (kind === 'talisman') pool = activeTalismans ?? TALISMANS
  else if (kind === 'tear') pool = activeTears ?? TEARS
  else if (kind === 'armor') pool = (activeArmor ?? ARMOR).filter(a => !slotConstraint || a.slot === slotConstraint)
  else if (kind === 'rune') pool = RUNES.slice(1)

  const filtered = pool.filter(it => {
    if (excludeIds.has(it.id)) return false
    return !q.trim() || it.name.toLowerCase().includes(q.toLowerCase())
  })

  const kindLabel = kind === 'tear' ? 'Crystal Tear'
    : kind === 'talisman' ? 'Talisman'
    : kind === 'rune' ? 'Great Rune'
    : slotConstraint ? slotConstraint.charAt(0).toUpperCase() + slotConstraint.slice(1)
    : 'Armor'

  return (
    <div className="picker-backdrop" onClick={onClose}>
      <div className="picker" onClick={e => e.stopPropagation()}>
        <div className="picker-hd">
          <div className="picker-title">Equip {kindLabel}</div>
          <button className="picker-x" onClick={onClose}>✕</button>
        </div>
        <input
          ref={inputRef}
          className="picker-search"
          placeholder="Search…"
          value={q}
          onChange={e => setQ(e.target.value)}
        />
        <div className="picker-body">
          {filtered.length === 0 && <div className="picker-empty">No items match.</div>}
          {filtered.map(it => (
            <button key={it.id} className="picker-item" onClick={() => onPick(it)}>
              <div className="picker-item-name">
                {/* it.image && <img className="picker-item-img" src={wikiImg(it.image)} alt="" onError={e => { e.target.style.display = 'none' }} /> */}
                {it.name}
                {it.dlc && <span className="wp-sote">SOTE</span>}
              </div>
              {fmtBonus(it.bonus) && <div className="picker-item-bonus">{fmtBonus(it.bonus)}</div>}
              {it.flavor && <div className="picker-item-flavor">{it.flavor}</div>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── WeaponPicker ──────────────────────────────────────────────────────────────

function WeaponPicker({ weapon, onChange }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDoc = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const filtered = q.trim()
    ? WEAPONS.filter(w => (w.name + ' ' + w.cat).toLowerCase().includes(q.toLowerCase()))
    : WEAPONS

  return (
    <div className="weapon-picker" ref={ref}>
      <button className="weapon-picker-btn" onClick={() => setOpen(v => !v)}>
        <div className="weapon-picker-cat">{weapon.cat}</div>
        <div className="weapon-picker-name">{weapon.name}</div>
        <div className="weapon-picker-caret">▾</div>
      </button>
      {open && (
        <div className="weapon-picker-pop">
          <input
            className="weapon-picker-search"
            placeholder="Search weapons…"
            value={q}
            onChange={e => setQ(e.target.value)}
            autoFocus
          />
          <div className="weapon-picker-list">
            {filtered.map(w => (
              <button key={w.id} className="weapon-picker-row"
                      data-active={w.id === weapon.id ? '1' : '0'}
                      onClick={() => { onChange(w); setOpen(false); setQ('') }}>
                <div className="wp-name">{w.name}</div>
                <div className="wp-cat">
                  {w.cat}
                  {w.dlc && <span className="wp-sote">SOTE</span>}
                </div>
                <div className="wp-req">
                  {STATS.filter(k => w.req[k]).map(k => (
                    <span key={k} className="wp-req-pill" style={{ '--hue': STAT_HUE[k] }}>
                      {w.req[k]} {k}
                    </span>
                  ))}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── ExclSection ───────────────────────────────────────────────────────────────

function ExclSection({ title, items, excludedIds, onToggle }) {
  const [filter, setFilter] = useState('')
  const visible = filter.trim()
    ? items.filter(it => it.name.toLowerCase().includes(filter.toLowerCase()))
    : items
  return (
    <div className="excl-section">
      <div className="advanced-group-title">{title}</div>
      <input
        className="excl-filter"
        placeholder="Filter…"
        value={filter}
        onChange={e => setFilter(e.target.value)}
      />
      <div className="excl-list">
        {visible.map(it => {
          const excluded = excludedIds.has(it.id)
          return (
            <button key={it.id} className="excl-list-item" data-excluded={excluded ? '1' : '0'} onClick={() => onToggle(it.id)}>
              <span className="excl-list-name">
                {it.name}
                {it.dlc && <span className="wp-sote">SOTE</span>}
              </span>
              {fmtBonus(it.bonus) && <span className="excl-list-bonus">{fmtBonus(it.bonus)}</span>}
              {excluded && <span className="excl-list-x">✕</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── SolutionsList ─────────────────────────────────────────────────────────────

function SolutionsList({ solutions, onApply }) {
  const [open, setOpen] = useState(false)
  if (solutions.length === 0) return null
  return (
    <div className="solutions-list">
      <button className="solutions-hd" onClick={() => setOpen(v => !v)}>
        <span>{solutions.length} solution{solutions.length !== 1 ? 's' : ''} found</span>
        <span className="solutions-hd-right">
          <span className="solutions-caret">{open ? '▴' : '▾'}</span>
        </span>
      </button>
      {open && (
        <div className="solutions-scroll">
          {solutions.map((lo, i) => {
            const tags = []
            if (lo.twoHand) tags.push({ key: 'th', label: 'Two-hand', kind: 'mod' })
            if (lo.rune.id !== 'rune_none') tags.push({ key: lo.rune.id, label: lo.rune.name, kind: 'rune' })
            lo.tears.forEach(t => tags.push({ key: t.id, label: t.name, kind: 'tear' }))
            lo.talismans.forEach(t => tags.push({ key: t.id, label: t.name, kind: 'tal' }))
            lo.armor.forEach(a => tags.push({ key: a.id, label: a.name, kind: 'armor' }))
            return (
              <div key={i} className="solution-row">
                <span className="solution-rank">#{i + 1}</span>
                <div className="solution-tags">
                  {tags.length === 0
                    ? <span className="solution-none">No items needed</span>
                    : tags.map(t => <span key={t.key} className="solution-tag" data-kind={t.kind}>{t.label}</span>)
                  }
                </div>
                <button className="solution-apply" onClick={() => onApply(lo)}>Apply</button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── WeaponList ────────────────────────────────────────────────────────────────

function WeaponList({ haveStats, twoHand, includeDLC }) {
  const [q, setQ] = useState('')

  const usable = useMemo(() => {
    return WEAPONS.filter(w => {
      if (!includeDLC && w.dlc) return false
      return STATS.every(k => {
        const eff = k === 'STR' && twoHand ? Math.floor(haveStats[k] * 1.5) : haveStats[k]
        return eff >= (w.req[k] || 0)
      })
    })
  }, [haveStats, twoHand, includeDLC])

  const filtered = q.trim()
    ? usable.filter(w => (w.name + ' ' + w.cat).toLowerCase().includes(q.toLowerCase()))
    : usable

  return (
    <div className="weapon-list">
      <div className="weapon-list-hd">
        <span className="weapon-list-count">
          {usable.length} weapon{usable.length !== 1 ? 's' : ''} usable
        </span>
        <input
          className="weapon-list-search"
          placeholder="Filter…"
          value={q}
          onChange={e => setQ(e.target.value)}
        />
      </div>
      <div className="weapon-list-scroll">
        {filtered.length === 0
          ? <div className="weapon-list-empty">No weapons match.</div>
          : filtered.map(w => (
            <div key={w.id} className="weapon-list-row">
              <div className="wl-left">
                <span className="wl-name">{w.name}</span>
                {w.dlc && <span className="wp-sote">SOTE</span>}
              </div>
              <div className="wl-cat">{w.cat}</div>
              <div className="wl-req">
                {STATS.filter(k => w.req[k]).map(k => (
                  <span key={k} className="wp-req-pill" style={{ '--hue': STAT_HUE[k] }}>
                    {w.req[k]} {k}
                  </span>
                ))}
                {!STATS.some(k => w.req[k]) && <span className="wl-no-req">—</span>}
              </div>
            </div>
          ))
        }
      </div>
    </div>
  )
}

// ── App ───────────────────────────────────────────────────────────────────────

const DEFAULT_WEAPON = WEAPONS.find(w => w.name === 'Greatsword') || WEAPONS[0]

export default function App() {
  const [weapon, setWeapon] = useState(DEFAULT_WEAPON)
  const [twoHand, setTwoHand] = useState(false)
  const [rune, setRune] = useState(RUNES[0])
  const [talismans, setTalismans] = useState([null, null, null, null])
  const [tears, setTears] = useState([null, null])
  const [armor, setArmor] = useState({ head: null, chest: null, arms: null, legs: null })
  const [picker, setPicker] = useState(null)
  const [infoOpen, setInfoOpen] = useState(false)
  const [solveAllowRune, setSolveAllowRune] = useState(true)
  const [solveAllowTear, setSolveAllowTear] = useState(true)
  const [solveAllowTwoHand, setSolveAllowTwoHand] = useState(true)
  const [solveKeepLoadout, setSolveKeepLoadout] = useState(false)

  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [includeDLC, setIncludeDLC] = useState(true)
  const [excludedIds, setExcludedIds] = useState(new Set())
  const [statBoostOnly, setStatBoostOnly] = useState(false)

  const [mode, setMode] = useState('find-loadout')

  const equippedItems = [
    ...talismans.filter(Boolean),
    ...tears.filter(Boolean),
    ...Object.values(armor).filter(Boolean),
  ]

  const haveStats = useMemo(() => sumBonus([
    { bonus: BASE_STATS },
    { bonus: rune.bonus || {} },
    ...equippedItems,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ]), [rune, talismans, tears, armor])

  const meetsAll = STATS.every(k => {
    const eff = k === 'STR' && twoHand ? Math.floor(haveStats[k] * 1.5) : haveStats[k]
    return eff >= (weapon.req[k] || 0)
  })

  const shortfallStats = STATS.filter(k => {
    const eff = k === 'STR' && twoHand ? Math.floor(haveStats[k] * 1.5) : haveStats[k]
    return eff < (weapon.req[k] || 0)
  })

  const usedTalismanIds = useMemo(() => {
    const ids = new Set(talismans.filter(Boolean).map(x => x.id))
    for (const t of talismans.filter(Boolean)) {
      const counterpart = TALISMAN_COUNTERPART[t.name]
      if (counterpart) ids.add(TALISMAN_BY_NAME[counterpart])
    }
    return ids
  }, [talismans])
  const usedTearIds = useMemo(() => new Set(tears.filter(Boolean).map(x => x.id)), [tears])

  const openPicker = (kind, slot, idx) => setPicker({ kind, slot, idx })
  const closePicker = () => setPicker(null)

  const handlePick = item => {
    const { kind, slot, idx } = picker
    if (kind === 'talisman') {
      const next = [...talismans]; next[idx] = item; setTalismans(next)
    } else if (kind === 'tear') {
      const next = [...tears]; next[idx] = item; setTears(next)
    } else if (kind === 'rune') {
      setRune(item)
    } else {
      setArmor(prev => ({ ...prev, [slot]: item }))
    }
    closePicker()
  }

  const clearTalisman = idx => { const n = [...talismans]; n[idx] = null; setTalismans(n) }
  const clearTear = idx => { const n = [...tears]; n[idx] = null; setTears(n) }
  const clearArmor = slot => setArmor(prev => ({ ...prev, [slot]: null }))

  const clearAll = () => {
    setTalismans([null, null, null, null])
    setTears([null, null])
    setArmor({ head: null, chest: null, arms: null, legs: null })
    setRune(RUNES[0])
    setTwoHand(false)
  }


  const activeTalismans = useMemo(
    () => TALISMANS.filter(t => (includeDLC || !t.dlc) && !excludedIds.has(t.id) && (!statBoostOnly || fmtBonus(t.bonus))),
    [includeDLC, excludedIds, statBoostOnly]
  )
  const activeTears = useMemo(
    () => TEARS.filter(t => (includeDLC || !t.dlc) && !excludedIds.has(t.id) && (!statBoostOnly || fmtBonus(t.bonus))),
    [includeDLC, excludedIds, statBoostOnly]
  )
  const activeArmor = useMemo(
    () => ARMOR.filter(a => (includeDLC || !a.dlc)),
    [includeDLC]
  )
  const activeRunes = useMemo(
    () => RUNES.filter(r => r.id === 'rune_none' || !excludedIds.has(r.id)),
    [excludedIds]
  )

  const addExcluded = id => setExcludedIds(prev => new Set([...prev, id]))
  const removeExcluded = id => setExcludedIds(prev => { const s = new Set(prev); s.delete(id); return s })

  const allSolutions = useMemo(
    () => solveAll(weapon, { allowGreatRune: solveAllowRune, allowArmor: false, allowTwoHand: solveAllowTwoHand, allowTear: solveAllowTear, talismanPool: activeTalismans, tearPool: activeTears, runeData: activeRunes }),
    [weapon, solveAllowRune, solveAllowTwoHand, solveAllowTear, activeTalismans, activeTears, activeRunes]
  )
  const solvable = allSolutions.length > 0
  const closestAttempt = useMemo(
    () => { if (solvable) return null; const r = solve(weapon, { allowTwoHand: solveAllowTwoHand, allowGreatRune: solveAllowRune, allowTear: solveAllowTear, talismanPool: activeTalismans, tearPool: activeTears, runeData: activeRunes }); return r.loadout ?? r.bestAttempt },
    [weapon, solvable, solveAllowTwoHand, solveAllowRune, solveAllowTear, activeTalismans, activeTears, activeRunes]
  )

  const mergeFill = (source) => {
    const existingTalIds = new Set(talismans.filter(Boolean).map(t => t.id))
    const newTals = [...talismans]
    for (const it of source.talismans) {
      if (!existingTalIds.has(it.id)) {
        const empty = newTals.findIndex(s => !s)
        if (empty !== -1) { newTals[empty] = it; existingTalIds.add(it.id) }
      }
    }
    const existingTearIds = new Set(tears.filter(Boolean).map(t => t.id))
    const newTears = [...tears]
    for (const it of source.tears) {
      if (!existingTearIds.has(it.id)) {
        const empty = newTears.findIndex(s => !s)
        if (empty !== -1) { newTears[empty] = it; existingTearIds.add(it.id) }
      }
    }
    setTalismans(newTals)
    setTears(newTears)
    if (rune.id === 'rune_none') setRune(source.rune)
  }

  const filteredSolutions = useMemo(() => {
    if (!solveKeepLoadout) return allSolutions
    const equippedTalIds = new Set(talismans.filter(Boolean).map(t => t.id))
    const equippedTearIds = new Set(tears.filter(Boolean).map(t => t.id))
    return allSolutions.filter(sol => {
      const mergedTals = [...talismans]
      const seenTal = new Set(equippedTalIds)
      for (const it of sol.talismans) {
        if (!seenTal.has(it.id)) {
          const empty = mergedTals.findIndex(s => !s)
          if (empty !== -1) { mergedTals[empty] = it; seenTal.add(it.id) }
        }
      }
      const mergedTears = [...tears]
      const seenTear = new Set(equippedTearIds)
      for (const it of sol.tears) {
        if (!seenTear.has(it.id)) {
          const empty = mergedTears.findIndex(s => !s)
          if (empty !== -1) { mergedTears[empty] = it; seenTear.add(it.id) }
        }
      }
      const mergedRune = rune.id !== 'rune_none' ? rune : sol.rune
      const have = sumBonus([{ bonus: BASE_STATS }, { bonus: mergedRune.bonus || {} }, ...mergedTals.filter(Boolean), ...mergedTears.filter(Boolean)])
      return STATS.every(k => {
        const eff = k === 'STR' && sol.twoHand ? Math.floor(have[k] * 1.5) : have[k]
        return eff >= (weapon.req[k] || 0)
      })
    })
  }, [allSolutions, solveKeepLoadout, talismans, tears, rune, weapon])

  const applyLoadout = (lo) => {
    setRune(lo.rune)
    setTwoHand(lo.twoHand)
    const tals = [null, null, null, null]
    lo.talismans.forEach((it, i) => { tals[i] = it })
    setTalismans(tals)
    const trs = [null, null]
    lo.tears.forEach((it, i) => { trs[i] = it })
    setTears(trs)
    const arm = { head: null, chest: null, arms: null, legs: null }
    lo.armor.forEach(it => { arm[it.slot] = it })
    setArmor(arm)
  }

  const handleSolve = () => {
    if (!solvable) return
    solveKeepLoadout ? mergeFill(filteredSolutions[0] ?? allSolutions[0]) : applyLoadout(allSolutions[0])
  }

  const handleSolveClosest = () => {
    if (solveKeepLoadout) {
      const source = filteredSolutions.length > 0 ? filteredSolutions[0] : null
      if (source) mergeFill(source)
    } else {
      const source = allSolutions.length > 0 ? allSolutions[0] : closestAttempt
      if (source) applyLoadout(source)
    }
  }

  const hasModifiers = equippedItems.length > 0 || twoHand || rune.id !== 'rune_none'
  const hasReqs = STATS.some(k => weapon.req[k])

  return (
    <div className="app" data-theme="dark">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">◇</div>
          <div className="brand-text">
            <div className="brand-title">Elden Ring RL1 Weapon Audit</div>
            <div className="brand-sub">Rune Level 1 · base stats 10/10/10/10/10</div>
          </div>
        </div>
        <div className="topbar-actions">
          <button className="btn-ghost" onClick={() => setAdvancedOpen(v => !v)} data-on={advancedOpen ? '1' : '0'} style={{ fontSize: '11px', letterSpacing: '0.1em', fontWeight: 600, textTransform: 'uppercase' }}>Advanced</button>
          <button className="btn-ghost" onClick={clearAll} style={{ fontSize: '11px', letterSpacing: '0.1em', fontWeight: 600, textTransform: 'uppercase' }}>Clear</button>
          {mode === 'find-loadout' && (
            <button className="btn-primary" onClick={handleSolve} disabled={!solvable}>
              {solvable ? (
                <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px' }}>
                  <span>Solution Found</span>
                  <span style={{ fontSize: '6px', letterSpacing: '0.12em', opacity: 0.7, lineHeight: 1 }}>VIEW</span>
                </span>
              ) : 'No Solution'}
            </button>
          )}
        </div>
      </header>

      <div className="mode-bar">
        <button className="mode-tab" data-active={mode === 'find-loadout' ? '1' : '0'} onClick={() => setMode('find-loadout')}>Weapon Audit</button>
        <button className="mode-tab" data-active={mode === 'find-weapons' ? '1' : '0'} onClick={() => setMode('find-weapons')}>Loadout Check</button>
      </div>

      {mode === 'find-weapons' && (
        <div className="mode-desc">
          <span className="mode-desc-eyebrow">Loadout Check</span>
          Build your loadout on the left — talismans, tears, armor, and modifiers. Every weapon whose stat requirements your current build meets at RL1 will appear on the right.
        </div>
      )}

      {mode === 'find-loadout' && (
        <section className="weapon-bar">
          <div className="weapon-bar-left">
            <div className="weapon-bar-eyebrow">Weapon under audit</div>
            <WeaponPicker weapon={weapon} onChange={setWeapon} />
          </div>
          <div className="weapon-bar-right">
            <div className="weapon-bar-eyebrow">Requirements</div>
            <div className="req-row-wrap">
              <div className="req-row">
                {hasReqs
                  ? STATS.map(k => weapon.req[k] ? (
                      <div key={k} className="req-chip" style={{ '--hue': STAT_HUE[k] }}>
                        <span className="req-chip-stat">{k}</span>
                        <span className="req-chip-num">{weapon.req[k]}</span>
                      </div>
                    ) : null)
                  : <span style={{ color: 'var(--ink-3)', fontStyle: 'italic' }}>No stat requirements</span>
                }
              </div>
              <button
                className="weapon-info-toggle"
                data-on={infoOpen ? '1' : '0'}
                onClick={() => setInfoOpen(v => !v)}
                title="Weapon details"
              >
                Details {infoOpen ? '▴' : '▾'}
              </button>
            </div>
          </div>
          {infoOpen && (
            <div className="weapon-info-panel">
              {weapon.dlc && (
                <>
                  <span className="weapon-sote-badge">SOTE</span>
                  <div className="weapon-info-sep" style={{ marginLeft: 20 }} />
                </>
              )}
              <div className="weapon-info-block">
                <div className="weapon-info-label">Attack Type</div>
                <div className="weapon-info-value">{weapon.attackType || '—'}</div>
              </div>
              <div className="weapon-info-sep" />
              <div className="weapon-info-block">
                <div className="weapon-info-label">Scaling</div>
                <div className="weapon-scaling-chips">
                  {STATS.filter(k => weapon.scaling[k]).map(k => (
                    <span key={k} className="weapon-scaling-chip" style={{ '--hue': STAT_HUE[k] }}>
                      <span className="scaling-stat">{k}</span>
                      <span className="scaling-grade" data-grade={weapon.scaling[k]}>{weapon.scaling[k]}</span>
                    </span>
                  ))}
                  {!STATS.some(k => weapon.scaling[k]) && (
                    <span style={{ color: 'var(--ink-3)', fontStyle: 'italic' }}>None</span>
                  )}
                </div>
              </div>
              <div className="weapon-info-sep" />
              <div className="weapon-info-block">
                <div className="weapon-info-label">Base Attack</div>
                <div className="weapon-atk-chips">
                  {ATK_ORDER.filter(k => weapon.stats[k] > 0).map(k => (
                    <span key={k} className="weapon-atk-chip" data-type={k} style={ATK_HUE[k] ? { '--hue': ATK_HUE[k] } : {}}>
                      <span className="atk-val">{weapon.stats[k]}</span>
                      <span className="atk-type">{ATK_LABEL[k]}</span>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {advancedOpen && (
        <section className="advanced-panel">
          <div className="advanced-panel-grid">

            <div className="advanced-group">
              <div className="advanced-group-title">DLC Content (Shadow of the Erdtree)</div>
              <button className="solve-toggle" data-on={includeDLC ? '1' : '0'} onClick={() => setIncludeDLC(v => !v)}>
                <span>Include DLC Talismans, Tears &amp; Armor</span>
                <span className="solve-toggle-state">
                  <span className="solve-toggle-label">Off</span>
                  <span className="solve-toggle-label">On</span>
                </span>
              </button>
            </div>

            <ExclSection
              title="Exclude Talismans"
              items={TALISMANS}
              excludedIds={excludedIds}
              onToggle={id => excludedIds.has(id) ? removeExcluded(id) : addExcluded(id)}
            />
            <ExclSection
              title="Exclude Crystal Tears"
              items={TEARS}
              excludedIds={excludedIds}
              onToggle={id => excludedIds.has(id) ? removeExcluded(id) : addExcluded(id)}
            />

          </div>
        </section>
      )}

      <main className="main-grid">
        <div className="slot-region">
          <div className="slot-region-title">
            <span>Equipment</span>
            <div style={{ display: 'flex', gap: '16px' }}>
              <button className="solve-toggle" data-on={statBoostOnly ? '1' : '0'} onClick={() => setStatBoostOnly(v => !v)}>
                <span>Show Only Stat Boosting Items</span>
                <span className="solve-toggle-state">
                  <span className="solve-toggle-label">Off</span>
                  <span className="solve-toggle-label">On</span>
                </span>
              </button>
              <button className="solve-toggle" data-on={solveKeepLoadout ? '1' : '0'} onClick={() => setSolveKeepLoadout(v => !v)}>
                <span>Keep Current Loadout</span>
                <span className="solve-toggle-state">
                  <span className="solve-toggle-label">Off</span>
                  <span className="solve-toggle-label">On</span>
                </span>
              </button>
            </div>
          </div>

          <div className="region">
            <div className="region-hd">
              <h3>Talismans</h3>
              <div className="region-meta">{talismans.filter(Boolean).length}/4</div>
            </div>
            <div className="grid-4">
              {talismans.map((it, i) => (
                <SlotCard key={i} kind="talisman" item={it} showFlavor={true}
                          onClick={() => openPicker('talisman', null, i)}
                          onClear={() => clearTalisman(i)} />
              ))}
            </div>
          </div>

          <div className="region">
            <div className="region-hd">
              <h3>Crystal Tears <span className="region-aside">— mixed into the flask</span></h3>
              <div className="region-meta">{tears.filter(Boolean).length}/2</div>
            </div>
            <div className="grid-2">
              {tears.map((it, i) => (
                <SlotCard key={i} kind="tear" item={it} showFlavor={true}
                          onClick={() => openPicker('tear', null, i)}
                          onClear={() => clearTear(i)} />
              ))}
            </div>
          </div>

          <div className="region">
            <div className="region-hd">
              <h3>Armor <span className="region-aside">— stat-bearing pieces only</span></h3>
              <div className="region-meta">{Object.values(armor).filter(Boolean).length}/4</div>
            </div>
            <div className="grid-4">
              {['head', 'chest', 'arms', 'legs'].map(slot => (
                <SlotCard key={slot} kind="armor" locked={slot} item={armor[slot]} showFlavor={true}
                          onClick={() => openPicker('armor', slot, null)}
                          onClear={() => clearArmor(slot)} />
              ))}
            </div>
          </div>

          <div className="region">
            <div className="region-hd"><h3>Modifiers</h3></div>
            <div className="modifier-row">
              <button className="mod-card" data-on={twoHand ? '1' : '0'} onClick={() => setTwoHand(v => !v)}>
                <div className="mod-card-title">Two-handing</div>
                <div className="mod-card-sub">×1.5 STR (rounded down)</div>
                <div className="mod-card-state">{twoHand ? 'On' : 'Off'}</div>
              </button>
              <SlotCard kind="rune" item={rune.id === 'rune_none' ? null : rune} showFlavor={true}
                        active={rune.id !== 'rune_none'}
                        onClick={() => openPicker('rune', null, null)}
                        onClear={() => setRune(RUNES[0])} />
            </div>
          </div>

        </div>

        <aside className="totals">
          {mode === 'find-loadout' ? (
            <>
              <div className="solve-options">
                <div className="solve-options-hd">Modifiers</div>
                <button className="solve-toggle" data-on={solveAllowRune ? '1' : '0'}
                        onClick={() => setSolveAllowRune(v => !v)}>
                  <span>Allow Godrick's Great Rune</span>
                  <span className="solve-toggle-state">
                    <span className="solve-toggle-label">Off</span>
                    <span className="solve-toggle-label">On</span>
                  </span>
                </button>
                <button className="solve-toggle" data-on={solveAllowTear ? '1' : '0'}
                        onClick={() => setSolveAllowTear(v => !v)}>
                  <span>Allow Mixed Physick</span>
                  <span className="solve-toggle-state">
                    <span className="solve-toggle-label">Off</span>
                    <span className="solve-toggle-label">On</span>
                  </span>
                </button>
                <button className="solve-toggle" data-on={solveAllowTwoHand ? '1' : '0'}
                        onClick={() => setSolveAllowTwoHand(v => !v)}>
                  <span>Allow Two-Handing</span>
                  <span className="solve-toggle-state">
                    <span className="solve-toggle-label">Off</span>
                    <span className="solve-toggle-label">On</span>
                  </span>
                </button>
              </div>
              <button className="btn-primary" style={{ width: '100%' }} onClick={handleSolveClosest}>
                Auto-solve
              </button>
              <SolutionsList solutions={filteredSolutions} onApply={solveKeepLoadout ? mergeFill : applyLoadout} />
              <div className={`verdict ${meetsAll ? 'verdict-ok' : 'verdict-no'}`}>
                <div className="verdict-mark">{meetsAll ? '✓' : '✕'}</div>
                <div className="verdict-text">
                  <div className="verdict-line1">{meetsAll ? 'Wieldable' : 'Cannot wield'}</div>
                  <div className="verdict-line2">
                    {meetsAll
                      ? 'All requirements met with current loadout.'
                      : shortfallStats.length > 0
                        ? `Short on ${shortfallStats.join(', ')}.`
                        : 'Equip items or use Auto-solve.'}
                  </div>
                </div>
              </div>

              <div className="totals-block">
                <div className="totals-hd">Effective stats</div>
                <div className="stat-pips">
                  {STATS.map(k => (
                    <StatPip key={k} stat={k} have={haveStats[k]} need={weapon.req[k] || 0} twoHand={twoHand} />
                  ))}
                </div>
              </div>

              <div className="totals-block breakdown">
                <div className="totals-hd">Breakdown</div>
                <div className="breakdown-row">
                  <span>Base (RL1)</span><span>10 / 10 / 10 / 10 / 10</span>
                </div>
                {rune.bonus && Object.keys(rune.bonus).length > 0 && (
                  <div className="breakdown-row">
                    <span>{rune.name}</span><span>{fmtBonus(rune.bonus)}</span>
                  </div>
                )}
                {tears.filter(Boolean).map((it, i) => (
                  <div key={'t' + i} className="breakdown-row">
                    <span>{it.name}</span><span>{fmtBonus(it.bonus)}</span>
                  </div>
                ))}
                {talismans.filter(Boolean).map((it, i) => (
                  <div key={'tl' + i} className="breakdown-row">
                    <span>{it.name}</span><span>{fmtBonus(it.bonus)}</span>
                  </div>
                ))}
                {Object.values(armor).filter(Boolean).map((it, i) => (
                  <div key={'a' + i} className="breakdown-row">
                    <span>{it.name}</span><span>{fmtBonus(it.bonus)}</span>
                  </div>
                ))}
                {twoHand && weapon.req.STR > 0 && (
                  <div className="breakdown-row breakdown-mult">
                    <span>Two-handing</span><span>STR × 1.5</span>
                  </div>
                )}
                {!hasModifiers && (
                  <div className="breakdown-row breakdown-empty">
                    <span>No modifiers active</span><span>—</span>
                  </div>
                )}
              </div>

              <div className="totals-foot">
                {solvable
                  ? <span>{allSolutions.length} valid loadout{allSolutions.length !== 1 ? 's' : ''} found for this weapon at RL1.</span>
                  : <span className="totals-foot-no">No combination of slots can meet this weapon's requirements at RL1.</span>}
              </div>
            </>
          ) : (
            <>
              <div className="totals-block">
                <div className="totals-hd">Effective stats</div>
                <div className="stat-pips">
                  {STATS.map(k => (
                    <StatPip key={k} stat={k} have={haveStats[k]} need={0} twoHand={twoHand} />
                  ))}
                </div>
              </div>
              <WeaponList haveStats={haveStats} twoHand={twoHand} includeDLC={includeDLC} />
            </>
          )}
        </aside>
      </main>

      <Picker
        open={!!picker}
        kind={picker?.kind}
        slotConstraint={picker?.slot}
        excludeIds={
          picker?.kind === 'talisman' ? usedTalismanIds
          : picker?.kind === 'tear' ? usedTearIds
          : new Set()
        }
        onPick={handlePick}
        onClose={closePicker}
        activeTalismans={activeTalismans}
        activeTears={activeTears}
        activeArmor={activeArmor}
      />
    </div>
  )
}
