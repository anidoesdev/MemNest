# Memnest site

The website: a landing page with a live preview of the engine, and the user guide. A static Vite build, deployed to Vercel.

- `index.html`: the landing page.
- `guide.html`: the user guide, served at `/guide`.
- `src/demo.ts`: the preview's engine and scenario.
- `src/preview.ts`: the preview's UI.

## The live preview runs the real engine

The preview bundles `@memnest/core` from source and runs it in the browser: `createMemnest` with the in-memory store, `hashEmbedder` for vectors, and `scriptedModel` in place of an LLM. Redaction, screening, resolution, versioning, hybrid recall, packing, profiles, forget and expiry are the production code paths. Only the model's answers are scripted. The whole engine adds about 28 KB gzipped.

`test/demo.test.ts` plays the story the page tells (a secret rejected, a change resolved as `updates`, a duplicate caught without a model call, `not-latest` in the trace, forget, expiry). If a change to core breaks that story, CI fails before the page can say something untrue.

## Develop

```sh
pnpm --filter @memnest/site dev        # http://localhost:5173
pnpm --filter @memnest/site test
pnpm --filter @memnest/site build      # static output in apps/site/dist
pnpm --filter @memnest/site preview    # serve the build
```

The Vite config aliases `@memnest/core` to `packages/core/src`, so the site never needs the other packages built.

## Deploy to Vercel

1. In Vercel, **Add New → Project** and import the GitHub repository.
2. Set **Root Directory** to `apps/site`, and keep **Include files outside the root directory** on (the default). The preview imports `packages/core/src`.
3. Deploy. `vercel.json` sets everything else:
   - install: `pnpm install --frozen-lockfile --filter @memnest/site...` (only the site and core, about 15 seconds)
   - build: `pnpm run build`, output in `dist`
   - clean URLs (`/guide`), a strict Content Security Policy, and long-lived caching for hashed assets

From the CLI instead: `cd apps/site && npx vercel` (first time: link the project and accept `apps/site` as the root), then `npx vercel --prod`.

Every push to `main` deploys to production and every pull request gets a preview URL, once the project is connected to GitHub.

### The CSP

`vercel.json` allows scripts and styles only from the site itself, plus Google Fonts. There are no inline scripts: the theme is applied before first paint by `public/theme.js`. Adding a third-party script or font host means updating the policy.
