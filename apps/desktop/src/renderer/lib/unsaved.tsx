import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";

interface Unsaved {
  /** A screen reports whether it has unsaved changes (and what to call them). */
  report(dirty: boolean, title: string): void;
  /** True when it's fine to leave: nothing unsaved, or the person agreed to lose it. */
  confirmLeave(): boolean;
}

const Ctx = createContext<Unsaved>({ report: () => undefined, confirmLeave: () => true });

/** Lets Settings sections ask before someone leaves with unsaved changes (menu links, "← All settings", closing). */
export function UnsavedProvider({ children }: { children: ReactNode }) {
  const state = useRef<{ dirty: boolean; title: string }>({ dirty: false, title: "" });
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (state.current.dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);
  const report = useCallback((dirty: boolean, title: string) => {
    state.current = { dirty, title };
  }, []);
  const confirmLeave = useCallback(() => {
    if (!state.current.dirty) return true;
    const leave = window.confirm(`Leave without saving? Your changes to ${state.current.title} will be lost.`);
    if (leave) state.current = { dirty: false, title: "" };
    return leave;
  }, []);
  const value = useMemo(() => ({ report, confirmLeave }), [report, confirmLeave]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUnsaved(): Unsaved {
  return useContext(Ctx);
}

/** Reports a screen's unsaved state while it is shown. */
export function useReportUnsaved(dirty: boolean, title: string): void {
  const { report } = useUnsaved();
  useEffect(() => {
    report(dirty, title);
  }, [dirty, title, report]);
  useEffect(() => () => report(false, ""), [report]);
}
