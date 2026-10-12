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

const PLUM: Theme = {
  name: "plum",
  roles: {
    accent: "#a67fd7",
    borderFocused: "#4a3670",
    borderDim: "#241a38",
    pending: "#160f24",
    danger: "#7a1f1f",
    error: "red",
    e1: "#ffd75f",
    e2: "#ff87ab",
    e3: "#a06fd0",
  },
};

const EMBER: Theme = {
  name: "ember",
  roles: {
    accent: "#d76a4f",
    borderFocused: "#6b3a22",
    borderDim: "#3a1f12",
    pending: "#2a1408",
    danger: "#7a1f1f",
    error: "red",
    e1: "#ffd75f",
    e2: "#ffab5f",
    e3: "#d76a6a",
  },
};

const SLATE: Theme = {
  name: "slate",
  roles: {
    accent: "#8fa3b8",
    borderFocused: "#3a4a5c",
    borderDim: "#1c2632",
    pending: "#10161d",
    danger: "#7a1f1f",
    error: "red",
    e1: "#cfe3ff",
    e2: "#8fb8d7",
    e3: "#5f6b8f",
  },
};

const CONTRAST: Theme = {
  name: "contrast",
  roles: {
    accent: "#ffffff",
    borderFocused: "#9a9a9a",
    borderDim: "#3a3a3a",
    pending: "#0a0a0a",
    danger: "#7a1f1f",
    error: "red",
    e1: "#ffff5f",
    e2: "#d7d7d7",
    e3: "#8a8a8a",
  },
};

const MONOKAI: Theme = {
  name: "monokai",
  roles: {
    accent: "#F92672",
    borderFocused: "#75715E",
    borderDim: "#3E3D32",
    pending: "#272822",
    danger: "#7a1f1f",
    error: "red",
    e1: "#E6DB74",
    e2: "#A6E22A",
    e3: "#FD971F",
  },
};

const DRACULA: Theme = {
  name: "dracula",
  roles: {
    accent: "#bd93f9",
    borderFocused: "#6272a4",
    borderDim: "#44475a",
    pending: "#282a36",
    danger: "#7a1f1f",
    error: "red",
    e1: "#f1fa8c",
    e2: "#50fa7b",
    e3: "#ff79c6",
  },
};

const NORD: Theme = {
  name: "nord",
  roles: {
    accent: "#88C0D0",
    borderFocused: "#4C566A",
    borderDim: "#3B4252",
    pending: "#2E3440",
    danger: "#7a1f1f",
    error: "red",
    e1: "#EBCB8B",
    e2: "#A3BE8C",
    e3: "#B48EAD",
  },
};

const GRUVBOX: Theme = {
  name: "gruvbox",
  roles: {
    accent: "#fe8019",
    borderFocused: "#665c54",
    borderDim: "#3c3836",
    pending: "#282828",
    danger: "#7a1f1f",
    error: "red",
    e1: "#ebdbb2",
    e2: "#fabd2f",
    e3: "#b8bb26",
  },
};

export const BUILT_IN_THEMES: Theme[] = [
  MOSS,
  AMBER,
  OCEAN,
  MONO,
  PLUM,
  EMBER,
  SLATE,
  CONTRAST,
  MONOKAI,
  DRACULA,
  NORD,
  GRUVBOX,
];
export const DEFAULT_THEME_NAME = "moss";

/** Active theme from local settings; unknown names fall back to moss. */
export function getTheme(): Theme {
  const name = getSetting("theme");
  return BUILT_IN_THEMES.find((t) => t.name === name) ?? MOSS;
}

export function themeNames(): string[] {
  return BUILT_IN_THEMES.map((t) => t.name);
}
