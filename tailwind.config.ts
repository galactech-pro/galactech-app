import type { Config } from "tailwindcss";


const scale = (rgb: string, t: Record<string, string>) => ({
  50: `rgba(${rgb},.10)`, 100: `rgba(${rgb},.15)`, 200: `rgba(${rgb},.25)`,
  300: t.l, 400: t.l, 500: t.b, 600: t.b, 700: t.m, 800: t.m, 900: t.h,
});
const dark = {
  red: scale("255,68,68", { l: "#ff9b9b", b: "#ff4444", m: "#ff8a8a", h: "#ffb0b0" }),
  green: scale("0,193,106", { l: "#6ee7a8", b: "#00c16a", m: "#34d98a", h: "#8ef0bd" }),
  yellow: scale("245,158,11", { l: "#fcd34d", b: "#f59e0b", m: "#fbbf24", h: "#fde68a" }),
  amber: scale("245,158,11", { l: "#fcd34d", b: "#f59e0b", m: "#fbbf24", h: "#fde68a" }),
  blue: scale("59,130,246", { l: "#93c5fd", b: "#3b82f6", m: "#7db4fb", h: "#bfdbfe" }),
  violet: scale("139,92,246", { l: "#c4b5fd", b: "#8b5cf6", m: "#b6a3fb", h: "#ddd6fe" }),
};

const config: Config = {
  darkMode: ["class"],
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" },
        secondary: { DEFAULT: "hsl(var(--secondary))", foreground: "hsl(var(--secondary-foreground))" },
        destructive: { DEFAULT: "hsl(var(--destructive))", foreground: "hsl(var(--destructive-foreground))" },
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
        accent: { DEFAULT: "hsl(var(--accent))", foreground: "hsl(var(--accent-foreground))" },
        card: { DEFAULT: "hsl(var(--card))", foreground: "hsl(var(--card-foreground))" },
        cyan: "hsl(var(--cyan))",
        popover: { DEFAULT: "hsl(var(--popover))", foreground: "hsl(var(--popover-foreground))" },
        warning: "hsl(var(--warning))",
        ...dark,
        sidebar: {
          DEFAULT: "hsl(var(--sidebar))",
          foreground: "hsl(var(--sidebar-foreground))",
          muted: "hsl(var(--sidebar-muted))",
          border: "hsl(var(--sidebar-border))",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      borderRadius: { lg: "var(--radius)", md: "calc(var(--radius) - 2px)", sm: "calc(var(--radius) - 4px)" },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
export default config;
