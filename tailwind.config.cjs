/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
        colors: {
          primary: '#1E293B',
          secondary: '#334155',
          accent: '#1E293B',
          light: '#CBD5E1',
          background: '#0F172A',
          bubbleUser: '#1C1F2A',
          bubbleBot: '#2A2E3A',
        },
        container: {
          padding: {
            DEFAULT: "1rem",
            sm: "2rem",
          },
        },
      }
  },
  plugins: [],
};
