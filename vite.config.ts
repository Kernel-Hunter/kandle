import { defineConfig, type Plugin } from 'vitest/config';
import { APP } from './src/config.ts';

// BASE_PATH lets the GitHub Pages workflow serve the app from /<repo>/.
const base = process.env.BASE_PATH ?? '/';

/** Fills %APP_NAME% in index.html from src/config.ts so the name lives in one place. */
function appName(): Plugin {
  return {
    name: 'app-name',
    transformIndexHtml: (html) => html.replaceAll('%APP_NAME%', APP.name),
  };
}

export default defineConfig({
  base,
  plugins: [appName()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 800,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
