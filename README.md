# Elden Ring RL1 Weapon Audit

An open-source tool for RL1 runs. Check what equipment is needed to use any weapon at rl1. Includes an alternative _Loadout Check_ mode that lists all usable weapons with a given loadout. 

**[→ Open the tool](https://christian-j-eid.github.io/EldenRing-RL1-Weapon-Audit/)**


---

## Features

- **Weapon Audit** — select any weapon and see whether your current loadout meets its stat requirements at RL1
- **Loadout Check** — put in your loadout and view every weapon in the game you can wield with it
- **Auto-solve** — automatically finds talisman, crystal tear, and Great Rune combination that meets min stats for a given weapon 
- **Ranked solutions** — solutions are sorted by weighted cost, the least expensive solutions appear first

  | Item | Cost |
  |---|---|
  | Two-handing | 0.1 |
  | Great Rune | 0.5 |
  | Crystal Tear | 1.0 |
  | Talisman | 1.2 |
  | Armor piece | 1.5 | 
  
- **Keep Current Loadout** — when solving, fills only your empty slots rather than replacing your existing gear
- **DLC toggle** — include or exclude Shadow of the Erdtree weapons
- **Advanced exclusions** — remove specific talismans, crystal tears, or weapons from consideration if they are DLC or can't be accessed, allowing app to function at any point in a playthrough
- **Weapon info** — view scaling grades, attack values, and damage type for the selected weapon

---

## About the App

Built with **React** and **Vite**, deployed to GitHub Pages.

Weapon data, stat requirements, scaling, attack values, talisman, great runes, stat boosting armor etc... was scraped from [eldenring.wiki.gg](https://eldenring.wiki.gg) via the MediaWiki API using Node.js scripts in `/scripts`. The parsed output lives in `src/data/elden-ring.json`.

The solver runs two passes. A **greedy solver** works through equipment categories in priority order and picks the best-fitting item at each step, also used to find the closest possible loadout when no clean solution exists. An **exhaustive solver** generates every valid subset of talismans and tears, checks each combination against the weapon's requirements, and returns a ranked list sorted by number of items used. Mutex pairs (e.g. Marika's Scarseal and Soreseal) are enforced at both the picker and solver level.

---

*No account required, no data collected*
