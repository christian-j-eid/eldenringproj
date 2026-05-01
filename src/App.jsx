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
}))

const TEARS = rawData.crystalTears.map(t => ({
  id: uid('cr'),
  name: t.name,
  flavor: t.effect,
  bonus: normStats(t.boosts),
}))

const ARMOR = rawData.armor.map(a => ({
  id: uid('a'),
  name: a.name,
  slot: a.slot.toLowerCase(),
  bonus: normStats(a.boosts),
}))

const RUNES = [
  { id: 'rune_none', name: 'None', bonus: {} },
  ...rawData.greatRunes.map(r => ({
    id: uid('rune'),
    name: r.name,
    flavor: r.effect,
    bonus: normStats(r.boosts),
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

function solve(weapon, { allowTwoHand = true, allowGreatRune = true, allowTear = true } = {}) {
  const req = weapon.req
  let best = null
  let bestAttempt = null

  const runePool = allowGreatRune ? RUNES : [RUNES[0]]
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
        const it = pickBest(TEARS, usedTears)
        if (!it) break
        usedTears.add(it.id)
        chosen.tears.push(it)
        have = sumBonus([{ bonus: haveBase }, ...chosen.tears, ...chosen.talismans, ...chosen.armor])
      }

      const usedTal = new Set()
      for (let i = 0; i < 4 && stillNeed(); i++) {
        const it = pickBest(TALISMANS, usedTal)
        if (!it) break
        usedTal.add(it.id)
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

function Picker({ open, kind, slotConstraint, excludeIds, onPick, onClose }) {
  const [q, setQ] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    if (open) { setQ(''); setTimeout(() => inputRef.current?.focus(), 0) }
  }, [open])

  if (!open) return null

  let pool = []
  if (kind === 'talisman') pool = TALISMANS
  else if (kind === 'tear') pool = TEARS
  else if (kind === 'armor') pool = ARMOR.filter(a => !slotConstraint || a.slot === slotConstraint)
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
              <div className="picker-item-name">{it.name}</div>
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
                <div className="wp-cat">{w.cat}</div>
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
  const [solveAllowTwoHand, setSolveAllowTwoHand] = useState(true)
  const [solveAllowRune, setSolveAllowRune] = useState(true)
  const [solveAllowTear, setSolveAllowTear] = useState(true)

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

  const usedTalismanIds = useMemo(() => new Set(talismans.filter(Boolean).map(x => x.id)), [talismans])
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

  useEffect(() => { if (twoHand) setSolveAllowTwoHand(true) }, [twoHand])

  const solveResult = useMemo(
    () => solve(weapon, { allowTwoHand: solveAllowTwoHand, allowGreatRune: solveAllowRune, allowTear: solveAllowTear }),
    [weapon, solveAllowTwoHand, solveAllowRune, solveAllowTear]
  )

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
    if (!solveResult.solvable) return
    applyLoadout(solveResult.loadout)
  }

  const handleSolveClosest = () => {
    if (solveResult.solvable) applyLoadout(solveResult.loadout)
    else if (solveResult.bestAttempt) applyLoadout(solveResult.bestAttempt)
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
          <button className="btn-ghost" onClick={clearAll} style={{ fontSize: '11px', letterSpacing: '0.1em', fontWeight: 600, textTransform: 'uppercase' }}>Clear</button>
          <button className="btn-primary" onClick={handleSolve} disabled={!solveResult.solvable}>
            {solveResult.solvable ? (
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px' }}>
                <span>Solution Found</span>
                <span style={{ fontSize: '6px', letterSpacing: '0.12em', opacity: 0.7, lineHeight: 1 }}>VIEW</span>
              </span>
            ) : 'No Solution'}
          </button>
        </div>
      </header>

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

      <main className="main-grid">
        <div className="slot-region">

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
          <div className="solve-options">
            <div className="solve-options-hd">Modifiers</div>
            <button className="solve-toggle" data-on={solveAllowRune ? '1' : '0'}
                    onClick={() => setSolveAllowRune(v => !v)}>
              <span>Use Great Rune</span>
              <span className="solve-toggle-state">
                <span className="solve-toggle-label">Off</span>
                <span className="solve-toggle-label">On</span>
              </span>
            </button>
            <button className="solve-toggle" data-on={solveAllowTear ? '1' : '0'}
                    onClick={() => setSolveAllowTear(v => !v)}>
              <span>Drink Mixed Physick</span>
              <span className="solve-toggle-state">
                <span className="solve-toggle-label">Off</span>
                <span className="solve-toggle-label">On</span>
              </span>
            </button>
            <button className="solve-toggle" data-on={solveAllowTwoHand ? '1' : '0'}
                    onClick={() => setSolveAllowTwoHand(v => !v)}>
              <span>Two-Hand Weapon</span>
              <span className="solve-toggle-state">
                <span className="solve-toggle-label">Off</span>
                <span className="solve-toggle-label">On</span>
              </span>
            </button>
          </div>
          <button className="btn-primary" style={{ width: '100%' }} onClick={handleSolveClosest}>
            Auto-solve
          </button>
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
            {solveResult.solvable
              ? <span>A valid loadout exists for this weapon at RL1.</span>
              : <span className="totals-foot-no">No combination of slots can meet this weapon's requirements at RL1.</span>}
          </div>
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
      />
    </div>
  )
}
