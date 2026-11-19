import { Lock } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { ApiError, post, setToken } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button, Field, Input } from "./ui";

const LOCKED_KEY = "ffgp.locked";
const EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;

function readLocked(): boolean {
  try {
    return sessionStorage.getItem(LOCKED_KEY) === "1";
  } catch {
    return false;
  }
}
function writeLocked(v: boolean): void {
  try {
    if (v) sessionStorage.setItem(LOCKED_KEY, "1");
    else sessionStorage.removeItem(LOCKED_KEY);
  } catch {
    // storage unavailable: the lock still holds for this page
  }
}

/**
 * Settings → Security: after `minutes` without input the screen is covered until the same person types their
 * password (or someone else signs in). Whatever was on screen, including unsaved work, stays underneath.
 * Reloading the window doesn't get past it.
 */
export function IdleLock({ minutes }: { minutes: number }) {
  const { user, signOut } = useAuth();
  const [locked, setLocked] = useState(readLocked);
  const last = useRef(Date.now());

  const lock = useCallback(() => {
    writeLocked(true);
    setLocked(true);
  }, []);

  useEffect(() => {
    if (!minutes || locked) return;
    last.current = Date.now();
    const seen = () => {
      last.current = Date.now();
    };
    for (const e of EVENTS) window.addEventListener(e, seen, { passive: true });
    const timer = window.setInterval(() => {
      if (Date.now() - last.current >= minutes * 60_000) lock();
    }, 5_000);
    return () => {
      for (const e of EVENTS) window.removeEventListener(e, seen);
      window.clearInterval(timer);
    };
  }, [minutes, locked, lock]);

  const unlock = () => {
    writeLocked(false);
    setLocked(false);
  };
  // While locked, the app underneath is inert: Tab can't reach it and keys don't act on it.
  const shown = locked && !!user;
  useEffect(() => {
    const root = document.getElementById("root");
    if (!root) return;
    root.inert = shown;
    return () => {
      root.inert = false;
    };
  }, [shown]);
  if (!shown) return null;
  return createPortal(
    <LockScreen name={user.name} username={user.username} onUnlock={unlock} onSwitch={() => { writeLocked(false); void signOut(); }} />,
    document.body,
  );
}

function LockScreen({ name, username, onUnlock, onSwitch }: { name: string; username: string; onUnlock: () => void; onSwitch: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { token } = await post<{ token: string }>("/api/auth/login", { username, password });
      await post("/api/auth/logout").catch(() => undefined); // the session from before the lock isn't kept
      setToken(token);
      onUnlock();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? "That password isn't right" : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-ink px-4" role="dialog" aria-modal="true" aria-label="Locked">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-full bg-zinc-100"><Lock className="size-5 text-zinc-700" /></div>
          <div>
            <div className="text-lg font-semibold text-zinc-900">Locked</div>
            <div className="text-sm text-zinc-600">{name}</div>
          </div>
        </div>
        <Field label="Password">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="current-password" required />
        </Field>
        {error && <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <Button type="submit" variant="primary" busy={busy} className="mt-4 h-10 w-full">Unlock</Button>
        <button type="button" onClick={onSwitch} className="mt-3 w-full text-center text-sm text-zinc-600 underline underline-offset-2 hover:text-zinc-900">
          Sign in as someone else
        </button>
      </form>
    </div>
  );
}
