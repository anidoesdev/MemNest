import './styles.css';

const THEME_KEY = 'memnest-theme';

function currentTheme(): 'light' | 'dark' {
  const set = document.documentElement.getAttribute('data-theme');
  if (set === 'light' || set === 'dark') return set;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function setupThemeToggle(): void {
  const button = document.querySelector<HTMLButtonElement>('[data-theme-toggle]');
  if (!button) return;
  const label = () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    button.setAttribute('aria-label', `Switch to ${next} theme`);
    button.title = `Switch to ${next} theme`;
  };
  label();
  button.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* private mode: the choice lasts for this page only */
    }
    label();
  });
}

/** Adds a Copy button to every `.code` block. */
function setupCopyButtons(): void {
  for (const block of document.querySelectorAll<HTMLElement>('.code')) {
    const pre = block.querySelector('pre');
    if (!pre || block.querySelector('.copy')) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy';
    button.textContent = 'Copy';
    button.addEventListener('click', async () => {
      const text = (pre.textContent ?? '').replace(/^\$ /gm, '');
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = 'Copied';
      } catch {
        button.textContent = 'Select to copy';
      }
      button.dataset.done = '';
      setTimeout(() => {
        button.textContent = 'Copy';
        delete button.dataset.done;
      }, 1600);
    });
    block.append(button);
  }
}

/**
 * Tabs: `[role=tablist]` with `[role=tab][aria-controls]` buttons. Arrow keys move between
 * tabs; the panels are toggled with `hidden`.
 */
export function setupTabs(root: ParentNode = document): void {
  for (const list of root.querySelectorAll<HTMLElement>('[role="tablist"][data-tabs]')) {
    const tabs = [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const select = (index: number, focus = false) => {
      tabs.forEach((tab, i) => {
        const on = i === index;
        tab.setAttribute('aria-selected', String(on));
        tab.tabIndex = on ? 0 : -1;
        const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
        if (panel) panel.hidden = !on;
      });
      if (focus) tabs[index]?.focus();
    };
    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => select(i));
      tab.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
        event.preventDefault();
        select((i + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length, true);
      });
    });
    const initial = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
    select(initial >= 0 ? initial : 0);
  }
}

export function setupPage(): void {
  setupThemeToggle();
  setupCopyButtons();
  setupTabs();
}
