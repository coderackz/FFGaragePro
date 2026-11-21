# Inventory v2, Part 3: Planning and reports — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:**
- min/max levels suggested from usage (90-day usage × (lead time + 14 days) for the minimum; plus 30 days' usage for the maximum), accepted or overridden per part by the owner;
- a preferred supplier and lead time per part;
- **Suggested orders:** anything at or below its minimum, counting stock already on order, topped up to its maximum, grouped by supplier, made into draft POs in one click;
- reports: ABC by 12-month usage value, fast and slow movers, dead stock (6 or 12 months), valuation by category, aging by last receipt.

**Architecture:**
- `parts.reorder_level` stays the minimum ("reorder at"); migration 23 adds `max_level`, `preferred_supplier_id`, `lead_time_days` (default 7).
- Usage = stock that left for jobs and invoices, less what credit notes put back (`stock_movements` with reason job/invoice, and adjust on a credit note).
- Pure helpers in `packages/shared/src/planning.ts`: `suggestLevels`, `abcClasses`, `stockAgeBucket`.
- Server `packages/server/src/inventory/planning.ts`: usage, stock on order, levels, suggested orders, the reports. Routes under `/api/inventory/*` and `/api/reports/inventory/*`.
- Screens: **Inventory → Reorder** (suggested orders; min/max levels) and **Reports → Stock reports** (ABC, movers, dead stock, valuation, aging). The part form gains "Order up to", preferred supplier and lead time.

**Spec:** `docs/superpowers/specs/2026-11-21-inventory-v2-design.md` (Part 3).

## Global Constraints
- Nothing changes for a part without levels: `max_level` 0 and no preferred supplier behave as now (reorder level as before).
- Kits and parts bought per job are never planned (their parts are).
- Values (costs) only for those who may see costs; advisors see quantities only.
- Draft POs made from suggestions are ordinary drafts (editable, priced at the supplier's last price, else the average cost).

## Review Focus
1. A part used 45 in 90 days with a 7-day lead time: min 11, max 26 (Task 1 `levels`).
2. On hand 3, on order 5 (a sent PO), min 10, max 20: suggested 12; drafts count as on order, so making the drafts twice suggests nothing the second time (Task 2 `suggested`).
3. ABC: 80 % / 95 % cut-offs by usage value, parts with no usage are C (Task 1 `abc`).
4. Dead stock lists only parts with stock and no use since the cut-off; valuation by category adds up to the stock value (Task 2 `reports`).

### Task 1: Shared helpers and migration 23
### Task 2: Server: levels, suggested orders, reports
### Task 3: Screens and e2e (`e2e:planning`), help guide, README; full verification
