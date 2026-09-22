// The documentation's structure. The generator builds one page per entry, and the sidebar
// from the sections, so navigation and pages can never disagree.
export const SECTIONS = [
  {
    title: 'Start here',
    pages: [
      { slug: 'index', title: 'What Memnest is', nav: 'Overview', summary: 'Atomic facts, resolved against what is already known, with the history kept and a trace for every answer.' },
      { slug: 'quickstart', title: 'Quickstart', nav: 'Quickstart', summary: 'Watch a fact change, and the old version step aside, in two minutes.' },
      { slug: 'concepts', title: 'Concepts', nav: 'Concepts', summary: 'Containers, documents, memories, relations, provenance, traces and profiles.' },
    ],
  },
  {
    title: 'Use it in your chat',
    pages: [
      { slug: 'chat', title: 'Claude, Cursor and VS Code', nav: 'Chat clients', summary: 'Give your assistant a memory it keeps between conversations, through MCP.' },
      { slug: 'managing', title: 'Managing your memories', nav: 'Managing memories', summary: 'See what is remembered, correct it, forget it, and delete everything.' },
    ],
  },
  {
    title: 'Build with it',
    pages: [
      { slug: 'typescript', title: 'TypeScript', nav: 'TypeScript', summary: 'The embedded engine, or the same API over HTTP.' },
      { slug: 'agents', title: 'Add memory to an agent', nav: 'Agent integration', summary: 'The recall-then-remember loop, with any model and any framework.' },
      { slug: 'rest', title: 'REST API', nav: 'REST API', summary: 'Every operation over HTTP, from any language.' },
    ],
  },
  {
    title: 'Run it',
    pages: [
      { slug: 'models', title: 'Models and providers', nav: 'Models', summary: 'Ollama, OpenAI, or any OpenAI-compatible endpoint, for completions and embeddings.' },
      { slug: 'server', title: 'Server and dashboard', nav: 'Server & dashboard', summary: 'Run Memnest for several clients, with scoped keys and a dashboard to review memory.' },
      { slug: 'extraction', title: 'Ingestion and extraction', nav: 'Extraction', summary: 'How raw conversations become atomic facts, and what gets rejected.' },
      { slug: 'recall', title: 'Recall, traces and profiles', nav: 'Recall & profiles', summary: 'Hybrid search, the token budget, why a candidate was dropped, and prompt-ready profiles.' },
      { slug: 'security', title: 'Security and privacy', nav: 'Security', summary: 'Container isolation, scoped keys, redaction and erasure.' },
    ],
  },
  {
    title: 'Reference',
    pages: [
      { slug: 'cli', title: 'CLI reference', nav: 'CLI', summary: 'Every command and flag.' },
      { slug: 'troubleshooting', title: 'Troubleshooting', nav: 'Troubleshooting', summary: 'What to check when memories do not appear, search degrades, or a client cannot connect.' },
    ],
  },
];

/** Flat reading order, for prev/next links. */
export const PAGES = SECTIONS.flatMap((section) => section.pages.map((page) => ({ ...page, section: section.title })));

export const hrefOf = (slug) => (slug === 'index' ? '/docs/' : `/docs/${slug}`);
