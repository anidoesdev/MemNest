// Copied into the pack:local consumer. Drives the installed `memnest mcp` bin over stdio
// with raw JSON-RPC, the way an MCP client launches it, then closes stdin and expects exit 0.

import { spawn } from 'node:child_process';

const child = spawn(
  process.execPath,
  ['node_modules/@memnest/cli/dist/cli.js', 'mcp', '--container', 'user:smoke', '--db', 'mcp-smoke.db'],
  { stdio: ['pipe', 'pipe', 'inherit'] },
);

let buffered = '';
const replies = [];
child.stdout.on('data', (chunk) => {
  buffered += chunk;
  for (let i = buffered.indexOf('\n'); i >= 0; i = buffered.indexOf('\n')) {
    const line = buffered.slice(0, i).trim();
    buffered = buffered.slice(i + 1);
    // stdout is the protocol channel: anything that isn't JSON-RPC there is a bug.
    if (line) replies.push(JSON.parse(line));
  }
});

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
const reply = async (id) => {
  for (let tries = 0; tries < 400; tries++) {
    const found = replies.find((r) => r.id === id);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`MCP smoke: no reply to request ${id}`);
};

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0.0' } },
});
const init = await reply(1);
if (init.result?.serverInfo?.name !== 'memnest') throw new Error(`MCP smoke: initialize ${JSON.stringify(init)}`);
send({ jsonrpc: '2.0', method: 'notifications/initialized' });

send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
const tools = (await reply(2)).result?.tools?.map((t) => t.name).sort().join(',');
if (tools !== 'forget,graph_lineage,graph_snapshot,history,ingest,profile,recall,remember,show_graph') {
  throw new Error(`MCP smoke: tools ${tools}`);
}

send({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name: 'remember', arguments: { memories: [{ content: 'The smoke test user prefers tea.' }] } },
});
await reply(3);
send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'recall', arguments: { query: 'tea' } } });
const recalled = (await reply(4)).result?.content?.[0]?.text ?? '';
if (!recalled.includes('prefers tea')) throw new Error(`MCP smoke: recall ${recalled}`);

// The graph app's HTML is bundled from the private @memnest/mcp-app: the published package must carry it.
send({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'ui://memnest/graph' } });
const graphApp = (await reply(5)).result?.contents?.[0];
if (graphApp?.mimeType !== 'text/html;profile=mcp-app' || !/^<!doctype html>/i.test(graphApp.text ?? '')) {
  throw new Error(`MCP smoke: graph app ${JSON.stringify(graphApp)?.slice(0, 200)}`);
}

child.stdin.end();
const code = await new Promise((resolve) => child.on('exit', resolve));
if (code !== 0) throw new Error(`MCP smoke: exit ${code}`);
console.log('MCP smoke ok');
