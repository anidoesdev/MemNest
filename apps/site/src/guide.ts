import { setupPage } from './common';

setupPage();

// Highlight the section being read in the table of contents.
const links = [...document.querySelectorAll<HTMLAnchorElement>('.toc a')];
const byId = new Map(links.map((a) => [a.hash.slice(1), a]));
const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      links.forEach((a) => a.classList.remove('on'));
      byId.get(entry.target.id)?.classList.add('on');
    }
  },
  { rootMargin: '-15% 0px -75% 0px' },
);
for (const id of byId.keys()) {
  const section = document.getElementById(id);
  if (section) observer.observe(section);
}
