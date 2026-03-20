/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        "true-charcoal": "#0B0D10",
        "elevated-glass": "#151A21",
        "muted-steel": "#273140",
        "electric-cyan": "#40E0FF",
        "pulse-amber": "#FFB800",
        "neon-lime": "#B6FF3B",
      },
      borderRadius: {
        bento: "1.5rem",
        bentoLg: "2rem",
      },
      boxShadow: {
        "cyan-glow": "0 0 20px rgba(64, 224, 255, 0.3)",
      },
      fontFamily: {
        sans: ["Inter Tight", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
    },
  },
  plugins: [],
};
