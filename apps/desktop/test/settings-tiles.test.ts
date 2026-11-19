import { DEFAULT_SETTINGS, type Settings } from "@ffgp/shared";
import { describe, expect, it } from "vitest";
import { gettingReady, TILES, type TileContext } from "../src/renderer/pages/settings/tiles";

const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const HOUR = 3_600_000;

function ctx(patch: Partial<TileContext> = {}, settings: Partial<{ [S in keyof Settings]: Partial<Settings[S]> }> = {}): TileContext {
  const s = structuredClone(DEFAULT_SETTINGS);
  for (const [k, v] of Object.entries(settings)) Object.assign((s as Record<string, object>)[k]!, v);
  return {
    garage: { name: "Al Quoz Auto Care", trn: null, address: null, phone: null, email: null, vatRateBp: 500 },
    settings: s,
    overview: { nextNumbers: { estimate: "EST-00001", jobcard: "JC-00001", invoice: "INV-00143", purchase_order: "PO-00001" }, users: 4, changesThisWeek: 12 },
    isCloud: false,
    pcMode: "local",
    backup: null,
    cloud: { linked: false, syncing: false },
    syncIssues: 0,
    version: "0.1.0",
    licence: null,
    now: NOW,
    ...patch,
  };
}
const tile = (id: string) => TILES.find((t) => t.id === id)!;
const status = (id: string, c: TileContext) => tile(id).status(c);

describe("settings tiles", () => {
  it("a fresh garage shows what's left to do", () => {
    const c = ctx();
    expect(status("garage", c)).toEqual({ tone: "todo", text: "VAT TRN missing" });
    expect(status("garage", ctx({ garage: { ...c.garage, trn: "100234567890003" } }))).toEqual({ tone: "todo", text: "Bank details missing" });
    expect(status("documents", c)).toEqual({ tone: "todo", text: "Logo missing" });
    expect(status("numbering", c)).toEqual({ tone: "ok", text: "Next invoice INV-00143" });
    expect(status("tax", c)).toEqual({ tone: "ok", text: "Prices exclude VAT · quarterly" });
    expect(status("pricing", c)).toEqual({ tone: "todo", text: "No labour rate set" });
    expect(status("pricing", ctx({}, { pricing: { labourRateFils: 18000 } }))).toEqual({ tone: "ok", text: "AED 180.00 / hour" });
    expect(status("inventory", c)).toEqual({ tone: "ok", text: "Warn only" });
    expect(status("users", c)).toEqual({ tone: "ok", text: "4 users" });
    expect(status("security", c)).toEqual({ tone: "ok", text: "Locks after 15 min" });
    expect(status("activity", c)).toEqual({ tone: "ok", text: "12 changes this week" });
    expect(status("about", c)).toEqual({ tone: "ok", text: "Version 0.1.0" });
    expect(status("customers-credit", c)).toEqual({ tone: "muted", text: "Coming in Part 2" });
    expect(tile("messages").coming).toBe(true);
  });

  it("backups go amber, then red", () => {
    const folder = "C:/Users/x/Documents/Fleetfix Backups";
    expect(status("backups", ctx({ backup: { folder, folderOk: true, last: null, keepDays: 30 } }))).toEqual({ tone: "todo", text: "No backup yet" });
    expect(status("backups", ctx({ backup: { folder, folderOk: false, last: null, keepDays: 30 } }))).toEqual({ tone: "alert", text: "Backup folder not found" });
    expect(status("backups", ctx({ backup: { folder, folderOk: true, last: new Date(NOW - 4 * 24 * HOUR).toISOString(), keepDays: 30 } })))
      .toEqual({ tone: "alert", text: "Last backup 4 days ago" });
    expect(status("backups", ctx({ backup: { folder, folderOk: true, last: new Date(NOW - 2 * HOUR).toISOString(), keepDays: 30 } })))
      .toEqual({ tone: "ok", text: "Last backup 2 hours ago" });
  });

  it("tiles show where they make sense", () => {
    const browser = ctx({ isCloud: true, pcMode: null, cloud: null });
    expect(tile("backups").show(browser)).toBe(false);
    expect(tile("other-pcs").show(browser)).toBe(false);
    expect(tile("cloud").show(browser)).toBe(false);
    expect(tile("sync-issues").show(browser)).toBe(false);
    expect(tile("sync-issues").show({ ...browser, syncIssues: 3 })).toBe(true);
    expect(status("sync-issues", { ...browser, syncIssues: 3 })).toEqual({ tone: "alert", text: "3 to review" });
    expect(tile("backups").show(ctx({ pcMode: "client" }))).toBe(false);
    expect(tile("backups").show(ctx({ pcMode: "main" }))).toBe(true);
    expect(status("cloud", ctx())).toEqual({ tone: "muted", text: "Not connected" });
    expect(status("other-pcs", ctx({ pcMode: "main" }))).toEqual({ tone: "ok", text: "Sharing with other PCs" });
  });

  it("getting ready lists the essentials", () => {
    const pc = gettingReady(ctx());
    expect(pc.total).toBe(9);
    expect(pc.missing).toEqual(["VAT TRN", "Address", "Phone", "Bank details", "Logo", "Labour rate", "Invoice terms", "Backup folder"]);
    expect(gettingReady(ctx({ isCloud: true, pcMode: null })).total).toBe(8);
    const done = gettingReady(
      ctx(
        {
          garage: { name: "G", trn: "100234567890003", address: "Dubai", phone: "04", email: null, vatRateBp: 500 },
          backup: { folder: "x", folderOk: true, last: null, keepDays: 30 },
        },
        { garage: { bankName: "ENBD", iban: "AE070260001012345678901" }, documents: { logo: "data:image/png;base64,AAAA", terms: "Pay in 30 days" }, pricing: { labourRateFils: 18000 } },
      ),
    );
    expect(done).toEqual({ done: 9, total: 9, missing: [] });
  });
});
