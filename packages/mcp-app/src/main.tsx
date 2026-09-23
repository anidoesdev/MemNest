import { createStore } from '@memnest/ui-core';
import { App } from '@modelcontextprotocol/ext-apps';
import { createRoot } from 'react-dom/client';
import { GraphApp, type HostState } from './GraphApp';
import './styles.css';

const app = new App({ name: 'Memnest graph', version: '0.1.0' }, {}, { autoResize: true });

// Handlers go on before connecting: the host may send the tool input right after the handshake.
const host = createStore<HostState>({ status: 'connecting', error: null, context: {}, input: {} });
app.ontoolinput = ({ arguments: args }) => host.set({ input: (args ?? {}) as HostState['input'] });
app.onhostcontextchanged = (patch) => host.set((s) => ({ context: { ...s.context, ...patch } }));

app
  .connect()
  .then(() => host.set({ status: 'ready', context: app.getHostContext() ?? {} }))
  .catch((error: unknown) => host.set({ status: 'error', error: error instanceof Error ? error.message : String(error) }));

createRoot(document.getElementById('root')!).render(<GraphApp app={app} host={host} />);
