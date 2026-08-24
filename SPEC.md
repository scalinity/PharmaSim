# PharmaSim — Game Specification

A 3D pharmacy business simulator. This document is the single source of truth for design and
architecture. Implementation happens across 17 one-session milestones (`docs/milestones/01–17`);
each milestone brief tells you which sections of this spec to read. Numbers in §26 (tuning
constants) are the authoritative values wherever prose and table disagree.

---

## §1 Vision

You inherit the instincts of a pharmacy family. Starting as the lone pharmacist-owner of a humble
corner drugstore, you personally take prescriptions, fill them from the shelf, and ring up
customers. Profits buy shelves, staff, licenses, and renovations. Hiring lets you step back from
the counter; licenses unlock deeper practice (controlled substances, immunizations); renovation
modernizes your store era by era — from walnut-and-brass 1950s charm to a glass-and-mint modern
clinic. Eventually you operate a network of branches across a living low-poly city with clinics,
hospitals, rival pharmacies, and your own distribution center with delivery trucks.

The fantasy: *you are not managing a building, you are managing a healthcare business ecosystem* —
experienced through a cozy eagle-eye view of little people moving through a store you built.

Play sessions are 5–15 minutes (one to two in-game days). The game is a personal desktop app
(Tauri, macOS-first), shared with friends and colleagues as an app bundle.

## §2 Design pillars

1. **Capabilities, not percentages.** Every purchase changes *how the game plays* — a fridge
   unlocks refrigerated drugs, a certification unlocks vaccinations, a second register opens a
   parallel checkout lane, an AI module removes a whole task. No item anywhere grants "+10%
   efficiency". Throughput comes from parallel stations and staff, never stat sticks.
2. **Legible causality.** Every bad day must be diagnosable by watching the floor: prescriptions
   pile up at the bottleneck station, angry walk-outs happen at visible queues, the end-of-day
   receipt itemizes every dollar. No hidden modifiers.
3. **Grounded, never clinical-harmful.** Real generic drug names, a real retail workflow
   (drop-off → fill → verify → counsel → pickup). Mistakes are caught at verification or result in
   refunds and reputation loss — never depicted as patient harm. No brand names, no dosing advice.
4. **Humble to empire.** Progression is economic, never time-gated. Any store can always be
   modernized to current-generation fixtures. Licenses, branches, and logistics are bought with
   earned cash and reputation, in any order the economy allows.
