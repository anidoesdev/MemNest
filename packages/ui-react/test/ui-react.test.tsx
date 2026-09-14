// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMemnest } from '@memnest/core';
import { createInMemoryStore } from '@memnest/core/testing';
import { createGraphController, createStore, type GraphTheme } from '@memnest/ui-core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GraphCanvas, useController, useWorkspace } from '../src/index';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
  // jsdom has no canvas: getContext returns null and the renderer must cope.
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
  // Nor pointer capture.
  HTMLElement.prototype.setPointerCapture ??= () => undefined;
});

afterEach(cleanup);

const theme = {} as GraphTheme;

describe('@memnest/ui-react', () => {
  it('stays a thin wrapper: at most ~150 lines of logic', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'index.tsx'), 'utf8');
    const logic = source
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/**') && !line.startsWith('import') && !/^[})\];,]*$/.test(line));
    expect(logic.length).toBeLessThanOrEqual(150);
  });

  it('re-renders when a controller changes, and only then', () => {
    const store = createStore({ count: 0 });
    let renders = 0;
    function Counter() {
      renders++;
      return <span>{useController(store).count}</span>;
    }
    render(<Counter />);
    expect(screen.getByText('0')).toBeTruthy();
    act(() => store.set({ count: 1 }));
    expect(screen.getByText('1')).toBeTruthy();
    expect(renders).toBe(2);
  });

  it('creates one live workspace under StrictMode and disposes it on unmount', async () => {
    const client = createMemnest({ store: createInMemoryStore() });
    const seen: Array<ReturnType<typeof useWorkspace>> = [];
    function Probe() {
      const workspace = useWorkspace({ client, containerTag: 'user:1', graph: { autoload: false } });
      seen.push(workspace);
      return <span>{workspace ? workspace.containerTag : 'loading'}</span>;
    }
    const { unmount } = render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
    await screen.findByText('user:1');
    const live = seen.at(-1)!;
    const dispose = vi.spyOn(live, 'dispose');
    // The live workspace still works after StrictMode's mount/unmount/mount.
    live.trace.setQuery('anything');
    await live.trace.run();
    expect(live.trace.getState().status).toBe('ready');
    unmount();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('renders a canvas that forwards clicks and drags to the controller', () => {
    const client = createMemnest({ store: createInMemoryStore() });
    const controller = createGraphController({ client, containerTag: 'user:1', autoload: false });
    const select = vi.spyOn(controller, 'select');
    const pan = vi.spyOn(controller, 'panBy');
    render(<GraphCanvas controller={controller} theme={theme} aria-label="Graph of user:1" />);
    const canvas = screen.getByRole('img', { name: 'Graph of user:1' });

    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
    expect(select).toHaveBeenCalledWith(null);

    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 60, clientY: 30, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 60, clientY: 30, pointerId: 1 });
    expect(pan).toHaveBeenCalledWith(50, 20);
    expect(select).toHaveBeenCalledTimes(1);
  });
});
