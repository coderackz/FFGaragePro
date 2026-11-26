# Remove Arabic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans.

**Goal:** No Arabic anywhere in the app — screens, printouts, messages, settings and saved data. **Spec:** docs/superpowers/specs/2026-11-27-remove-arabic-design.md

## Global Constraints
- Migration 30 drops the Arabic columns (after dropping the sync triggers that name them) and cleans the Arabic settings.
- Every printout and message is English; the message log is kept.

## Review Focus
1. A linked PC upgraded: migration runs with its sync triggers installed — must not fail.
2. A PC's pending changes captured before the upgrade (with name_ar etc.) reaching the cloud after — ignored, not an error.
3. Message settings saved with Arabic fields — read back cleanly, no Arabic left.
4. An issued English + Arabic invoice reprinted — English only, same totals.
5. Customer CSV import/export and the cloud admin console — no Arabic columns left.

### Task 1: Shared and server (schemas, settings, message texts, words, used-part text, routes, migration 30) — tests updated first.
### Task 2: Screens and prints (forms, settings sections, send dialog, templates, payroll, delete arabic.ts and the font) — tests and e2e updated.
