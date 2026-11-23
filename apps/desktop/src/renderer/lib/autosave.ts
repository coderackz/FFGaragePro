import { useCallback, useEffect, useRef, useState } from "react";
import type { DocType } from "@ffgp/shared";

/** Where this PC keeps a document's unsaved changes: per garage, per document (a new one per type). */
export const draftKey = (garageId: string, docId: string | null, type: DocType): string => `ffgp.docdraft.${garageId}.${docId ?? `new-${type}`}`;

/** Unsaved changes kept on this PC, with when they were kept. Storage that refuses (private window) reads as none. */
export function readLocalDraft<T>(key: string): { draft: T; savedAt: string } | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { draft: T; savedAt: string };
    return parsed && typeof parsed.savedAt === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function writeLocalDraft<T>(key: string, draft: T): void {
  try {
    localStorage.setItem(key, JSON.stringify({ draft, savedAt: new Date().toISOString() }));
  } catch {
    /* storage full or blocked: the server save still runs */
  }
}

export function clearLocalDraft(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* nothing kept */
  }
}

/** A new document is created (and numbered) only once it has a customer and a line with a title. */
export const readyToCreate = (d: { customer: unknown; lines: { description: string }[] }): boolean =>
  !!d.customer && d.lines.some((l) => l.description.trim() !== "");

export type AutosaveState = "idle" | "saving" | "saved" | "error" | "approval" | "conflict";

/**
 * Saves `revision`'s changes a moment after the last one, one save at a time (a change during a save gets one more
 * save after it), and when the screen closes. A failure retries every 5 s; a save that needs the Owner's approval or
 * that someone else's newer change refuses stops and waits for the person. Once the screen is closed a failure isn't
 * retried: the copy kept on this PC comes back when the document is opened again (retrying too could save it twice).
 */
export function useAutosave(opts: { dirty: boolean; canSave: boolean; revision: number; save: () => Promise<void>; delayMs?: number }) {
  const { dirty, canSave, revision, delayMs = 1000 } = opts;
  const [state, setState] = useState<AutosaveState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const saveRef = useRef(opts.save);
  saveRef.current = opts.save;
  const inFlight = useRef<Promise<void> | null>(null);
  const again = useRef(false);
  const stopped = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closed = useRef(false);
  const live = useRef({ dirty, canSave });
  live.current = { dirty, canSave };

  const run = useCallback(async (): Promise<void> => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (inFlight.current) {
      again.current = true;
      return inFlight.current;
    }
    if (!live.current.dirty || !live.current.canSave) return;
    setState("saving");
    const attempt = (async () => {
      try {
        await saveRef.current();
        stopped.current = false;
        setState("saved");
        setMessage(null);
      } catch (err) {
        // Errors from the API carry a status and, for "needs the Owner", a code ending in _approval.
        const e = err as { status?: number; code?: string; message: string };
        if (e.code?.endsWith("_approval")) {
          stopped.current = true;
          setState("approval");
        } else if (e.status === 409 && /another computer/.test(e.message)) {
          stopped.current = true;
          setState("conflict");
        } else {
          setState("error");
          if (!closed.current) timer.current = setTimeout(() => void run(), 5000);
        }
        setMessage((err as Error).message);
      }
    })();
    inFlight.current = attempt;
    await attempt;
    inFlight.current = null;
    if (again.current) {
      again.current = false;
      if (!stopped.current) await run();
    }
  }, []);

  // A moment after the last change.
  useEffect(() => {
    if (!dirty || !canSave || stopped.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(), delayMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [revision, dirty, canSave, delayMs, run]);

  // Leaving the screen (or closing the window) saves what's waiting.
  useEffect(() => {
    const flush = () => {
      if (live.current.dirty && live.current.canSave && !stopped.current) void run();
    };
    closed.current = false;
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      closed.current = true;
      flush();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [run]);

  /** Saves now (before an action that needs the document saved); resolves once nothing is waiting. */
  const saveNow = useCallback(async () => {
    stopped.current = false;
    await run();
    if (inFlight.current) await inFlight.current;
  }, [run]);

  /** After the person dealt with an approval or a conflict. */
  const resume = useCallback(() => {
    stopped.current = false;
    setState("idle");
    setMessage(null);
  }, []);

  return { state, message, saveNow, resume };
}
