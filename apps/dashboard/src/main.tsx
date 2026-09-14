import { createMemnestClient } from '@memnest/client';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyThemeChoice, readThemeChoice } from './themeChoice';
import './styles.css';

// Before the first render, so a remembered theme never flashes the other one.
applyThemeChoice(readThemeChoice());

// Same origin as the API: the server serves this app, and Vite proxies /v1 in development.
const client = createMemnestClient({ baseUrl: '' });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App client={client} />
  </StrictMode>,
);
