import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
    "../../packages/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        'bg-alt': 'var(--bg-alt)',
        surface: 'var(--surface)',
        'surface-strong': 'var(--surface-strong)',
        line: 'var(--line)',
        text: 'var(--text)',
        muted: 'var(--muted)',
        accent: 'var(--accent)',
        'accent-soft': 'var(--accent-soft)',
        warning: 'var(--warning)',
        'warning-soft': 'var(--warning-soft)',
        success: 'var(--success)',
        'success-soft': 'var(--success-soft)',
        'surface-sunken': 'var(--surface-sunken)',
        'line-subtle': 'var(--line-subtle)',
        'text-strong': 'var(--text-strong)',
        info: 'var(--info)',
        'info-soft': 'var(--info-soft)',
        danger: 'var(--danger)',
        'danger-soft': 'var(--danger-soft)',
        'danger-border': 'var(--danger-border)',
        'warning-bg': 'var(--warning-bg)',
        'accent-fg': 'var(--accent-fg)',
        'success-border': 'var(--success-border)',
        'danger-hover': 'var(--danger-hover)',
        pending: 'var(--pending)',
        'pending-soft': 'var(--pending-soft)',
        'pending-border': 'var(--pending-border)',
        'code-bg': 'var(--code-bg)',
        'code-fg': 'var(--code-fg)',
      },
      fontFamily: {
        playfair: ['var(--font-playfair)', 'serif'],
        inter: ['var(--font-inter)', 'sans-serif'],
        montserrat: ['var(--font-montserrat)', 'sans-serif'],
      }
    },
  },
  plugins: [],
};

export default config;
