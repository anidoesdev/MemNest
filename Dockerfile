# The Memnest server and dashboard: `memnest migrate && memnest serve`, built from this workspace.
#   docker compose up -d
#   docker compose exec server memnest keys create --name admin
#   open http://localhost:8787

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json turbo.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@memnest/cli... --filter=@memnest/dashboard...
# Pack exactly what npm would publish, so the image runs the same artifacts users install.
RUN mkdir /tarballs && for dir in core providers store-sqlite store-postgres evals server client mcp cli; do \
      (cd "packages/$dir" && pnpm pack --pack-destination /tarballs); \
    done

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    MEMNEST_HOST=0.0.0.0 \
    MEMNEST_PORT=8787 \
    MEMNEST_DASHBOARD_DIR=/opt/memnest/dashboard
WORKDIR /opt/memnest
COPY --from=build /tarballs /tmp/tarballs
COPY --from=build /app/apps/dashboard/dist /opt/memnest/dashboard
# Internal dependencies must resolve to these tarballs, never the registry.
RUN node -e " \
      const fs = require('fs'); \
      const deps = {}; \
      for (const file of fs.readdirSync('/tmp/tarballs')) deps['@memnest/' + file.replace(/^memnest-/, '').replace(/-\d+\.\d+\.\d+\.tgz$/, '')] = 'file:/tmp/tarballs/' + file; \
      const overrides = Object.fromEntries(Object.keys(deps).map((name) => [name, '\$' + name])); \
      fs.writeFileSync('package.json', JSON.stringify({ name: 'memnest-server', private: true, dependencies: deps, overrides }, null, 2)); \
    " \
 && npm install --omit=dev --no-audit --no-fund \
 && rm -rf /tmp/tarballs ~/.npm \
 && ln -s /opt/memnest/node_modules/.bin/memnest /usr/local/bin/memnest
USER node
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD node -e "fetch('http://127.0.0.1:' + process.env.MEMNEST_PORT + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["sh", "-c", "memnest migrate && memnest serve"]
