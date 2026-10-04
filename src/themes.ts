import { getSetting } from "./store.js";

export type ThemeRoles = {
  accent: string;
  borderFocused: string;
  borderDim: string;
  pending: string;
  danger: string;
  error: string;
  e1: string;
  e2: string;
  e3: string;
};

export type Theme = { name: string; roles: ThemeRoles };

const MOSS: Theme = {
  name: "moss",
  roles: {
    accent: "#9a9e3f",
    borderFocused: "#496b22",
    borderDim: "#0e450b",
    pending: "#1b2a09",
    danger: "#7a1f1f",
    error: "red",
    e1: "#ffd75f",
    e2: "#7fd787",
    e3: "#4f87d7",
  },
};

const AMBER: Theme = {
  name: "amber",
  roles: {
    accent: "#d7a441",
    borderFocused: "#6b4a1f",
    borderDim: "#3a2a12",
    pending: "#2a1f08",
    danger: "#7a1f1f",
    error: "red",
    e1: "#ffd75f",
    e2: "#ffaf5f",
    e3: "#ff87ab",
  },
};

const OCEAN: Theme = {
  name: "ocean",
  roles: {
    accent: "#5fa7d7",
    borderFocused: "#1f4a6b",
    borderDim: "#0e2a3a",
    pending: "#08182a",
    danger: "#7a1f1f",
    error: "red",
    e1: "#87d7ff",
    e2: "#5fb8d7",
    e3: "#5f6bd7",
  },
};

const MONO: Theme = {
  name: "mono",
  roles: {
    accent: "#d0d0d0",
    borderFocused: "#6b6b6b",
    borderDim: "#2a2a2a",
    pending: "#1a1a1a",
    danger: "#7a1f1f",
    error: "red",
    e1: "#ffffff",
    e2: "#b0b0b0",
    e3: "#707070",
  },
};

export const BUILT_IN_THEMES: Theme[] = [MOSS, AMBER, OCEAN, MONO];
export const DEFAULT_THEME_NAME = "moss";

/** Active theme from local settings; unknown names fall back to moss. */
export function getTheme(): Theme {
  const name = getSetting("theme");
  return BUILT_IN_THEMES.find((t) => t.name === name) ?? MOSS;
}

export function themeNames(): string[] {
  return BUILT_IN_THEMES.map((t) => t.name);
}
