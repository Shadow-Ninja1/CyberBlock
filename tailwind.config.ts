import type { Config } from "tailwindcss";
export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#080B12",
        surface: "#0F1420",
        surface2: "#151C2B",
        line: "#1F2A3C",
        line2: "#2A3850",
        txt: "#E8EEF9",
        dim: "#93A2BC",
        faint: "#5C6B85",
        seller: "#F59E0B",
        buyer: "#38BDF8",
        oracle: "#A78BFA",
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
