import { setupPage } from './common';

setupPage();

const DEFAULT_CONTAINER = 'user:me';

/** The stdio server config every client needs, in that client's shape. */
function serverConfig(container: string) {
  return { command: 'npx', args: ['-y', '@memnest/cli', 'mcp', '--container', container] };
}

const encode = (value: object) => encodeURIComponent(JSON.stringify(value));

/** btoa only takes latin-1; container tags are ASCII, but encode defensively. */
function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function links(container: string) {
  const config = serverConfig(container);
  return {
    vscode: `vscode:mcp/install?${encode({ name: 'memnest', ...config })}`,
    vscodeInsiders: `vscode-insiders:mcp/install?${encode({ name: 'memnest', ...config })}`,
    cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=memnest&config=${encodeURIComponent(base64(JSON.stringify(config)))}`,
  };
}

function snippets(container: string) {
  const config = serverConfig(container);
  return {
    'claude-code': `claude mcp add memnest -- npx -y @memnest/cli mcp --container ${container}`,
    plugin: '/plugin marketplace add anidoesdev/MemNest\n/plugin install memnest@memnest',
    'claude-desktop': JSON.stringify({ mcpServers: { memnest: config } }, null, 2),
    cursor: JSON.stringify({ mcpServers: { memnest: config } }, null, 2),
    vscode: JSON.stringify({ servers: { memnest: { type: 'stdio', ...config } } }, null, 2),
    generic: JSON.stringify({ mcpServers: { memnest: config } }, null, 2),
  } as Record<string, string>;
}

const input = document.querySelector<HTMLInputElement>('#container-tag');

function apply(): void {
  const raw = input?.value.trim() || DEFAULT_CONTAINER;
  // A tag is `kind:id`; keep it simple rather than silently accepting something the CLI rejects.
  const container = /^[\w.-]+:[\w.-]+$/.test(raw) ? raw : DEFAULT_CONTAINER;
  input?.setAttribute('aria-invalid', String(container !== raw));

  const url = links(container);
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>('[data-link]')) {
    const key = anchor.dataset.link as keyof typeof url;
    if (url[key]) anchor.href = url[key];
  }
  const code = snippets(container);
  for (const block of document.querySelectorAll<HTMLElement>('[data-snippet]')) {
    const key = block.dataset.snippet!;
    if (code[key]) block.textContent = code[key];
  }
}

input?.addEventListener('input', apply);
apply();
