/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      keyframes: {
        'toast-slide-in': {
          from: { opacity: '0', transform: 'translateX(16px)' },
          to:   { opacity: '1', transform: 'translateX(0)' },
        },
        'slide-in': {
          from: { opacity: '0', transform: 'translateX(100%)' },
          to:   { opacity: '1', transform: 'translateX(0)' },
        },
      },
      animation: {
        'toast-slide-in': 'toast-slide-in 250ms cubic-bezier(0.4,0,0.2,1)',
        'slide-in': 'slide-in 250ms cubic-bezier(0.4,0,0.2,1)',
      },
      colors: {
        // Risk level colors
        risk: {
          unknown: '#6b7280',  // gray-500
          low: '#22c55e',      // green-500
          medium: '#eab308',   // yellow-500
          high: '#f97316',     // orange-500
          critical: '#ef4444', // red-500
        },
        // Entity type colors
        entity: {
          eoa: '#3b82f6',         // blue-500
          contract: '#8b5cf6',    // violet-500
          mixer: '#ef4444',       // red-500
          lending: '#06b6d4',     // cyan-500
          bridge: '#f59e0b',      // amber-500
          dex: '#10b981',         // emerald-500
          cex: '#6366f1',         // indigo-500
          application: '#ec4899', // pink-500
        },
      },
    },
  },
  plugins: [],
}
