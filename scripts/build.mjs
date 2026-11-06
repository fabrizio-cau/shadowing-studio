// Builds the extension into dist/: pages + service worker, then the content script.
// `--watch` rebuilds on change (reload the extension in chrome://extensions afterwards).
import { build } from 'vite';

const watch = process.argv.includes('--watch');
const mode = watch ? 'development' : 'production';

await build({ configFile: 'vite.config.ts', mode, build: { watch: watch ? {} : null } });
await build({ configFile: 'vite.content.config.ts', mode, build: { watch: watch ? {} : null } });
if (!watch) console.log('\nBuilt extension in dist/ — load it via chrome://extensions → Load unpacked.');
