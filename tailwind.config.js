/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        body: ['"Manrope"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['"Fraunces"', 'Georgia', 'serif'],
      },
      colors: {
        ink: '#18211D',
        moss: '#284638',
        pine: '#173126',
        clay: '#B98952',
        sand: '#EBE0D0',
        parchment: '#F8F4ED',
        fog: '#F1ECE4',
        line: '#D6CCBE',
      },
      boxShadow: {
        panel: '0 28px 80px rgba(24, 33, 29, 0.12)',
      },
      backgroundImage: {
        'soft-radial':
          'radial-gradient(circle at top left, rgba(185, 137, 82, 0.18), transparent 34%), radial-gradient(circle at top right, rgba(40, 70, 56, 0.12), transparent 32%), linear-gradient(180deg, rgba(255,255,255,0.75), rgba(255,255,255,0.75))',
      },
    },
  },
  plugins: [],
};
