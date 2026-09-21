import { defineConfig } from 'astro/config';

// Static site; no SSR, no integrations needed for Phase 1.
export default defineConfig({
  site: 'https://example.com',
  output: 'static',
  vite: {
    build: {
      // Keep the client bundle readable for debugging the physics code.
      target: 'es2022',
    },
  },
});