5. **The sim tells stories.** Demand comes from a modeled neighborhood, not a spawn timer.
   Shortages, flu seasons, storms, and rivals create narrative arcs ("the winter Riverside ran out
   of amoxicillin") without scripted missions.

## §3 Constraints and conventions (read every session)

- **Dev loop**: `npm run dev` (Vite in browser) is the daily driver. The Tauri shell exists from
  milestone 1 but `tauri dev`/`tauri build` are run only when a brief explicitly says so, with the
  user's go-ahead. Never run build commands (`tsc`, `vite build`, `cargo build`, …) otherwise.
- **No React. No `useEffect`.** The HUD is hand-rolled TypeScript DOM components (§28). The
  UI boundary must stay clean enough that React *could* replace it later without touching `sim/`.
- **Layer discipline**: `sim/` imports nothing from `render/`, `ui/`, `platform/`, or three.js.
  `render/` and `ui/` never mutate sim state directly — they send commands and subscribe to events.
- **TypeScript strict**, ES modules, no runtime JS dependencies beyond `three` (and
  `@tauri-apps/api` in `platform/`). `@fontsource/*` packages are allowed — they only supply the
  locally bundled font files (§28); nothing loads from the network at runtime.
- **IP rules**: no assets, art, audio, names, or UI copied from existing games. All geometry is
  procedural, all audio synthesized (§29), drug names are real *generics* only, competitor and
  district names are fictional.
- **Minimalism**: implement exactly the current milestone's scope. Resist speculative abstraction.
- Each milestone ends with the game runnable via `npm run dev`, no console errors, 60 fps target.

## §4 Architecture

Three layers connected by a typed event bus and a command facade:

```
+----------------------------------------------------------------------+
|  sim/  — pure TypeScript simulation. Owns all state. No DOM, no three |
|  ticks at fixed 10 Hz; emits SimEvent; accepts Command via facade     |
+-----------------------------▲----------------------▲-----------------+
                    commands  |                       |  SimEvent (bus)
              +---------------+--------+   +----------+-----------------+
              |  ui/ — DOM HUD design  |   |  render/ — three.js scenes |
              |  system (panels, Rx    |   |  (store dollhouse + city   |
              |  cards, receipt, build |   |  map), NPC meshes, camera, |
              |  palette, reports)     |   |  picking → commands        |
              +------------------------+   +----------------------------+
              |  platform/ — storage (Tauri fs | localStorage), audio,  |
              |  window glue                                            |
              +---------------------------------------------------------+
```

### Module layout

```
src/
  main.ts                 // bootstrap: create sim, renderer, hud, loop
  core/
    loop.ts               // rAF render loop + fixed-timestep sim accumulator
    bus.ts                // typed pub/sub EventBus<SimEvent>
    rng.ts                // mulberry32 seeded RNG (one stream per day)
    clock.ts              // in-game time math (§5)
    grid.ts               // grid math, footprints, occupancy
    pathfind.ts           // A* over walkable cells
  sim/
    sim.ts                // Sim facade: tick(), dispatch(Command), state access
    state.ts              // GameState root type + factory
    commands.ts           // Command union + handlers
    events.ts             // SimEvent union
    customers.ts          // spawning, archetypes, patience, browsing, baskets
    workflow.ts           // Rx stage queues: dropoff→fill→verify→counsel→pickup
    staff.ts              // roles, stats, traits, assignment AI, hiring pool
    inventory.ts          // stock, ordering, deliveries, spoilage
    economy.ts            // cash, P&L, pricing, reimbursement, loans
    reputation.ts
    licenses.ts
    renovation.ts         // era tiers per store
    events-world.ts       // rush/season/flu/shortage/storm scheduling
    city.ts               // districts, facilities, demand generation & routing
    competitors.ts        // rival share model, drift, transfers
    branches.ts           // multi-store state, off-screen day resolution
    logistics.ts          // distribution center, trucks, transfer orders
    aitech.ts             // AI verification + demand forecasting
    save.ts               // serialize/migrate GameState (versioned)
  render/
    renderer.ts           // WebGLRenderer, scene switching, resize
    storeScene.ts         // dollhouse store: shell, furniture, NPCs
    cityScene.ts          // city map: districts, buildings, trucks
    meshes/               // procedural geometry factories (furniture, people, city)
    npcView.ts            // instanced customer/staff visuals, interpolation
    cameraRig.ts          // orthographic eagle-eye, pan/zoom/orbit
    picking.ts            // raycast → hover/click → commands
    lighting.ts           // key light, ambience, day/night cycle
    eras.ts               // per-era material palettes & fixture reskins
  ui/
    dom.ts                // element helpers (h(), mount, cls)
    tokens.css            // design tokens (§28)
    components/           // Panel, PillButton, RxCard, Receipt, Meter, Toast,
                          // Ticker, Modal, StatChip, Tabs, PriceTag
    hud.ts                // layout root; top bar, bottom dock, side panels
    screens/              // title, settings, pause, endOfDay, cityOverlay,
                          // buildPalette, staffPanel, ordersPanel, reports
  data/
    drugs.ts              // Rx catalog (§25)
    otc.ts                // OTC catalog (§25)
    furniture.ts          // furniture defs (§6)
    districts.ts          // city model (§17)
    competitors.ts        // rival defs (§18)
    flavor.ts             // legacy/generation flavor text (§22)
    names.ts              // staff/customer name pools (fictional)
  platform/
    storage.ts            // Storage interface; TauriFsStorage / LocalStorageStorage
    audio.ts              // WebAudio synthesized SFX + ambience (§29)
    tauri.ts              // dialog, fs, window glue (lazy-imported)
```

### Simulation contract

- **Fixed timestep**: sim ticks every 100 ms of *scaled* time. Game speeds: pause / 1× / 2×.
  The render loop runs at display rate and interpolates NPC positions between ticks.
- **Determinism-friendly**: one seeded RNG stream per day (`seed = worldSeed ^ dayNumber`); all
  randomness inside `sim/` draws from it. Replays aren't a feature, but this keeps bugs
  reproducible from a save + day number.
- **Events out, commands in.** `render/` and `ui/` subscribe to `SimEvent`s
  (e.g. `customer.spawned`, `rx.stageChanged`, `day.ended`, `cash.changed`). All mutations go
  through `sim.dispatch(command)` (e.g. `{type:'furniture.place', ...}`). No layer reaches into
  `GameState` to write. Reads are allowed via read-only selectors for HUD rendering.
- **One sim, many stores**: `GameState.stores[]` with `activeStoreId`. Only the active store
  simulates individuals; the others resolve statistically at day end (§19).

## §5 Time and the day loop

- In-game day = **08:00 → 20:00** (720 in-game minutes). At 1× speed, 1 real second = 2.4 igm,
  so a full day ≈ 5 real minutes; 2× halves it. Pause stops sim ticks (UI stays live).
- **Day phases**:
  1. **Morning (untimed)** — deliveries arrive; plan mode: place orders, build/move furniture,
     hire/assign staff, buy licenses/renovations, review forecasts. Sim clock frozen at 08:00.
     Player clicks **Open store** to start.
  2. **Shift (timed)** — customers spawn, queues form, money moves. Build mode may be entered
     mid-shift; it pauses the sim while placing.
  3. **Close (untimed)** — at 20:00 remaining customers finish (spawning stops at 19:30), then
     the **end-of-day receipt** prints (§28): revenue lines, cost lines, reputation delta,
     incidents, forecasts. Autosave happens here. Player advances to next morning.
- Calendar: 7-day weeks, 14-day seasons, 4 seasons (spring→summer→fall→winter) = 56-day year.
  Season drives demand modifiers and events (§16). Day/night lighting maps 08:00–20:00 to a
  warm-cool-warm arc; winter days render darker at the edges (§27).
- Hiring pool refreshes every Monday morning. Rent/wages/utilities are charged on the receipt
  daily (§10).

## §6 The store

- **Grid**: 1 cell = 1 m. Interior starts **10×7** walkable cells; door centered on the front
  (south) wall. Expansions purchased in morning phase, applied instantly:
  E1 +3 columns → 13×7 ($4,000) · E2 +3 rows → 13×10 ($7,000) ·
  E3 +3 columns → 16×10 ($12,000) · E4 +2 rows → 16×12 ($16,000).
- **Placement**: build mode shows a palette (§28). Furniture occupies footprint cells, rotates in
  90° steps, can be moved/sold (sell = 50% refund). Rules: door and a 1-cell path to every
  station must remain reachable (validated by flood fill on placement); Rx shelves, fill bench,
  verify desk, fridge, and controlled cabinet must sit in the **backroom zone** — cells behind the
  service counter's line (zone is derived from counter placement and tinted in build mode).
  Customers path only through public cells; staff may cross both.
- **Furniture catalog** (cost, footprint, capability — the full def lives in `data/furniture.ts`):

| id | cost | cells | capability |
|---|---|---|---|
| counter_service | $900 | 2×1 | Rx drop-off + pickup lanes (1 of each). One per store. |
| counter_register | $500 | 1×1 | one checkout lane (OTC + copays) |
| otc_shelf | $400 | 2×1 | stocks 4 OTC SKUs × 24 units, browsable |
| rx_shelf | $600 | 2×1 | 12 Rx SKU bins (backroom) |
| fill_bench | $700 | 1×1 | one filling station |
| verify_desk | $800 | 1×1 | one verification station |
| chair_waiting | $120 | 1×1 | seated waiters' patience drains at half rate |
| fridge_medical | $3,500 | 1×1 | enables refrigerated SKUs (§14) |
| cabinet_controlled | $4,500 | 1×1 | enables Tier-3 controlled SKUs (needs L3) |
| vaccine_station | $2,500 | 2×1 | enables vaccination service (needs L4 + fridge) |
| generator_backup | $5,000 | 1×1 | refrigerated stock survives outages (§16) |
| dispenser_robotic | $25,000 | 2×2 | auto-fills Tier-1/2 scripts, no tech needed (needs Gen 4) |
| decor_plant / rug / poster | $80/$150/$60 | 1×1/2×1/wall | cosmetic; counts toward renovation flavor |

- **Starting layout** (pre-placed, movable): 1 counter_service, 1 counter_register, 1 rx_shelf,
  2 otc_shelf, 1 fill_bench, 4 chair_waiting. (No verify desk — the solo owner verifies at
  handoff; a desk becomes necessary when techs fill, §8/§9.)
- **Pathfinding**: A* on walkable cells, diagonal disallowed; NPCs reserve their next cell to
  avoid overlap; if blocked > 3 s they repath. Debug overlay (dev toggle, `P` key) draws paths.

## §7 Customers

- **Spawning**: demand comes from the district model (§17) even before the city view exists —
  milestone 3 seeds a single hard-wired district ("Old Town"). Each shift, target visitor count
  `N = baseVisitors × repMult × seasonMult × dayNoise` is scheduled as a non-uniform arrival
  curve with lunch (12:00–14:00) and evening (17:00–19:00) rush bumps (§16). Early-game
  baseline ≈ 20 visitors/day (§26); hard cap 40 concurrent NPCs (§30).
- **Mix**: ~60% OTC shoppers, ~35% Rx patients, ~5% vaccine walk-ins (once unlocked). Rx
  patients whose wait exceeds 60 igm start browsing OTC shelves and may add items to a basket
  (the wait-time/basket-size tradeoff — comfortable waiting increases sales).
- **Archetypes** (one per customer, visible as a subtle accent color + icon on their patience ring):

| archetype | share | patience | primary care-about | behavior notes |
|---|---|---|---|---|
| Hurried | 25% | 45 igm | speed | won't browse; walks out loudly (−rep ×1.5) |
| Steady | 35% | 90 igm | availability | default shopper |
| Bargain | 20% | 90 igm | price | skips OTC items priced >1.15× MSRP; balks at high price index |
| Chatty | 20% | 150 igm | counseling | +rep bonus if counseled at pickup; browses a lot |

- **Patience**: drains while waiting in any queue (half rate if seated in a waiting chair).
  At zero → walk-out: the customer leaves angrily, rep −0.06 (Hurried −0.09), and the sale/script
  is lost. Chronic patients (§18) who walk out twice transfer to a competitor.
- **Baskets**: OTC shoppers buy 1–4 items biased by archetype and stock variety; each browsed
  shelf with in-stock items adds a chance for +1 item.

## §8 Prescription workflow (stage queues)

Every script is a little kanban card moving through visible stations; the whole pharmacy is a
queueing system the player can watch and diagnose (pillar 2).

```
 drop-off ──► fill ──► verify ──► pickup (+ counsel)
 (counter)   (bench)   (desk)     (counter)
```

- **Drop-off**: patient queues at the service counter, hands over a script (drug, quantity,
  refills flag). The script enters the fill queue; the patient sits/browses/waits.
- **Fill**: at a fill bench, a worker (player or tech) takes the top script. *Player interaction*
  (solo era): the Rx card (§28) shows the drug name + strength; the backroom Rx shelf highlights
  and the player must click the **correct bin** — bins are labeled and 2–3 *confusable* neighbors
  (§25 `confusableWith`) are always shuffled nearby (hydroxyzine vs hydralazine…). Correct pick →
  short fill animation (6 igm). Wrong pick → the error travels silently with the script.
- **Verify**: a pharmacist at the verify desk checks filled scripts (8 igm each). Catch rates by
  accuracy stat (§26): errors caught → script returns to fill queue (time cost, no rep loss:
  "caught at verification"). **Solo era**: the owner-player is the pharmacist; with no verify
  desk, verification happens implicitly at handoff with a 90% catch rate. Uncaught errors are
  discovered at pickup: full refund + rep −0.15 (never depicted as harm; copy reads
  "dispensing error caught — refunded and refilled").
- **Pickup + counsel**: patient pays the copay at the counter, cashier or player hands the bag.
  Chatty patients accept an optional 10 igm counseling interaction (+0.03 rep, +$4 basket chance).
- **Station occupancy**: each bench/desk/register serves one worker; more stations + more staff =
  parallel lanes (the only throughput lever, pillar 1). Queue depth renders as stacked cards over
  each station; the bottleneck station glows amber when its queue ≥ 4.
- The player can always click a station to work it personally, whatever staff exist.

## §9 Staff

- **Roles**: cashier (register, pickup payments), pharmacy tech (fill, restock shelves),
  pharmacist (verify, counsel, vaccinate), manager (required to run an unvisited branch well,
  §19). The owner-player can perform any role's task by clicking the station.
- **Stats** 1–5: speed (task duration multiplier ×[1.4, 1.2, 1.0, 0.85, 0.7]), accuracy (§26
  error/catch tables), warmth (counseling and checkout satisfaction bonus).
- **Traits** (exactly one): Meticulous (never mis-fills, tasks +20% duration), Swift (tasks −20%
  duration, fill error +2 pts), Charming (counsel/checkout +0.01 rep each), Stock Hawk
  (auto-restocks OTC shelves from backroom stock between tasks), Penny-wise (asks 15% lower wage).
- **Hiring**: staff panel lists 3 candidates/role, refreshed Mondays; candidate quality scales
  with reputation. Daily wages (§26) hit the receipt; firing is instant (no severance — cozy, not
  cruel). Staff walk the floor as NPCs, path to their station, idle at a break spot when queues
  are empty.
- **Assignment AI**: each staff member holds a role assignment + station; simple priority — work
  own-station queue, else Stock Hawk restock, else idle. No fatigue/energy system (settled out).

## §10 Economy

- **Cash** is a persistent balance across days; every movement is a ledger line with a reason;
  the end-of-day receipt groups them (revenue: Rx reimbursements, OTC sales, copays, vaccines;
  costs: wholesale orders, wages, rent, utilities, loan interest, refunds).
- **Rx money — fixed reimbursement**: each Rx SKU has `wholesale` and `reimbursement` (§25).
  Margin = reimbursement − wholesale; the patient's flat $12 copay is *separate* revenue on top
  of it. The *player never sets Rx prices* (insurer-set flavor; no claims system exists). Copay
  and reimbursement both credit at pickup (same-day settlement — no receivables).
  Shortages raise `wholesale` (§16) while reimbursement stays fixed → margins compress; a few
  SKUs can go *underwater* during shortages, and the ordering UI shows per-SKU margin so the
  player can choose not to restock money-losers (or eat the loss for reputation).
- **OTC money**: player sets a price slider per SKU, 0.8×–1.5× of MSRP (default 1.0×). Wholesale
  = 46% of MSRP. Bargain archetypes skip items >1.15×; all archetypes skip >1.35×. The store's
  **price index** (avg multiplier) feeds city attractiveness (§17).
- **Fixed costs**: rent per store per day (district-dependent, §17; Old Town $64), utilities $20
  base + $6 per powered equipment (fridge, robotic dispenser, vaccine station, generator idle $2).
- **Loans** (realistic, opt-in): the bank offers a credit line once rep ≥ 3.0★ — draw up to
  24× trailing-7-day average gross (cap $60,000), interest 0.32%/day on balance, auto minimum
  payment 1.6%/day. **Family loan** (soft-fail): if cash < $0 at close, Aunt Rosa covers to
  +$2,500 — interest-free, auto-repaid at 15% of daily profit, rep −0.3 ("word gets around"),
  no second loan until repaid. There is no bankruptcy/game-over.
- **Starting money**: $12,000 cash, day 1, Old Town store with starting layout and a small
  starter stock (§26).

## §11 Inventory and suppliers

- Stock is per-store, per-SKU: `backroom` units + `shelved` units (OTC) or bin units (Rx).
  Techs/Stock Hawks move backroom → shelf; empty shelves lose sales silently (stock-out events
  appear on the receipt and depress availability score, §17).
- **Ordering** (morning phase or anytime): wholesale catalog lists cost, margin, stock; orders
  arrive **next morning** (day +1). Order UI shows 7-day sales history per SKU (and the AI
  forecast once owned, §21). Supplier tiers by reputation: 2.0★ unlocks −4% wholesale,
  4.0★ −8% (better contracts, framed as capabilities: new supplier options).
- **Reorder rules** (unlocked after first stock-out, teaches itself): optional per-SKU
  min/target levels that auto-draft (not auto-send) a morning order.
- **Spoilage**: refrigerated SKUs spoil only via outage events (§16). No general expiry system
  (settled out — realism budget goes to shortages instead).
- With a distribution center (§20), orders route through the DC at −12% wholesale and trucks
  deliver; without it, each store orders independently.

## §12 Licenses (capability gates, buy anytime the gates are met)

| id | name | cost | requires | unlocks |
|---|---|---|---|---|
| L1 | Community Pharmacy | — | start | OTC retail + Tier-1 formulary |
| L2 | Expanded Formulary | $8,000 | 2.0★ | Tier-2 Rx SKUs |
| L3 | Controlled Substances | $16,000 | 3.0★ | Tier-3 SKUs (need cabinet per store) |
| L4 | Immunization Certification | $9,600 | 2.5★ | vaccine station + service (§14) |
| L5 | Multi-Branch Operation | $40,000 | 4.0★ | buying additional branches (§19) |
| L6 | Distribution Operations | $32,000 | L5 + 2 branches | distribution center + trucks (§20) |

Licenses are account-wide; per-store equipment (cabinet, fridge, station) is still needed locally.
The license panel frames each as a certificate on the office wall (§28).

## §13 Era modernization (per store, purely economic)

Renovation tiers reskin the store shell + fixtures and gate a few equipment purchases. Any branch
can be renovated at any time; nothing else is era-gated. Buying a renovation closes the store for
the rest of the current day (visible scaffolding, small drama, no revenue).

| tier | name | cost | look (§27) | gates |
|---|---|---|---|---|
| Gen 1 | The Founding Store | start | walnut shelving, brass register, checkerboard floor, hand-painted sign | — |
| Gen 2 | The Family Business | $6,000 | teal linoleum, fluorescent strips, chrome fixtures | — |
| Gen 3 | The Retail Chain Era | $14,400 | gray-blue retail gondolas, drop ceiling, barcode registers (visual) | — |
| Gen 4 | The Modern Clinic | $32,000 | mint + white + glass, wood accents, pendant lights | robotic dispenser, AI modules (§21) |

Renovating the *first* store for the first time and reaching Gen 4 anywhere both trigger legacy
moments (§22).

## §14 Cold chain and vaccinations

- **Fridge** (per store, $3,500): unlocks stocking refrigerated SKUs (insulins, semaglutide,
  vaccines). Fridge capacity 40 units (a second fridge doubles it — capacity via more units,
  pillar 1).
- **Storm/outage event** (§16): during an outage, stores without a **backup generator** lose all
  refrigerated stock at the moment power drops (receipt line: "spoilage — refrigerated stock");
  with a generator, nothing happens except the hum. The generator is pure insurance — exactly the
  memorable kind (pillar 1).
- **Vaccinations** (L4 + fridge + vaccine_station + a pharmacist on duty): walk-in vaccine
  customers (4–7/day; ×4 in flu season) queue at the station for a quick 15 igm service, net
  +$27 each, +0.01 rep. If the pharmacist is busy verifying, vaccine queue waits — a real
  staffing tension between scripts and shots.

## §15 Reputation

- One account-visible star rating per **store**, 0.0–5.0 (UI shows halves), starting 2.5.
- Deltas: happy serve +0.02 · counseled +0.03 · vaccine +0.01 · walk-out −0.06 (Hurried −0.09) ·
  unfillable script (stock-out) −0.08 · dispensed error −0.15 · family loan −0.3 ·
  daily drift 1% toward 2.5 (neglect decays, grudges fade).
- Reputation gates (capabilities, not multipliers where possible): supplier tiers (§11), bank
  credit line (§10), license thresholds (§12), hiring pool quality (§9) — and it feeds visitor
  volume (`repMult = 0.4 + 0.24 × stars`) and city market share (§17).

## §16 Events and atmosphere

- **Daily rush hours**: spawn rate ×1.6 during 12:00–14:00 and 17:00–19:00 (visible on the
  clock strip so players can staff for it).
- **Seasons** (14 days each): spring — allergy (OTC antihistamines ×2.5, respiratory Rx ×1.3);
  summer — calm (visitors ×0.9, more OTC first-aid); fall — back-to-school (pediatric antibiotics
  ×1.4); winter — **flu season** (respiratory + antibiotics Rx ×1.8, OTC cold/flu ×3, vaccine
  walk-ins ×4, visitors ×1.2).
- **Regional drug shortage** (1–2 per season, 4–8 days): one Rx category's wholesale ×1.5 and
  supplier availability limited (order fills capped at 60%). News ticker announces it; the
  ordering panel flags affected SKUs and their (possibly negative) margins. With multiple
  branches, transfers (§20) become the counter-move.
- **Storm + power outage** (1–2 per year, forecast on yesterday's receipt — generators are
  buyable *in response*): outage lasts 2–5 in-game hours; lights dim, registers keep working
  (cash box flavor), refrigerated stock spoils without a generator (§14); visitors ×0.6 that day.
- **News ticker**: a HUD strip (§28) surfaces events, shortages, competitor moves, and legacy
  moments as one-line headlines with dates.
- **Day/night lighting**: §5/§27; purely atmospheric.

## §17 The city and living demand

Six fictional districts on a low-poly city map. Districts are the demand engine from milestone 3
onward (the store starts in Old Town with the city implicit; the map view arrives in milestone 12).

| district | pop | skew | prevalence highlights | facilities | daily rent |
|---|---|---|---|---|---|
| Old Town | 6,800 | older mixed | cardiovascular ↑, diabetes → | small clinic | $64 |
| Riverside | 9,400 | young families | pediatric ↑, allergy ↑ | pediatric office | $88 |
| University Heights | 11,200 | students | acute ↑, mental health → | campus urgent care | $96 |
| Sunset Glen | 5,100 | retirees | chronic ↑↑ (cardio, diabetes, anticoag) | nursing home | $76 |
| Medical District | 7,600 | mixed | specialty ↑, post-hospital scripts ↑ | hospital + specialists | $152 |
| Downtown | 12,500 | working adults | OTC convenience ↑↑, GI/stress → | walk-in clinic | $192 |

- **Demand generation**: each district each day generates Rx scripts per category
  (`pop × prevalence[cat] × seasonMult × noise`) plus OTC visit intent. Facilities add flat
  bonuses (hospital: +specialty and +acute scripts; nursing home: +chronic refills routed as
  weekly batches).
- **Routing**: every pharmacy (player stores + competitors) gets an **attractiveness score** per
  district: `A = 0.35·proximity + 0.30·(rep/5) + 0.15·priceScore + 0.20·availability`
  where proximity = 1.0 same district / 0.5 adjacent / 0.2 elsewhere (adjacency in
  `data/districts.ts`), priceScore = clamp(2 − priceIndex, 0..1), availability = trailing 7-day
  fill rate. District share_i = A_i² / Σ A_j² (squaring sharpens competition). The player store's
  scheduled visitors (§7) = its share of district demand, capped by §26 spawn limits.
- **Learn your neighborhood**: the reports panel shows per-category demand vs. fills, so players
  discover "Sunset Glen keeps asking for anticoagulants" and stock accordingly.

## §18 Competitors

Four fictional rivals, simulated as stat blocks (never full 3D interiors), visible on the city
map with their own star ratings:

| name | style | home district | priceIndex | quality (rep) | counsel | stockReliability |
|---|---|---|---|---|---|---|
| MediMart | big-box discounter | Downtown | 0.85 | 2.0★ | low | 0.90 |
| GreenCross Drugs | steady mid-market | Riverside | 1.00 | 3.0★ | mid | 0.85 |
| QuickScripts | speed-focused chain | University Heights | 1.05 | 3.0★ | low | 0.80 |
| Harbor Apothecary | boutique service | Old Town (the hometown rival) | 1.25 | 4.0★ | high | 0.75 |

- They participate in §17 routing with `availability = stockReliability ± shortage effects`.
- **Drift**: every 28 days, the rival with the lowest total share improves one attribute a notch
  (price cut, small rep gain, or reliability bump), announced on the ticker ("MediMart renovates
  its Downtown location"). Shortages hit their availability too (reliability −0.15 during one).
- **Prescription transfers**: chronic patients are persistent entities (a per-district pool of
  monthly refill scripts). Two bad experiences at a pharmacy (walk-out, stock-out, error) move
  that patient's refills to the best-scoring rival — and vice versa: sustained high availability
  + rep pulls transfers *in*. The receipt and reports show "transfers in/out this week" so the
  loop is legible.
- Competitors never go bankrupt and never open new locations (v1 scope).

## §19 Multi-branch

- With **L5**, empty lots in any district can be bought (site cost = 300× daily rent; e.g.
  Old Town $19.2k, Downtown $57.6k) + $12,000 fit-out (starting layout, Gen 1). Each branch has its
  own grid, stock, staff, era, and local reputation (starting 2.5★).
- **Visited branch** = full 3D sim as normal. **Unvisited branches** resolve at day end:
  - `capacity = min(fills, verifies, checkouts)` from assigned staff throughput
    (tech 35 fills/day, pharmacist 50 verifies/day, cashier 60 checkouts/day, ×speed stat curve)
  - `managerFactor = 0.6` without a manager on staff, else `0.9 + 0.02 × manager stat total`
  - `served = min(demand, capacity × managerFactor)`; revenue/costs post accordingly; staff
    accuracy generates incident counts; rep drifts by served ratio (±0.05/day band).
  - Unvisited branches **cannot** be micromanaged by design — hiring a good manager and stocking
    well *is* the gameplay (the memo's "stop micromanaging registers" beat).
- **Switching**: choose the active branch each morning (from the city map or branch tabs). The
  end-of-day receipt gains a per-branch summary page; the reports panel rolls up the network.
- A branch with no pharmacist on staff cannot fill Rx while unvisited (OTC only) — mirrors §8.

## §20 Distribution and logistics

- **L6 + Distribution Center** ($48,000 building on the city map): unlocks **central
  purchasing** — one consolidated morning order at −12% wholesale, delivered to DC stock. The
  DC price *replaces* the reputation supplier-tier discount (§11); discounts never stack.
- **Trucks** ($6,400 each, garage at the DC): each truck runs one morning route, capacity 400
  units, visiting up to 3 stops. The player drafts routes (drag stores into a truck's list);
  goods arrive as the truck reaches each store — visible driving the city roads during the shift
  (flavor; arrival is guaranteed same-day).
- **Transfer orders**: move stock branch→branch via a truck stop (the shortage counter-move:
  "Riverside is out of amoxicillin, Downtown has 300 units").
- Stores may still order direct from wholesalers (no discount) — the DC is a capability, not a
  chore gate.

## §21 AI endgame tech (Gen 4 modules)

- **AI Verification Assistant** ($30,000, per store, requires Gen 4 + verify desk): auto-verifies
  Tier-1/2 scripts instantly and catches 100% of fill errors before handoff; pharmacists only
  verify Tier-3/refrigerated scripts. Reframes the pharmacist's day around counseling and
  vaccines — a capability that removes a queue, not a speed buff.
- **AI Demand Forecasting** ($45,000, account-wide, requires Gen 4 anywhere + 28 days of sales
  history): the ordering panel gains a 7-day per-SKU forecast table (predicted units, trend
  arrow, confidence band) computed from the *true* demand generator with ±10% noise — trusting
  it is genuinely correct play, and an **Order to forecast** button drafts the morning order.
  During shortages the forecast flags affected SKUs ("demand ↑31%, supply capped").

## §22 Legacy and generation flavor

- Light narrative framing honoring the family-pharmacy fantasy. `data/flavor.ts` holds short
  flavor lines (2–3 sentences, warm, never blocking) shown as a paper note pinned to the
  end-of-day receipt when milestones occur: first profitable day, first hire, first renovation,
  L3/L4/L5 purchases, first branch, first transfer-in wave, DC opening, first Gen 4 store,
  AI modules. Example register: "Your great-grandfather counted pills with a spatula and a brass
  scale. The robot does it faster. He'd have watched it all afternoon."
- A **Legacy panel** (photo-album styling, §28) lists achieved moments with dates — the game's
  trophy case. No quests, no gates, no dialogue trees.

## §23 Saves and persistence

- **Storage abstraction** (`platform/storage.ts`): `interface Storage { load(): Promise<SaveFile|null>; save(f: SaveFile): Promise<void>; exportFile(): Promise<void>; importFile(): Promise<SaveFile|null> }`
  with `TauriFsStorage` (app-data dir `saves/profile.json`, export via save dialog) chosen when
  `window.__TAURI__` exists, else `LocalStorageStorage` (key `pharmasim.save.v1`, export via blob
  download, import via file input) for browser dev. One autosave profile (settled).
- **When**: autosave at end-of-day (after the receipt) and on quit/window-close; manual "Save &
  quit to title" in the pause menu. Quitting mid-shift persists the *morning snapshot* of the
  current day — an in-progress shift is discarded by design (deterministic, simple, no mid-shift
  NPC serialization).
- **Versioning**: `SaveFile.version: number`; `sim/save.ts` owns `migrate(old): SaveFile` as a
  chain of stepwise migrations; every milestone that extends state adds a migration so earlier
  playtest saves keep working. Full schema in §24.

## §24 Data schemas (authoritative TypeScript shapes)

```ts
type RxTier = 1 | 2 | 3;
type RxCategory = 'cardiovascular'|'diabetes'|'thyroid'|'gi'|'antibiotics'|'respiratory'
  |'mentalHealth'|'pain'|'anticoagulant'|'pediatric'|'dermatology'|'vaccines';

interface DrugDef {
  id: string;                 // 'lisinopril10'
  name: string;               // 'Lisinopril 10 mg'
  category: RxCategory;
  tier: RxTier;               // 3 ⇒ controlled (needs L3 + cabinet)
  refrigerated?: boolean;     // needs fridge
  wholesale: number;          // $ per fill (pre-discount)
  reimbursement: number;      // $ fixed, insurer-set; margin = reimb − wholesale
  demandWeight: 1|2|3;        // relative pull within its category
  confusableWith?: string[];  // ids shown as neighbor bins in the fill interaction
}

interface OtcDef {
  id: string; name: string;
  category: 'pain'|'allergy'|'coldflu'|'digestive'|'wellness'|'firstaid';
  msrp: number;               // player price = msrp × multiplier (0.8–1.5)
  demandWeight: 1|2|3;
}

interface FurnitureDef {
  id: string; name: string; cost: number;
  cells: [w: number, h: number];
  zone: 'public'|'backroom'|'any';
  capability: string;         // documented in §6
  requires?: { license?: string; era?: number; furniture?: string[] };
  powered?: boolean;          // adds $6/day utilities
}

interface StaffMember {
  id: string; name: string;
  role: 'cashier'|'tech'|'pharmacist'|'manager';
  speed: 1|2|3|4|5; accuracy: 1|2|3|4|5; warmth: 1|2|3|4|5;
  trait: 'meticulous'|'swift'|'charming'|'stockhawk'|'pennywise';
  dailyWage: number; hiredOnDay: number;
  assignment?: { stationId: string };
}

interface District {
  id: string; name: string;
  population: number; dailyRent: number;
  prevalence: Partial<Record<RxCategory, number>>;   // scripts per 1k pop per day
  otcIntent: number;                                 // OTC visits per 1k pop per day
  facilities: { kind: 'clinic'|'hospital'|'nursingHome'|'urgentCare'|'pediatricOffice'|'walkInClinic';
                bonus: Partial<Record<RxCategory, number>> }[];
  adjacent: string[];
}

interface CompetitorState {
  id: string; name: string;
  homeDistrictId: string;                 // §18 table
  priceIndex: number; repStars: number; counsel: 'low'|'mid'|'high';
  stockReliability: number;               // 0–1, availability proxy
}

interface RxScript {
  id: string; drugId: string; customerId: string;
  stage: 'dropoff'|'fillQueue'|'filling'|'verifyQueue'|'verifying'|'ready'|'done';
  filledWithDrugId?: string;              // ≠ drugId ⇒ latent error
  chronic?: { patientPoolId: string };    // transfers, §18
}

interface StoreState {
  id: string; districtId: string; era: 1|2|3|4;
  grid: { cols: number; rows: number; expansions: number };
  furniture: { defId: string; cellX: number; cellY: number; rot: 0|1|2|3; id: string }[];
  stock: Record<string, { backroom: number; shelved: number }>;
  otcPricing: Record<string, number>;     // multiplier per OTC id
  staff: StaffMember[];
  repStars: number;
  fillRate7d: number[];                   // trailing availability, §17
}

interface SaveFile {
  version: number;                        // migrations in sim/save.ts
  worldSeed: number; day: number; season: 0|1|2|3;
  cash: number; loans: { bank?: {balance:number}; family?: {balance:number} };
  licenses: string[];                     // 'L2'…'L6'
  activeStoreId: string; stores: StoreState[];
  competitors: CompetitorState[];
  patientPools: Record<string, { districtId: string; pharmacyId: string; category: RxCategory }>;
  dc?: { built: boolean; stock: Record<string, number>; trucks: { id: string; route: string[] }[] };
  aitech: { verifyAssist: string[];       // store ids owning it
            forecast: boolean };
  legacy: { id: string; day: number }[];  // achieved flavor moments
  stats: Record<string, number>;          // lifetime counters for reports
  settings: { volume: number; sfx: number; ambience: number; reducedMotion: boolean };
}
```

Events (`sim/events.ts`) and commands (`sim/commands.ts`) are discriminated unions; representative
members (grow as needed, keep names in this style): `customer.spawned`, `customer.walkout`,
`rx.stageChanged`, `rx.errorDispensed`, `sale.completed`, `cash.changed`, `stock.out`,
`day.phaseChanged`, `day.ended`, `rep.changed`, `event.news`, `staff.hired`, `branch.daySummary`,
`truck.arrived` · `furniture.place/move/sell`, `order.submit`, `otc.setPrice`, `staff.hire/fire/assign`,
`license.buy`, `era.renovate`, `store.open`, `speed.set`, `station.workHere`, `fill.pickBin`,
`branch.buy`, `branch.setActive`, `truck.setRoute`, `transfer.create`, `save.request`.

## §25 Drug and OTC catalogs (content backbone)

All names are real US generics (no brand names). Numbers are launch values — §26's balance bands
govern; the M16 balancing pass may adjust ±20% freely, and it did: every `r` below runs +18%
(rounded) in `data/drugs.ts`, which is authoritative (docs/balance-notes.md). `w` = wholesale $,
`r` = reimbursement $.

### Tier 1 — Community Pharmacy license (start)

| id | name | category | w | r | dw | confusable |
|---|---|---|---|---|---|---|
| lisinopril10 | Lisinopril 10 mg | cardiovascular | 2 | 8 | 3 | — |
| amlodipine5 | Amlodipine 5 mg | cardiovascular | 2 | 7 | 3 | — |
| metoprolol50 | Metoprolol 50 mg | cardiovascular | 3 | 9 | 3 | metformin500 |
| atorvastatin20 | Atorvastatin 20 mg | cardiovascular | 3 | 10 | 3 | — |
| hctz25 | Hydrochlorothiazide 25 mg | cardiovascular | 2 | 6 | 2 | — |
| losartan50 | Losartan 50 mg | cardiovascular | 3 | 9 | 2 | lorazepam1 |
| metformin500 | Metformin 500 mg | diabetes | 2 | 8 | 3 | metoprolol50 |
| glipizide5 | Glipizide 5 mg | diabetes | 3 | 9 | 2 | glimepiride2 |
| levothyroxine50 | Levothyroxine 50 mcg | thyroid | 2 | 8 | 3 | — |
| omeprazole20 | Omeprazole 20 mg | gi | 2 | 7 | 3 | pantoprazole40 |
| amoxicillin500 | Amoxicillin 500 mg | antibiotics | 3 | 10 | 3 | — |
| cephalexin500 | Cephalexin 500 mg | antibiotics | 4 | 11 | 2 | — |
| azithromycin250 | Azithromycin 250 mg | antibiotics | 5 | 13 | 2 | — |
| montelukast10 | Montelukast 10 mg | respiratory | 3 | 9 | 2 | — |
| albuterolHFA | Albuterol HFA inhaler | respiratory | 12 | 22 | 3 | — |
| prednisone10 | Prednisone 10 mg | respiratory | 2 | 7 | 2 | prednisolone15 |

### Tier 2 — Expanded Formulary (L2)

| id | name | category | w | r | dw | confusable |
|---|---|---|---|---|---|---|
| sertraline50 | Sertraline 50 mg | mentalHealth | 3 | 11 | 3 | — |
| escitalopram10 | Escitalopram 10 mg | mentalHealth | 3 | 11 | 3 | — |
| fluoxetine20 | Fluoxetine 20 mg | mentalHealth | 3 | 10 | 2 | — |
| bupropionXL150 | Bupropion XL 150 mg | mentalHealth | 5 | 14 | 2 | — |
| trazodone50 | Trazodone 50 mg | mentalHealth | 3 | 10 | 2 | tramadol50 |
| hydroxyzine25 | Hydroxyzine 25 mg | mentalHealth | 3 | 10 | 2 | hydralazine25 |
| gabapentin300 | Gabapentin 300 mg | pain | 3 | 11 | 3 | — |
| hydralazine25 | Hydralazine 25 mg | cardiovascular | 3 | 10 | 1 | hydroxyzine25 |
| clonidine01 | Clonidine 0.1 mg | cardiovascular | 2 | 9 | 1 | clonazepam05 |
| warfarin5 | Warfarin 5 mg | anticoagulant | 3 | 12 | 2 | — |
| apixaban5 | Apixaban 5 mg | anticoagulant | 18 | 34 | 2 | — |
| clopidogrel75 | Clopidogrel 75 mg | anticoagulant | 3 | 11 | 2 | — |
| pantoprazole40 | Pantoprazole 40 mg | gi | 3 | 10 | 2 | omeprazole20 |
| ondansetron4 | Ondansetron 4 mg | gi | 4 | 12 | 2 | — |
| doxycycline100 | Doxycycline 100 mg | antibiotics | 5 | 13 | 2 | — |
| ciprofloxacin500 | Ciprofloxacin 500 mg | antibiotics | 4 | 12 | 1 | — |
| fluticasoneInh | Fluticasone inhaler | respiratory | 14 | 26 | 2 | — |
| prednisolone15 | Prednisolone 15 mg/5 mL | pediatric | 4 | 11 | 2 | prednisone10 |
| glimepiride2 | Glimepiride 2 mg | diabetes | 3 | 10 | 1 | glipizide5 |
| tretinoinCr | Tretinoin 0.05% cream | dermatology | 8 | 18 | 1 | — |

### Refrigerated (fridge required; L2 except vaccine dose which needs L4)

| id | name | category | w | r | dw | notes |
|---|---|---|---|---|---|---|
| glargine | Insulin glargine pen | diabetes | 28 | 52 | 2 | |
| lispro | Insulin lispro pen | diabetes | 24 | 45 | 2 | |
| semaglutide | Semaglutide pen | diabetes | 85 | 120 | 2 | modern blockbuster |
| fluVaxDose | Influenza vaccine dose | vaccines | 8 | 30 | 3 | consumed by vaccine service (§14) |

### Tier 3 — Controlled Substances (L3 + cabinet)

| id | name | category | w | r | dw | confusable |
|---|---|---|---|---|---|---|
| tramadol50 | Tramadol 50 mg | pain | 4 | 15 | 2 | trazodone50 |
| hydrocodoneAPAP | Hydrocodone/APAP 5-325 | pain | 5 | 18 | 2 | — |
| oxycodone5 | Oxycodone 5 mg | pain | 6 | 22 | 1 | — |
| alprazolam05 | Alprazolam 0.5 mg | mentalHealth | 3 | 14 | 2 | — |
| clonazepam05 | Clonazepam 0.5 mg | mentalHealth | 3 | 14 | 1 | clonidine01 |
| lorazepam1 | Lorazepam 1 mg | mentalHealth | 3 | 14 | 1 | losartan50 |
| zolpidem10 | Zolpidem 10 mg | mentalHealth | 3 | 13 | 2 | — |
| amphetamineXR20 | Amphetamine salts XR 20 mg | mentalHealth | 7 | 24 | 2 | — |
| methylphenidate10 | Methylphenidate 10 mg | mentalHealth | 6 | 20 | 1 | — |

49 Rx SKUs total. Balance bands by group (post-M16): Tier 1 margin $5–14 · Tier 2 $8–22 ·
refrigerated $27–57 · Tier 3 $14–21. Confusable pairs are real look-alike/sound-alike pairs;
every `confusableWith` id exists in the catalog.

### OTC catalog (front store; player-priced, §10)

| id | name | category | msrp | dw |
|---|---|---|---|---|
| acetaminophen | Acetaminophen 500 mg | pain | 8 | 3 |
| ibuprofen | Ibuprofen 200 mg | pain | 9 | 3 |
| naproxen | Naproxen 220 mg | pain | 10 | 2 |
| aspirin81 | Aspirin 81 mg | pain | 7 | 2 |
| diphenhydramine | Diphenhydramine 25 mg | allergy | 7 | 2 |
| loratadine | Loratadine 10 mg | allergy | 12 | 3 |
| cetirizine | Cetirizine 10 mg | allergy | 13 | 3 |
| fluticasoneSpray | Fluticasone nasal spray | allergy | 16 | 2 |
| dextromethorphan | Cough syrup (DM) | coldflu | 9 | 3 |
| guaifenesin | Guaifenesin 400 mg | coldflu | 11 | 2 |
| pseudoephedrine | Pseudoephedrine 30 mg | coldflu | 12 | 2 |
| lozenges | Throat lozenges | coldflu | 5 | 2 |
| tissues | Facial tissues | coldflu | 4 | 2 |
| omeprazoleOTC | Omeprazole OTC 20 mg | digestive | 14 | 2 |
| famotidine | Famotidine 20 mg | digestive | 10 | 2 |
| loperamide | Loperamide 2 mg | digestive | 9 | 1 |
| multivitamin | Daily multivitamin | wellness | 12 | 2 |
| vitaminD3 | Vitamin D3 2000 IU | wellness | 10 | 2 |
| melatonin | Melatonin 5 mg | wellness | 11 | 2 |
| sanitizer | Hand sanitizer | wellness | 5 | 1 |
| bandages | Adhesive bandages | firstaid | 6 | 2 |
| firstAidKit | First-aid kit | firstaid | 18 | 1 |
| thermometer | Digital thermometer | firstaid | 15 | 1 |

## §26 Tuning constants (authoritative)

| constant | value |
|---|---|
| sim tick | 100 ms scaled; speeds pause/1×/2× |
| in-game day | 08:00–20:00 = 720 igm; 1 real s = 2.4 igm at 1× (~5 min/day) |
| calendar | 7-day weeks · 14-day seasons · 56-day year |
| starting cash / stock | $12,000 · starter stock ~$1,400 (T1 spread + top OTC) |
| base visitors (Old Town, 2.5★) | ≈24/day; `repMult = 0.4 + 0.24 × stars`; concurrent NPC cap 40 |
| customer mix | 60% OTC / 35% Rx / 5% vaccine (when unlocked) |
| patience (igm) | Hurried 45 · Steady 90 · Bargain 90 · Chatty 150; seated ×0.5 drain |
| task durations (igm) | fill 6 · verify 8 · checkout 4 · counsel 10 · vaccine 15; ×speed curve [1.4,1.2,1.0,0.85,0.7] |
| tech fill error % by accuracy | 7.5 / 6.0 / 4.5 / 3.0 / 1.5 (player picks bins manually; Meticulous 0) |
| pharmacist verify catch % by accuracy | 75 / 80 / 85 / 90 / 95; solo-owner implicit catch 90; AI assist 100 |
| rep deltas | +0.02 serve · +0.03 counsel · +0.01 vaccine · −0.06 walkout (Hurried −0.09) · −0.08 stock-out script · −0.15 dispensed error · −0.3 family loan · 1%/day drift → 2.5 |
| wages $/day | cashier 72 · tech 112 · pharmacist 224 · manager 176; pool 3/role, refresh Monday |
| copay / OTC | copay $12 flat · OTC wholesale 46% MSRP · slider 0.8–1.5× · balk 1.15× (Bargain) / 1.35× (all) |
| fixed costs | rent per district (§17) · utilities $20 + $6/powered equipment |
| bank loan | unlock 3.0★ · max 24× 7-day avg gross (cap $60k) · 0.32%/day interest · 1.6%/day min payment |
| family loan | +$2,500 at cash<0 · repay 15% of daily profit · rep −0.3 |
| supplier tiers | −4% wholesale at 2.0★ · −8% at 4.0★ · DC −12% (§20) |
| expansions | $4k → 13×7 · $7k → 13×10 · $12k → 16×10 · $16k → 16×12 |
| eras | Gen 2 $6k · Gen 3 $14.4k · Gen 4 $32k (per store; renovation closes store 1 day) |
| licenses | L2 $8k/2.0★ · L3 $16k/3.0★ · L4 $9.6k/2.5★ · L5 $40k/4.0★ · L6 $32k/L5+2 branches |
| branch purchase | site 300× district daily rent + $12k fit-out |
| off-screen throughput /day | tech 35 fills · pharmacist 50 verifies · cashier 60 checkouts (×speed curve); managerFactor 0.6 / 0.9+0.02×statTotal |
| DC / trucks | DC $48k · truck $6.4k · capacity 400 units · ≤3 stops/morning |
| fridge | $3,500 · 40 refrigerated units each |
| events | rush ×1.6 (12–14, 17–19) · shortage 1–2/season, 4–8 days, wholesale ×1.5, fills capped 60% · storm 1–2/yr, outage 2–5 igh, visitors ×0.6 · flu: Rx resp+abx ×1.8, OTC coldflu ×3, vaccines ×4, visitors ×1.2 · spring allergy ×2.5 OTC allergy · fall pediatric abx ×1.4 · summer visitors ×0.9 |
| vaccines | walk-ins 4–7/day · net +$27 (reimb $35 − dose $8) · 15 igm |
| transfers | 2 bad experiences move a chronic patient pool; weekly evaluation |
| competitor drift | every 28 days, weakest rival improves one notch; shortage: reliability −0.15 |
| AI forecast | requires 28 days history · ±10% noise on true generator · 7-day horizon |
| balance arc targets (for M16) | first hire day 6–9 · L2 ~day 10–14 · Gen 2 ~day 15 · L5 ~day 35–45 · DC ~day 50+ |

## §27 Art direction (3D)

- **Style**: procedural low-poly, flat-shaded (`MeshLambertMaterial`, `flatShading: true`),
  vertex colors or per-part solid materials from a small palette. No textures except one
  generated canvas atlas for Rx bin labels and small signage. No outlines, no post-processing
  (a subtle vignette via CSS is allowed).
- **Camera**: `OrthographicCamera` eagle-eye rig — orbit yaw free, pitch clamped 35°–65°, zoom
  clamps ~8 m to ~30 m viewport height. Pan with right-drag/WASD, orbit left-drag on empty
  space, wheel zoom. Smooth-damped. The store renders **dollhouse style**: exterior walls low
  or roofless from above; front wall fades when it faces the camera.
- **Palette (world)**: ground sage `#8FAE8B`, sidewalk warm gray `#CFC9BD`, store base cream
  `#F1EAD8`. Era interiors: Gen 1 walnut `#6B4A32` + brass `#C9A86A` + checkerboard cream/moss;
  Gen 2 teal `#3E8C84` + linoleum `#D9D4C5` + chrome; Gen 3 gray-blue `#7D93A3` + white gondolas;
  Gen 4 mint `#BFE3D2` + white `#FAFAF7` + glass (transmission ≈ opacity trick, no refraction) +
  light oak.
- **People**: capsule bodies + sphere heads, 6-part color scheme, archetype accent on the torso;
  walk = slight bob + lean; carried items are simple boxes/bags. All customers via
  `InstancedMesh` (body/head/accent layers); staff wear pine-green aprons; the player-owner has
  a white coat.
- **Lighting**: hemisphere ambient + one directional key with a small shadow map (1024) over the
  active store; day arc rotates hue warm→cool→warm 08:00–20:00; winter dims edges; outage drops
  key light to 20% with a cold tint.
- **City map (M12+)**: same palette, blocks of instanced extruded buildings tinted per district,
  parks as sage discs, roads as flat ribbons; player stores get a pine cross marker, competitors
  their accent color, DC a gray depot; trucks are two-box vans that slide along road polylines.
- **Feedback**: hover = slight lift + rim-tint; invalid placement = rose tint; bottleneck station
  = amber pulsing ring; patience ring = shrinking arc overhead (green→amber→rose).

## §28 UI design language (DOM HUD)

**Read the frontend-design skill at the start of every UI milestone.** The direction below is the
settled brief — the skill's process (brainstorm → critique → build, two passes) still applies to
each new screen, using these tokens as constraints. One signature moment per screen, everything
else quiet.

- **Concept: pharmacy paper.** The HUD is made of the pharmacy's own ephemera — Rx pad sheets,
  receipt rolls, shelf labels, blister packs. Panels are paper cards on the glass (the 3D view);
  the world stays visible behind them.
- **Tokens** (`ui/tokens.css`):
  - `--ink #20302B` (green-black text/lines) · `--pine #2F6B4F` (primary, the cross) ·
    `--paper #FBF8F0` (panel ground) · `--amber #E7A03C` (money, warnings, bottlenecks) ·
    `--rose #C0524E` (errors, walk-outs) · `--glass rgba(32,48,43,.55)` (scrim).
  - Era tint: paper warms in Gen 1 (`#FBF4E4`) and cools to clinical white by Gen 4 (`#FCFCFA`)
    via CSS custom property swap on the HUD root — the UI quietly modernizes with the store.
- **Type** (bundled via `@fontsource`, OFL licenses, no network fetch): **Fraunces** for display
  (panel titles, day number, star rating — soft supers, apothecary warmth, used sparingly);
  **Public Sans** for UI body/controls; **IBM Plex Mono** for everything money and data —
  receipts, ledgers, forecasts, bin labels. Scale: 12/14/16/20/28/40, weights 400/600/700.
- **Signature element: the end-of-day receipt.** The day closes with a receipt that *prints* —
  lines appear top-down with a soft dot-matrix stagger onto perforated register paper, Plex Mono,
  amber totals, a rubber-stamp verdict (PROFIT / LOSS / FAMILY LOAN), and pinned paper notes for
  legacy moments. This is the game's memory anchor; keep it pristine.
- **Component kit** (`ui/components/`): Panel (paper card, 1.5 px ink border, 2 px corner notch,
  6 px shadow), PillButton (capsule shape, pine fill / paper text; secondary = outline),
  RxCard (Rx pad sheet: ℞ mark, patient name, drug line, quantity — the fill interaction card),
  Receipt, Meter (blister-pack pips — pressed = spent), StatChip, PriceTag (shelf-label clip for
  OTC pricing), Toast (label sticker that slaps in, 200 ms), Ticker (news strip, Plex Mono),
  Modal (paper sheet over glass scrim), Tabs (file-folder tabs).
- **Layout**: top bar (day/date chip, clock strip with rush shading, cash in Plex Mono, star
  rating, speed controls — keys `Space`/`1`/`2`); bottom dock (pill buttons with mnemonic
  keycaps: `B` build · `O` orders · `T` staff/team · `R` reports · `L` licenses · `C` city;
  `R` rotates instead while holding a build-mode ghost); right rail is contextual (selected
  station/customer). Screens (title, settings, end-of-day, reports) are full paper sheets over
  the scrim.
- **Motion**: 150–250 ms ease-out; panels settle like laid-down paper (4 px drop + fade); the
  receipt print is the only long animation (~1.2 s, skippable on click);
  `prefers-reduced-motion` collapses all of it to instant.
- **Copy voice**: plain verbs, sentence case, specific ("Order 24 units — $72", "Caught at
  verification — refilled"), never apologetic, never clinical-scary. Action names stay identical
  from button → toast → receipt line.
- **Floor**: keyboard focus visible everywhere, hit targets ≥ 32 px, panel text contrast ≥ 4.5:1,
  the HUD scales down to a 1280×800 window.

## §29 Audio direction (WebAudio, fully synthesized)

No audio files, no IP risk: `platform/audio.ts` synthesizes every cue (oscillators + filtered
noise + envelopes). Cues: door chime (two-tone sine, entry), register ding (triangle + short
decay, sale), paper rustle (filtered noise burst, panels/receipt), pill rattle (granular noise
ticks, fill), stamp thunk (low sine + noise, receipt verdict), soft alert (amber events), truck
hum (city). Ambience: faint room tone + murmur (brown noise + slow LFO) scaled to NPC count;
rain layer during storms. Master/SFX/ambience sliders in settings; mute when window unfocused.

## §30 Performance budgets

60 fps on an Apple-silicon MacBook. ≤40 concurrent NPCs (instanced, 3 draw calls for the crowd);
store scene ≤100 draw calls (merge static furniture per era into batched geometry; rebuild on
build-mode changes only); city ≤150. No per-frame allocations in sim tick or render hot paths
(pool vectors, reuse arrays); sim tick ≤2 ms; text updates via cached refs, not innerHTML
rebuilds. Shadows: single 1024 map, static-object caching.

## §31 Milestone index

01 Scaffold + core loop · 02 Store grid + placement · 03 Customers + OTC flow ·
04 Prescription vertical slice · 05 Inventory + economy · 06 Saves + app shell ·
07 Staff + automation · 08 Licenses + expansion · 09 Cold chain + vaccinations ·
10 Modernization + legacy · 11 Events + atmosphere · 12 City map + living demand ·
13 Competitors + market share · 14 Multi-branch · 15 Distribution + logistics ·
16 AI endgame tech + balancing · 17 Audio + polish + packaging.
Briefs live in `docs/milestones/`; run strictly in order; each leaves `npm run dev` green.

## §32 Post-v1 appendix (explicitly out of scope)

Rejected for v1, recorded so future sessions don't re-litigate: insurance claims/rejections/
network negotiation (rejected outright — fixed reimbursement stands in), drone delivery,
telepharmacy, staff schedules/energy/fatigue, general drug expiry, competitors opening new
locations, city growth/new districts, multiplayer/leaderboards, web deployment (Tauri app only;
the codebase stays web-capable if that ever changes), mobile/touch layout.
