# Vehicle makes and models: a list, suggestions and auto-correction — design

**Date:** 2026-11-27 · **Status:** approved by the user in chat ("yes go ahead", after "Dont ask show auto correction"). *(my call)* marks builder decisions.

## Why

The user: "why the vehicle make & models are text fields?" Make and model are free text (60 characters). Spellings drift ("Toyta", "LC200", "landcruser"), so "Fits this vehicle" misses parts (it compares upper-cased text with spaces collapsed, not removed), search and reports split one car into several, and vendors' price requests show whatever was typed.

## Decided by the user

- A list of makes and models, suggested while typing.
- A vehicle not in the list is never blocked: it is kept as typed and joins the garage's list quietly.
- **No questions:** close misspellings are corrected automatically, like a phone keyboard, with "Corrected from Toyta · Undo".
- The owner can fix the garage's list later (rename / merge spellings).

## Goals

1. **Built-in list** of makes and models common in the UAE, with short names (LC200 → Land Cruiser, Merc → Mercedes-Benz, VW → Volkswagen…). Ships with the app, works offline.
2. **Garage's list** = the makes and models already on its vehicles and parts' fitments *(my call: no new table; a name is in the list once a vehicle or fitment uses it, so it syncs with them)*.
3. **Suggestions while typing** in Make and Model (models of the make chosen).
4. **Auto-correction when leaving the box:**
   - Known name, other capitals/spacing → the list's spelling, silently ("toyota" → "Toyota").
   - Short name → full name, with the note.
   - Misspelling → the one known name within 1 letter (names up to 5 letters) or 2 letters (longer), with the note. Two equally close names: left alone.
   - Models are corrected only among the chosen make's models.
   - A model typed with the make blank fills the make when only one make has it ("Land Cruiser" → Toyota) *(my call)*.
   - A VIN typed with the make blank fills the make from the VIN's first characters (offline table of common manufacturers) *(my call; offered earlier, cheap)*.
   - **Undo** keeps what was typed; it isn't corrected again on that form, and once saved it is in the garage's list, so it is never corrected again.
   - Nothing close: kept as typed (joins the garage's list when saved).
5. **Same boxes on a part's "Fits these vehicles"** *(my call)*.
6. **Matching** ("Fits this vehicle") ignores spaces and punctuation too ("LANDCRUISER" = "Land Cruiser").
7. **Owner tidies the list:** Vehicles → "Makes & models" lists the garage's names with how many vehicles use each, marks names that look like a list name ("looks like Toyota"), and renames/merges: every vehicle and fitment with that spelling changes (synced as ordinary vehicle edits). Owner only (`settings.manage`).

## Non-goals

Model years per model; trims; decoding model/year from the VIN (online services know US-spec cars, not GCC-spec); editing the built-in list in the app.

## Anti-goals

Asking the advisor anything; a correction to a different car than meant (only one close match, models within their make, Undo); blocking a vehicle that isn't listed.

## Constraints

No migration. Offline. Older PCs keep working (they send free text). Correction happens on the screen; the server stores what it's sent *(my call: Undo must be able to keep the typed text)*.
