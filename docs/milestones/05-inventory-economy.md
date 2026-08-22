# Milestone 05 — Inventory + economy

One-session brief. **Read first**: `SPEC.md` §10 (economy — every rule), §11 (inventory and
suppliers), §25 (catalog numbers), §26 (costs, loans, starter stock), §17 (fillRate feeds
availability later — record it now). New panels (Orders, price tags) are significant UI: **read
and follow the frontend-design skill first**; §28 defines PriceTag and the ledger aesthetic
(Plex Mono for all money).

## State you inherit

Milestones 01–04: the playable solo pharmacy on seeded starter stock, receipt v1, live
reputation, cash from sales.

## Goal

Money and stock become real systems: wholesale ordering with next-morning delivery, backroom vs
shelf inventory, stock-outs that cost sales and reputation, player-set OTC pricing with balk
rules, a complete ledger-driven P&L on the receipt, and realistic borrowing with the family-loan
soft floor.

## Non-goals

No supplier rep tiers taking effect below 2.0★ (implement the rule; it simply won't trigger
early), no reorder rules UI until the first stock-out has occurred (§11 — teach-by-need), no
staff, no DC/bulk pricing (15), no AI forecast column (16).

## Tasks

1. `sim/inventory.ts` (§11): per-SKU `backroom` + `shelved`; deliveries land in backroom at
   morning; restock = player clicks a shelf/bin to top it up from backroom (instant, solo era);
   fills and sales consume; `stock.out` events; per-store `fillRate7d` trailing record (§17).
2. Orders panel (bottom dock, morning or mid-shift): license-filtered wholesale catalog rows —
   name, category chips, wholesale (with supplier-tier discount when earned), reimbursement or
   MSRP, **margin** (color: amber when thin, rose when negative), on-hand, 7-day sales, qty
   stepper, cart total; submit → cash out now, goods arrive next morning (`order.submit`,
   delivery event). Frontend-design pass on this panel; Plex Mono numerals.
3. OTC pricing (§10): PriceTag control (§28 shelf-label clip) on each OTC SKU row and on shelf
   hover — slider 0.8×–1.5× MSRP; Bargain customers skip items >1.15×, everyone skips >1.35×;
   store price index computed for §17 (recorded, unused yet).
4. `sim/economy.ts` ledger (§10): every cash movement is a typed line with a reason; receipt v2
   groups revenue (Rx reimbursements, copays, OTC, refunds−) and costs (orders, rent $80,
   utilities $20 + $6/powered, loan interest); verdict stamp logic extends (FAMILY LOAN state).
5. Loans (§10/§26): bank credit line (locked until 3.0★ — visible but disabled with the reason),
   draw/repay UI in a small Bank panel; 0.4%/day interest, 2%/day auto minimum. Family loan:
   auto-triggers at close if cash < 0 → +$2,500, rep −0.3, auto-repay 15% of daily profit,
   pinned paper note on the receipt ("Aunt Rosa covered the register…" per §22 tone).
6. First-stock-out unlock: after the first `stock.out`, the Orders panel reveals optional
   per-SKU min/target levels that auto-draft (never auto-send) a morning order (§11).
7. Starter stock rebalance: state factory now seeds exactly $1,500 of starter inventory (§26)
   instead of infinite bins; verify day-1 play survives on it.

## Acceptance criteria

- [ ] Order → cash deducts now → goods in backroom next morning; restock clicks move it to
      shelves/bins; unstocked shelves/bins stop selling/filling with §15 penalties and receipt
      lines.
- [ ] Margins display correctly from §25 (spot-check apixaban $16, lisinopril $6). Refrigerated
      SKUs are absent from the catalog list entirely this milestone — even if a fridge was
      placed early — with cold-chain ordering wired in milestone 09.
- [ ] Raising an OTC price above 1.15× visibly loses Bargain sales; above 1.35× kills the SKU.
- [ ] The receipt's groups sum exactly to the day's cash delta (assert in dev mode).
- [ ] Forcing a bad day (dev: spend to near zero) triggers the family loan exactly per spec —
      floor at +$2,500, rep −0.3, repayment visible on following receipts, no second loan while
      one is open.
- [ ] Reorder rules appear only after a stock-out; drafts populate the cart correctly.
- [ ] Zero console errors; 60 fps.

## Boundaries (standing)

Dev server only (`npm run dev`); never run build/compile commands. No React, no `useEffect`.
`sim/` imports nothing from render/ui/platform. TypeScript strict. Implement exactly this brief.
Leave the repo runnable and clean.

## Handoff to 06

A real economy with ledger integrity. 06 makes progress durable: saves, title/settings/pause
shell, export/import.
