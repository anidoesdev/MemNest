# Memnest site

The website: a landing page with a live memory graph, a documentation section, and the install page. A static Vite build, deployed to Vercel.

| Path | Source |
|---|---|
| `/` | `index.html` — hero, live preview, why, how to use it |
| `/plugins` | `plugins.html` — one-click install for each MCP client |
| `/docs/…` | generated from `src/docs/*.html` and `scripts/pages.mjs` |

## The live preview runs the real engine

`src/demo.ts` builds a real `@memnest/core` engine in the browser: the in-memory store, `hashEmbedder` for vectors, and `scriptedModel` in place of an LLM. Redaction, screening, resolution, versioning, hybrid recall, packing, profiles, forget and expiry are the production code paths; only the model's answers are scripted.

The graph is the dashboard's own renderer, `@memnest/ui-core`, driven by that engine — the same controller, force layout, hit-testing and canvas drawing, bound to a plain canvas in `src/graph.ts`. Labels for a handful of nodes are drawn as a DOM overlay, because ui-core only draws its own once a node is large enough on screen.

`test/demo.test.ts` plays the story the page tells (a secret rejected, a change resolved as `updates`, a duplicate caught without a model call, `not-latest` in the trace, forget, expiry), so a change to core that breaks it fails CI before the page can say something untrue.

## The documentation

Pages are content fragments in `src/docs/`, one per entry in `scripts/pages.mjs`. `scripts/build-docs.mjs` wraps each in the shared layout (header, sidebar, prev/next) and writes `docs/*.html`, which Vite takes as build inputs. The generated folder is gitignored.

**To add a page:** create `src/docs/<slug>.html` with the body (start at `<h2>`; the title, lede and eyebrow come from the entry), then add it to a section in `scripts/pages.mjs`. The sidebar, reading order and prev/next links follow. The build fails if an entry has no fragment.

Headings with an `id` automatically get an anchor link and appear in the "On this page" rail.

## Develop

```sh
pnpm --filter @memnest/site dev        # http://localhost:5173
pnpm --filter @memnest/site test
pnpm --filter @memnest/site build      # static output in apps/site/dist
pnpm --filter @memnest/site preview    # serve the build
```

The Vite config aliases `@memnest/core` and `@memnest/ui-core` to their sources, so the site never needs the other packages built.

## Deploy to Vercel

1. In Vercel, **Add New → Project** and import the GitHub repository.
2. Set **Root Directory** to `apps/site`, and keep **Include files outside the root directory** on (the default): the preview imports `packages/*/src`.
3. Deploy. `vercel.json` sets the rest:
   - install: `pnpm install --frozen-lockfile --filter @memnest/site...` (only the site and its two workspace dependencies)
   - build: `pnpm run build`, output in `dist`
   - clean URLs (`/docs/chat`), a strict Content Security Policy, and long-lived caching for hashed assets

From the CLI instead: `cd apps/site && npx vercel`, then `npx vercel --prod`.

Every push to `main` deploys to production, and every pull request gets a preview URL.

### The CSP

`vercel.json` allows scripts and styles only from the site itself, plus Google Fonts. There are no inline scripts: the theme is applied before first paint by `public/theme.js`. Adding a third-party script or font host means updating the policy.
