import type { Config } from 'tailwindcss'

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // ── Design System NexaView (mesmas regras do churn_mvp) ──
        // Acento único da marca: âmbar. Botões âmbar usam texto escuro
        // (text-zinc-950) — branco sobre âmbar não tem contraste.
        accent: {
          DEFAULT: '#ffb000',
          hover: '#e6a800',
          soft: '#fff3d1',
        },
        primary: '#ffb000',
        secondary: '#ff8f00',
        'on-surface': '#1a1a1a',
        'on-surface-variant': '#5d5d5d',
        // Neutros QUENTES sobrescrevendo a escala zinc: todo o app já usa
        // zinc-*, então trocar a escala aqui re-skina as páginas inteiras.
        // Light: creme (50) → near-black (950). Dark usa o topo da escala.
        zinc: {
          50: '#f4f1e8', // fundo do app (surface creme)
          100: '#ebe7db', // surface-container-low (hovers/fills)
          200: '#e0dcd0', // bordas quentes sutis
          300: '#d1ccbe',
          400: '#a8a8a0',
          500: '#5d5d5a', // texto mutado (workhorse)
          600: '#4b4b49',
          700: '#3a3a3a',
          800: '#282828', // dark: bordas/hover
          900: '#1c1a17', // dark: cards
          950: '#12100d', // dark: fundo (near-black quente)
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      borderRadius: {
        '4xl': '32px',
      },
      transitionTimingFunction: {
        // curva única de movimento do design system
        nexa: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
      backgroundImage: {
        'gradient-brand': 'linear-gradient(135deg, #ffb000 0%, #ff8f00 100%)',
      },
      boxShadow: {
        card: '0 1px 2px rgba(15,23,42,0.04)',
        'card-md': '0 8px 24px -4px rgba(15,23,42,0.08)',
        'card-lg': '0 12px 40px -12px rgba(15,23,42,0.15)',
        glow: '0 0 20px rgba(255,176,0,0.18)',
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-in-out',
        'slide-up': 'slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1) both',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(12px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
      },
    },
  },
  plugins: [],
} satisfies Config
