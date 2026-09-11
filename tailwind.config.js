/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          900: '#07080b',
          800: '#0b0d12',
          700: '#11141c',
          600: '#171b25',
          500: '#1f2431',
          400: '#2b3141',
        },
        brand: {
          DEFAULT: '#7c5cff',
          soft: '#a08cff',
          deep: '#5b3ce6',
        },
        reel: {
          DEFAULT: '#22d3ee',
          soft: '#67e8f9',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'PingFang SC', 'Microsoft YaHei', 'sans-serif'],
        mono: ['JetBrains Mono', 'SFMono-Regular', 'Consolas', 'monospace'],
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(124,92,255,.35), 0 8px 40px -12px rgba(124,92,255,.45)',
        card: '0 1px 0 0 rgba(255,255,255,.04) inset, 0 12px 30px -18px rgba(0,0,0,.9)',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        'pulse-ring': {
          '0%': { boxShadow: '0 0 0 0 rgba(124,92,255,.45)' },
          '70%': { boxShadow: '0 0 0 12px rgba(124,92,255,0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(124,92,255,0)' },
        },
      },
      animation: {
        'fade-up': 'fade-up .28s ease-out both',
        shimmer: 'shimmer 1.6s infinite',
        'pulse-ring': 'pulse-ring 1.8s cubic-bezier(.4,0,.6,1) infinite',
      },
    },
  },
  plugins: [],
};
