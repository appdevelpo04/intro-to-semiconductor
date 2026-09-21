import { defineConfig } from 'astro/config';

// Static site; no SSR, no integrations needed for Phase 1.
// Deployed to GitHub Pages at: https://appdevelpo04.github.io/intro-to-semiconductor/
export default defineConfig({
  site: 'https://appdevelpo04.github.io/intro-to-semiconductor/',
  output: 'static',
  // Base path for GitHub Pages subdirectory deployment
  // This ensures assets are loaded from /intro-to-semiconductor/_astro/...
  base: '/intro-to-semiconductor/',
  vite: {
    build: {
      // Keep the client bundle readable for debugging the physics code.
      target: 'es2022',
    },
  },
});
