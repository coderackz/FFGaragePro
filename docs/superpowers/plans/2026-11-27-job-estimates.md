# Job estimates (Stage 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans.

**Goal:** Estimate from a job card (one per job card, re-estimated as EST-n-1, -2), recorded approval with declined lines, approval written back to the job card, vendor prices on estimate lines, a warning before ordering unapproved work. **Spec:** docs/superpowers/specs/2026-11-27-job-estimates-design.md

## Global Constraints
- Migration 31: documents.for_job_id, revision, approved_at, approved_via, approved_by_name, approval_note, approval_recorded_by; document_lines.declined; document_versions (insert-only, synced).
- Lines match between job card and estimate by kind + trimmed lower-case text, in order.
- Declined lines are stored with their price but count 0 in totals (so sync's sum of line totals agrees).
- Vendor prices only for costs.view. Approved estimates aren't editable; Re-estimate makes the next version.

## Review Focus
1. A job card line added after the estimate — kept on approval.
2. Two lines with the same text — matched in order, neither lost.
3. A declined part that was already bought — cost stays on the job (uncharged).
4. Converted-first estimate re-estimated for its job card — no second job card, links right both ways.
5. An older screen setting status Approved — recorded, written back.

### Task 1: Server (migration 31, routes, write-back, versions, vendor prices, order info) — tests packages/server/test/job-estimates.test.ts, sync test.
### Task 2: Screens (job card button and estimate panel, Record approval dialog, declined lines, re-estimate, versions, vendor price hints, order warning), prints, help, e2e apps/desktop/test/job-estimates.spec.ts.
