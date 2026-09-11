import type { Config } from "tailwindcss";
export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#050506",
        surface: "#0B0B0E",
        surface2: "#121216",
        line: "#1C1C22",
        line2: "#2A2A32",
        txt: "#F2F2F4",
        dim: "#A2A2AD",
        faint: "#63636E",
        red: { DEFAULT: "#E5202E", bright: "#FF3B4A", deep: "#8E0F1A" },
        seller: "#FF3B4A",
        buyer: "#D4D4DC",
        oracle: "#F5B841",
      },
      fontFamily: {
        sans: ["Space Grotesk", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "Menlo", "monospace"],
      },
      boxShadow: {
        red: "0 0 0 1px rgba(229,32,46,.35), 0 30px 80px -30px rgba(229,32,46,.5)",
      },
    },
  },
  plugins: [],
} satisfies Config;
