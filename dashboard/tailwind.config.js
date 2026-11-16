/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        paper: "var(--color-paper)",
        paper2: "var(--color-paper-2)",
        paper3: "var(--color-paper-3)",
        ink: "var(--color-ink)",
        ink2: "var(--color-ink-2)",
        muted: "var(--color-muted)",
        brand: "var(--color-blue)",
        sniprorange: "var(--color-red)",
        sniprblue: "var(--color-blue)",
        sniprgreen: "var(--color-green)",
        sniprred: "var(--color-red)",
        sniprwhite: "var(--color-white)",
        brandblue: "var(--color-blue)",
        brandgreen: "var(--color-green)",
        brandred: "var(--color-red)",
        brandwhite: "var(--color-white)",
        brass: "var(--color-blue)", // normal blue
        brassink: "var(--color-accent-ink)",
        coral: "var(--color-red)",
        ok: "var(--color-green)",
        warn: "var(--color-warn)",
        danger: "var(--color-red)",
        background: "var(--color-paper)",
        surface: "var(--color-paper-2)",
        primary: "var(--color-accent)",
        accent: "var(--color-accent)",
      },
      fontFamily: {
        display: "var(--font-display)",
        body: "var(--font-body)",
        sans: "var(--font-body)",
        serif: "var(--font-display)",
        mono: "var(--font-mono)",
      },
      borderColor: {
        rule: "var(--color-rule)",
        rule2: "var(--color-rule-2)",
      },
      borderRadius: {
        card: "var(--radius-card)",
        input: "var(--radius-input)",
      },
      fontSize: {
        micro: ["11px", { letterSpacing: "0.06em" }],
      },
      transitionTimingFunction: {
        out: "var(--ease-out)",
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade': 'fadeIn 0.25s var(--ease-out)',
        'scale-in': 'scaleIn 0.2s var(--ease-out)',
        'slide-in-left': 'slideInLeft 0.22s var(--ease-out)',
        'sheet-up': 'sheetUp 0.24s var(--ease-out)',
      },
      keyframes: {
        fadeIn: {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        scaleIn: {
          from: { opacity: '0', transform: 'scale(0.97)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        slideInLeft: {
          from: { transform: 'translateX(-100%)' },
          to: { transform: 'translateX(0)' },
        },
        sheetUp: {
          from: { transform: 'translateY(12px)', opacity: '0' },
          to: { transform: 'translateY(0)', opacity: '1' },
        },
      },
    },
  },
  plugins: [],
}
