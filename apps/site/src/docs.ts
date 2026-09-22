import { setupPage } from './common';

setupPage();

// The sidebar is a drawer on narrow screens.
const toggle = document.querySelector<HTMLButtonElement>('[data-sidebar-toggle]');
const nav = document.getElementById('docs-nav');
if (toggle && nav) {
  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  nav.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('a')) {
      nav.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
}

// A link beside every heading, so a section can be shared.
for (const heading of document.querySelectorAll<HTMLHeadingElement>('.doc h2[id]')) {
  const link = document.createElement('a');
  link.className = 'anchor';
  link.href = `#${heading.id}`;
  link.textContent = '#';
  link.setAttribute('aria-label', `Link to ${heading.textContent ?? 'this section'}`);
  heading.append(link);
}

// "On this page", built from the headings rather than maintained by hand.
const headings = [...document.querySelectorAll<HTMLHeadingElement>('.doc h2[id]')];
const main = document.querySelector('.docs-main');
if (headings.length > 1 && main) {
  const aside = document.createElement('nav');
  aside.className = 'on-this-page';
  aside.setAttribute('aria-label', 'On this page');
  const title = document.createElement('span');
  title.className = 'nav-title';
  title.textContent = 'On this page';
  const list = document.createElement('ul');
  const links = new Map<string, HTMLAnchorElement>();
  for (const heading of headings) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = `#${heading.id}`;
    link.textContent = (heading.textContent ?? '').replace(/#$/, '');
    item.append(link);
    list.append(item);
    links.set(heading.id, link);
  }
  aside.append(title, list);
  main.append(aside);

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        for (const link of links.values()) link.classList.remove('on');
        links.get(entry.target.id)?.classList.add('on');
      }
    },
    { rootMargin: '-10% 0px -75% 0px' },
  );
  for (const heading of headings) observer.observe(heading);
}
