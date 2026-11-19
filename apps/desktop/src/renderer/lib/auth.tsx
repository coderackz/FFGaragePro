import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { normalizeGarageCode, SETUP_CODE_HEADER, type Action, type LicenceStateName, type Settings } from "@ffgp/shared";
import { allowed, visible } from "./permissions";
import { get, getGarageCode, getToken, isCloud, post, setGarageCode, setToken } from "./api";
import type { Garage, User } from "./types";

type State =
  | { phase: "loading" }
  | { phase: "garage"; error?: string }
  | { phase: "offline"; message: string }
  | { phase: "setup" }
  | { phase: "connect" }
  | { phase: "unpaired" }
  | { phase: "signed-out" }
  | { phase: "signed-in"; user: User; garage: Garage; settings: Settings };

export interface Licence {
  garage: { code: string; name: string };
  state: LicenceStateName;
  endsAt: string;
  graceEndsAt: string;
  daysLeft: number;
  /** PC app: read-only because it hasn't heard from the cloud for 30 days (not_checked), or the subscription ended. */
  reason?: "expired" | "not_checked" | "invalid" | null;
}

const DAY = 86_400_000;

/** A cloud-linked PC's licence (from its last sync), in the same shape as the browser's. */
function pcLicence(s: CloudStatus): Licence | null {
  if (!s.linked) return null;
  const l = s.licence;
  const state = l.readOnly ? "read_only" : l.state;
  const until = state === "grace" ? l.graceEndsAt : l.endsAt;
  const daysLeft = until ? Math.max(0, Math.ceil((Date.parse(until) - Date.now()) / DAY)) : 0;
  return { garage: { code: s.garageCode, name: "" }, state, endsAt: l.endsAt ?? "", graceEndsAt: l.graceEndsAt ?? "", daysLeft, reason: l.reason };
}

interface AuthContext {
  state: State;
  /** Fleetfix Cloud only: the garage's subscription, for the banner and read-only mode. */
  licence: Licence | null;
  readOnly: boolean;
  /** Fleetfix Cloud only: open a garage by its ID. Returns an error message, or null. */
  chooseGarage(code: string): string | null;
  changeGarage(): void;
  user: User | null;
  garage: Garage | null;
  /** The garage's settings (with defaults), for every signed-in user. */
  settings: Settings | null;
  /** May the user do this now (false for changes when the cloud garage is read-only). */
  can(action: Action): boolean;
  /** May the user see the screen for this action (read-only garages still see everything). */
  canSee(action: Action): boolean;
  signIn(username: string, password: string): Promise<void>;
  completeSetup(body: unknown, setupCode?: string): Promise<void>;
  signOut(): Promise<void>;
  refreshGarage(): Promise<void>;
  retry(): void;
  /** Shows the "connect to the main computer" screen. */
  startConnect(): void;
}

const Ctx = createContext<AuthContext | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [licence, setLicence] = useState<Licence | null>(null);

  const load = useCallback(async () => {
    if (isCloud && !getGarageCode()) return setState({ phase: "garage" });
    try {
      if (isCloud) setLicence(await get<Licence>("/api/cloud/licence"));
      else if (window.ffgp?.cloudLinked) setLicence(pcLicence(await window.ffgp.cloudStatus()));
      const { configured } = await get<{ configured: boolean }>("/api/setup/status");
      if (!configured) return setState({ phase: "setup" });
      if (!getToken()) return setState({ phase: "signed-out" });
      const [{ user }, { garage, settings }] = await Promise.all([get<{ user: User }>("/api/me"), get<{ garage: Garage; settings: Settings }>("/api/settings")]);
      setState({ phase: "signed-in", user, garage, settings });
    } catch (error) {
      const { status, code } = error as { status?: number; code?: string };
      if (code === "unknown_garage") {
        setGarageCode(null);
        setState({ phase: "garage", error: "No garage with that ID" });
      } else if (code === "device_not_paired") setState({ phase: "unpaired" });
      else if (status === 401) setState({ phase: "signed-out" });
      else setState({ phase: "offline", message: (error as Error).message });
    }
  }, []);

  useEffect(() => {
    void load();
    const onSignedOut = () => setState({ phase: "signed-out" });
    const onUnpaired = () => setState({ phase: "unpaired" });
    const onUnknownGarage = () => {
      setGarageCode(null);
      setToken(null);
      setState({ phase: "garage", error: "No garage with that ID" });
    };
    window.addEventListener("ffgp:signed-out", onSignedOut);
    window.addEventListener("ffgp:unpaired", onUnpaired);
    window.addEventListener("ffgp:unknown-garage", onUnknownGarage);
    // A linked PC: each sync brings a fresh licence.
    const offCloud = window.ffgp?.cloudLinked ? window.ffgp.onCloudStatus((s) => setLicence(pcLicence(s))) : undefined;
    return () => {
      offCloud?.();
      window.removeEventListener("ffgp:signed-out", onSignedOut);
      window.removeEventListener("ffgp:unpaired", onUnpaired);
      window.removeEventListener("ffgp:unknown-garage", onUnknownGarage);
    };
  }, [load]);

  const signIn = async (username: string, password: string) => {
    const { token } = await post<{ token: string }>("/api/auth/login", { username, password });
    setToken(token);
    await load();
  };

  const completeSetup = async (body: unknown, setupCode?: string) => {
    const { token } = await post<{ token: string }>("/api/setup", body, setupCode ? { [SETUP_CODE_HEADER]: setupCode.trim() } : undefined);
    setToken(token);
    await load();
  };

  const signOut = async () => {
    await post("/api/auth/logout").catch(() => undefined);
    setToken(null);
    setState({ phase: "signed-out" });
  };

  /** Re-reads the garage profile and settings after a change. */
  const refreshGarage = async () => {
    const { garage, settings } = await get<{ garage: Garage; settings: Settings }>("/api/settings");
    setState((s) => (s.phase === "signed-in" ? { ...s, garage, settings } : s));
  };

  const user = state.phase === "signed-in" ? state.user : null;
  const garage = state.phase === "signed-in" ? state.garage : null;
  const settings = state.phase === "signed-in" ? state.settings : null;
  const readOnly = licence?.state === "read_only";
  const chooseGarage = (input: string): string | null => {
    const code = normalizeGarageCode(input);
    if (!code) return "A garage ID has 3–40 letters, numbers or dashes";
    setGarageCode(code);
    setState({ phase: "loading" });
    void load();
    return null;
  };
  const changeGarage = () => {
    setToken(null);
    setGarageCode(null);
    setLicence(null);
    setState({ phase: "garage" });
  };
  const value: AuthContext = {
    state, user, garage, settings, licence, readOnly, chooseGarage, changeGarage,
    can: (action) => (user ? allowed(user.role, action, readOnly) : false),
    canSee: (action) => (user ? visible(user.role, action) : false),
    signIn, completeSetup, signOut, refreshGarage, retry: () => void load(),
    startConnect: () => setState({ phase: "connect" }),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
