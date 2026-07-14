import type { Config } from 'tailwindcss'

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Paleta neutra estilo Linear/Vercel; acento único.
        accent: {
          DEFAULT: '#6366f1',
          hover: '#4f46e5',
          soft: '#eef2ff',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'Segoe UI', 'sans-serif'],
      },
    },
  },
  plugins: [],
} satisfies Config
