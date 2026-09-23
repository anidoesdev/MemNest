// Wraps the built page in a module, so @memnest/mcp bundles it as a string and ships no extra files.
import { readFileSync, writeFileSync } from 'node:fs';

const dist = new URL('../dist/', import.meta.url);
const html = readFileSync(new URL('index.html', dist), 'utf8');

writeFileSync(
  new URL('index.js', dist),
  `/** The memory graph MCP App: a self-contained HTML page. */\nexport const GRAPH_APP_HTML = ${JSON.stringify(html)};\n`,
);
writeFileSync(new URL('index.d.ts', dist), '/** The memory graph MCP App: a self-contained HTML page. */\nexport declare const GRAPH_APP_HTML: string;\n');
console.log(`GRAPH_APP_HTML: ${(html.length / 1024).toFixed(0)} KiB`);
