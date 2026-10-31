import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
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

/**
 * Gives every build an id, a hash of the files it is made of, so a deploy that changes nothing
 * keeps the same id. It goes into index.html (<meta name="kandle-build">) and into version.json,
 * which an open tab fetches to learn that a newer build is out (src/update.ts).
 */
function buildId(): Plugin {
  let outDir = 'dist';
  return {
    name: 'build-id',
    apply: 'build',
    configResolved(c) {
      outDir = c.build.outDir;
    },
    closeBundle() {
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const f of readdirSync(dir)) {
          const p = join(dir, f);
          if (statSync(p).isDirectory()) walk(p);
          else files.push(relative(outDir, p).split('\\').join('/'));
        }
      };
      walk(outDir);
      const hash = createHash('sha256');
      for (const f of files.filter((f) => f !== 'version.json').sort()) hash.update(f).update(readFileSync(join(outDir, f)));
      const build = hash.digest('hex').slice(0, 12);
      const index = join(outDir, 'index.html');
      writeFileSync(index, readFileSync(index, 'utf8').replace('</head>', `  <meta name="kandle-build" content="${build}" />\n  </head>`));
      writeFileSync(join(outDir, 'version.json'), JSON.stringify({ version: APP.version, build }) + '\n');
    },
  };
}

export default defineConfig({
  base,
  plugins: [appName(), buildId()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 800,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
