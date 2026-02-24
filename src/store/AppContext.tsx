import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AuthState, WizardSetup } from "../types";

type AppContextValue = {
  auth: AuthState | null;
  setAuth: (auth: AuthState | null) => void;
  setup: WizardSetup | null;
  setSetup: (setup: WizardSetup | null) => void;
};

const AppContext = createContext<AppContextValue | undefined>(undefined);
const SETUP_STORAGE_KEY = "dkauto.setup";

export function AppProvider({ children }: { children: ReactNode }): JSX.Element {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [setup, setSetup] = useState<WizardSetup | null>(() => {
    if (typeof window === "undefined") {
      return null;
    }
    const raw = window.localStorage.getItem(SETUP_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as WizardSetup;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (!setup) {
      window.localStorage.removeItem(SETUP_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(SETUP_STORAGE_KEY, JSON.stringify(setup));
  }, [setup]);

  const value = useMemo(
    () => ({
      auth,
      setAuth,
      setup,
      setSetup
    }),
    [auth, setup]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppContext(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error("useAppContext must be used within AppProvider");
  }
  return ctx;
}
