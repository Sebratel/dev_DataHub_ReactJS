import type { Config } from 'tailwindcss'

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // ── Design System NexaView — revisão "plataforma de dados" ──────────
        // O acento da marca continua âmbar, mas a escala neutra passou de
        // QUENTE (creme) para FRIA. Quente sobre quente fazia o âmbar sumir e
        // a tela ler como planilha; contra um cinza azulado ele volta a ser
        // acento de verdade. Regra: âmbar = ação, marca e status "atenção".
        // Nunca âmbar como cor de série de gráfico nem para dado neutro.
        accent: {
          DEFAULT: '#ff8f00', // preenchimento, marcador ativo, marca
          hover: '#e07d00',
          soft: '#fff4e2',
          line: '#ffd79a',
          // Âmbar LEGÍVEL como texto (4,6:1 no claro). `text-accent` puro tem
          // ~2,4:1 e não serve para link — use `text-accent-ink` ou `text-info`.
          ink: '#b26a00',
        },
        primary: '#ff8f00',
        secondary: '#ffb000',
        'on-surface': '#0e1116',
        'on-surface-variant': '#525b69',

        // Chrome da sidebar — carvão fixo nos DOIS temas (padrão Datadog /
        // Atlas: o chrome não muda, só o conteúdo). Fora da escala zinc de
        // propósito, para nunca ser arrastado por um ajuste de tema.
        //
        // O tom é derivado do LARANJA DA MARCA (matiz ~34°) com saturação quase
        // zerada: fica um carvão sutilmente quente, não um grafite azulado. É o
        // que faz o âmbar do item ativo parecer da mesma família em vez de um
        // adesivo colado num chrome frio. Só o chrome é quente — o conteúdo
        // continua neutro-frio, que é o que mantém número e texto legíveis.
        rail: {
          DEFAULT: '#1a1714',
          raised: '#241f1a',
          active: '#312a22',
          ink: '#ece8e2',
          muted: '#a1998f',
          faint: '#6d655c',
        },

        // Neutros FRIOS sobrescrevendo a escala zinc: todo o app já usa
        // zinc-*, então trocar a escala aqui re-skina as páginas inteiras.
        // Claro: 50–300 superfícies e bordas, 400–700 tinta.
        // Escuro: 800–950 bordas, cards e fundo.
        zinc: {
          50: '#f4f5f7', // fundo do app
          100: '#eceef2', // hover / fill sutil
          200: '#e2e5eb', // borda padrão
          300: '#cfd5de', // borda forte, tracejado
          400: '#8d96a4', // microtexto, rótulo fraco
          500: '#6b7482', // texto mutado (workhorse)
          600: '#525b69',
          700: '#3a424e',
          800: '#262b33', // dark: borda / hover
          900: '#15181d', // dark: card
          950: '#0d0f13', // dark: fundo
        },

        // Estado — reservado. Nunca reaproveitar como cor de série.
        ok: { DEFAULT: '#0e9f6e', soft: '#e6f6ef', dark: '#2bb583' },
        warn: { DEFAULT: '#b26a00', soft: '#fff4e2', dark: '#e0942c' },
        crit: { DEFAULT: '#d92d20', soft: '#fdecea', dark: '#f0665d' },
        info: { DEFAULT: '#2f6fed', soft: '#eaf1fe', dark: '#5b8cf0' },

        // Camadas do lakehouse. Cor literal do metal — sempre acompanhada do
        // rótulo, porque cor sozinha não pode carregar a informação.
        tier: {
          bronze: '#b0703c',
          'bronze-dark': '#cd8a52',
          prata: '#7d8797',
          'prata-dark': '#98a3b3',
          ouro: '#c2901f',
          'ouro-dark': '#d9a83a',
        },

        // Séries de gráfico — validadas para daltonismo, banda de luminosidade
        // e contraste nas superfícies clara E escura. Ordem fixa, nunca
        // ciclada: a partir da 4ª, agrupe em "Outros" ou use small multiples.
        series: {
          1: '#3b6fe0',
          2: '#0e9f8f',
          3: '#8b5cf6',
          '1-dark': '#5b8cf0',
          '2-dark': '#0fa394',
          '3-dark': '#9575f5',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      // Raio reduzido em TODA a escala. Como as páginas já usam rounded-lg/xl/
      // 2xl, mexer aqui de-amacia o app inteiro sem tocar em componente algum.
      borderRadius: {
        DEFAULT: '4px',
        sm: '3px',
        md: '5px',
        lg: '6px',
        xl: '8px',
        '2xl': '10px',
        '3xl': '14px',
        '4xl': '20px',
      },
      transitionTimingFunction: {
        // curva única de movimento do design system
        nexa: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
      backgroundImage: {
        'gradient-brand': 'linear-gradient(145deg, #ffb000 0%, #ff8f00 100%)',
      },
      // Sombras discretas: numa UI densa a hierarquia vem da BORDA, não da
      // sombra. Só overlay (dropdown, modal, tooltip) tem sombra forte.
      boxShadow: {
        card: '0 1px 2px rgba(14,17,22,.05)',
        'card-md': '0 2px 6px -1px rgba(14,17,22,.07)',
        'card-lg': '0 6px 20px -6px rgba(14,17,22,.14), 0 1px 2px rgba(14,17,22,.05)',
        glow: '0 0 0 3px rgba(255,143,0,.14)',
      },
      animation: {
        'fade-in': 'fadeIn 0.2s ease-out',
        'slide-up': 'slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1) both',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(8px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
      },
    },
  },
  plugins: [],
} satisfies Config
