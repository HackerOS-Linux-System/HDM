export default {
  content: ['./index.html', './src/**/*.{tsx,ts}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Oxanium"', 'monospace'],
        body: ['"DM Sans"', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      animation: {
        'fade-in': 'fadeIn 0.4s ease-out forwards',
        'slide-up': 'slideUp 0.5s cubic-bezier(0.16,1,0.3,1) forwards',
        'slide-down': 'slideDown 0.4s cubic-bezier(0.16,1,0.3,1) forwards',
        'scale-in': 'scaleIn 0.3s cubic-bezier(0.16,1,0.3,1) forwards',
        'pulse-glow': 'pulseGlow 2s ease-in-out infinite',
        shimmer: 'shimmer 2s linear infinite',
        'spin-slow': 'spin 3s linear infinite',
        shake: 'shake 0.4s cubic-bezier(0.36,0.07,0.19,0.97)',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(24px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        slideDown: {
          '0%': { transform: 'translateY(-16px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        scaleIn: {
          '0%': { transform: 'scale(0.92)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        pulseGlow: {
          '0%, 100%': { boxShadow: '0 0 20px rgba(59,130,246,0.3)' },
          '50%': { boxShadow: '0 0 40px rgba(59,130,246,0.6)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        shake: {
          '10%, 90%': { transform: 'translateX(-2px)' },
          '20%, 80%': { transform: 'translateX(4px)' },
          '30%, 50%, 70%': { transform: 'translateX(-6px)' },
          '40%, 60%': { transform: 'translateX(6px)' },
        },
      },
      backdropBlur: {
        xs: '2px',
      },
    },
  },
  plugins: [],
};
