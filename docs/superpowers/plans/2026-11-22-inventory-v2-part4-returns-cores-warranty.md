# Inventory v2, Part 4: Returns, cores and warranty claims — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:**
- **Return to supplier** (RTS-00001): parts go back off the shelf at their cost and a supplier debit note is made;
- **Cores:** a part's core deposit is paid with the delivery and owed back until the old unit goes back (a debit note) or is written off;
- **Warranty claims** (WC-00001) against the supplier for a part or a battery serial: open → replaced (the replacement comes into stock at no cost) / credited (a debit note) / rejected.

**Architecture:**
- One debit note document for all three: `supplier_returns` (kind `return` | `core` | `warranty`) with `supplier_return_lines`; numbered RTS (new number kind `supplier_return`, prefix in Settings → Numbering).
- `warranty_claims` (new number kind `warranty_claim`, WC); `core_writeoffs`.
- `parts.core_fils` (deposit per unit) and `goods_receipt_lines.core_fils`: receiving shows the deposit; it is part of the supplier's bill.
- Supplier ledger: a debit note lowers what's owed (balance, statement, aging); it settles the oldest open items first, like an automatic allocation.
- Books: a new system account **1220 Core deposits**.
  - Goods receipt: the deposit goes to 1220 (not inventory).
  - Return debit note: Dr payables / Cr input VAT / Cr inventory at the stock cost, with any difference to stock adjustments.
  - Core debit note: Dr payables / Cr input VAT / Cr core deposits. Core write-off: Dr stock adjustments / Cr core deposits.
  - Warranty credit: Dr payables / Cr input VAT / Cr cost of parts sold.
- VAT return: a debit note lowers box 9 and its input VAT.
- Migration 24; the new tables sync (after suppliers, parts, documents).

**Spec:** `docs/superpowers/specs/2026-11-21-inventory-v2-design.md` (Part 4).

## Global Constraints
- Stock only moves in stock.ts (new movement reason `supplier_return`, posted inside the debit note entry, not by postStock).
- Tracked parts go back one by one (the units chosen become `returned`); a warranty replacement for a battery enters its new serial.
- Payables and debit notes: Owner and Accountant (`payables.manage`); advisors never see costs.

## Review Focus
1. Return 2 filters (avg AED 20) credited at AED 22 + VAT: stock −2, payables −46.20, inventory −40, stock adjustments −4, input VAT −2.20 (Task 2 `return`).
2. A delivery of 2 alternators with a AED 150 core each: 300 on 1220; returning 1 core makes a AED 150 (+VAT) debit note; writing off the other clears 1220 (Task 2 `cores`).
3. The supplier's balance, statement and aging fall by each debit note; a payment still allocates to what's left (Task 2 `ledger`).
4. A battery warranty claim replaced: the old serial `returned`, the new serial in stock at no cost; credited: a debit note to cost of parts (Task 3 `warranty`).

### Task 1: Shared schemas, number kinds, migration 24
### Task 2: Server: returns and cores (stock, ledger, books, VAT)
### Task 3: Server: warranty claims
### Task 4: Screens and e2e (`e2e:returns`), help guide, README; full verification
