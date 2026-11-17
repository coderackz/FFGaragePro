import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { can as canDo, type Action } from "@ffgp/shared";
import { get, getToken, post, setToken } from "./api";
import type { Garage, User } from "./types";

type State =
  | { phase: "loading" }
  | { phase: "offline"; message: string }
  | { phase: "setup" }
  | { phase: "signed-out" }
  | { phase: "signed-in"; user: User; garage: Garage };

interface AuthContext {
  state: State;
  user: User | null;
  garage: Garage | null;
  can(action: Action): boolean;
  signIn(username: string, password: string): Promise<void>;
  completeSetup(body: unknown): Promise<void>;
  signOut(): Promise<void>;
  refreshGarage(): Promise<void>;
  retry(): void;
}

const Ctx = createContext<AuthContext | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ phase: "loading" });

  const load = useCallback(async () => {
    try {
      const { configured } = await get<{ configured: boolean }>("/api/setup/status");
      if (!configured) return setState({ phase: "setup" });
      if (!getToken()) return setState({ phase: "signed-out" });
      const [{ user }, { garage }] = await Promise.all([get<{ user: User }>("/api/me"), get<{ garage: Garage }>("/api/settings")]);
      setState({ phase: "signed-in", user, garage });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 401) setState({ phase: "signed-out" });
      else setState({ phase: "offline", message: (error as Error).message });
    }
  }, []);

  useEffect(() => {
    void load();
    const onSignedOut = () => setState({ phase: "signed-out" });
    window.addEventListener("ffgp:signed-out", onSignedOut);
    return () => window.removeEventListener("ffgp:signed-out", onSignedOut);
  }, [load]);

  const signIn = async (username: string, password: string) => {
    const { token } = await post<{ token: string }>("/api/auth/login", { username, password });
    setToken(token);
    await load();
  };

  const completeSetup = async (body: unknown) => {
    const { token } = await post<{ token: string }>("/api/setup", body);
    setToken(token);
    await load();
  };

  const signOut = async () => {
    await post("/api/auth/logout").catch(() => undefined);
    setToken(null);
    setState({ phase: "signed-out" });
  };

  const refreshGarage = async () => {
    const { garage } = await get<{ garage: Garage }>("/api/settings");
    setState((s) => (s.phase === "signed-in" ? { ...s, garage } : s));
  };

  const user = state.phase === "signed-in" ? state.user : null;
  const garage = state.phase === "signed-in" ? state.garage : null;
  const value: AuthContext = {
    state, user, garage,
    can: (action) => (user ? canDo(user.role, action) : false),
    signIn, completeSetup, signOut, refreshGarage, retry: () => void load(),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
