import type { MemnestClient, SessionInfo } from '@memnest/client';
import { assertValidContainerTag } from '@memnest/core';
import { useEffect, useState, type FormEvent } from 'react';
import { Brand, ThemeToggle } from './components';
import { Shell } from './Shell';

const RECENT_KEY = 'memnest.recentContainers';

function readRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

function rememberContainer(tag: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([tag, ...readRecent().filter((t) => t !== tag)].slice(0, 8)));
  } catch {
    // Private windows and blocked storage: the picker simply forgets.
  }
}

export function App({ client }: { client: MemnestClient }) {
  const [session, setSession] = useState<SessionInfo | null | 'checking'>('checking');

  useEffect(() => {
    let active = true;
    client.session().then(
      (info) => active && setSession(info),
      () => active && setSession(null),
    );
    return () => {
      active = false;
    };
  }, [client]);

  if (session === 'checking') return <div className="splash" aria-busy="true" />;
  if (!session) return <Login client={client} onSignedIn={setSession} />;
  return (
    <ContainerGate
      session={session}
      client={client}
      onSignOut={async () => {
        await client.logout().catch(() => undefined);
        setSession(null);
      }}
    />
  );
}

function Login({ client, onSignedIn }: { client: MemnestClient; onSignedIn: (session: SessionInfo) => void }) {
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await client.login(apiKey.trim()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="gate">
      <form className="gate-card" onSubmit={submit}>
        <div className="gate-head">
          <h1 className="gate-title">
            <Brand large />
          </h1>
          <ThemeToggle />
        </div>
        <p className="muted">See what your agents remember, trace why they recall it, and forget what is wrong.</p>
        <label className="field">
          <span>API key</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="mnk_…"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            required
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="button primary" type="submit" disabled={busy || !apiKey.trim()}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="hint">The key is exchanged for a session cookie and is not stored in this browser. Create one with <code>memnest keys create</code>.</p>
      </form>
    </main>
  );
}

function ContainerGate({ session, client, onSignOut }: { session: SessionInfo; client: MemnestClient; onSignOut: () => void }) {
  const [containerTag, setContainerTag] = useState<string | null>(session.containerTag);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const recent = readRecent();

  const choose = (tag: string) => {
    try {
      assertValidContainerTag(tag);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    rememberContainer(tag);
    setContainerTag(tag);
  };

  if (containerTag) {
    return (
      <Shell
        client={client}
        session={session}
        containerTag={containerTag}
        onSignOut={onSignOut}
        {...(session.containerTag ? {} : { onChangeContainer: () => setContainerTag(null) })}
      />
    );
  }

  return (
    <main className="gate">
      <form
        className="gate-card"
        onSubmit={(e) => {
          e.preventDefault();
          choose(draft.trim());
        }}
      >
        <div className="gate-head">
          <h1 className="gate-title">
            <Brand large />
          </h1>
          <ThemeToggle />
        </div>
        <p className="muted">
          Signed in as <strong>{session.name}</strong>. This key can open any container.
        </p>
        <label className="field">
          <span>Container</span>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="user:123" spellCheck={false} required />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="button primary" type="submit">
          Open
        </button>
        {recent.length > 0 && (
          <div className="recent">
            <span className="muted">Recent</span>
            {recent.map((tag) => (
              <button key={tag} type="button" className="chip" onClick={() => choose(tag)}>
                {tag}
              </button>
            ))}
          </div>
        )}
        <button type="button" className="button ghost" onClick={onSignOut}>
          Sign out
        </button>
      </form>
    </main>
  );
}
