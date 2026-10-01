# Build context is the repo root: docker build -f apps/api/Dockerfile -t gateway .
# One image serves the API and the dashboard build from the same origin.

# --- pnpm, from the packageManager pin in the root package.json ---
FROM node:22-alpine AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
COPY package.json ./
RUN corepack enable pnpm && corepack install

# --- dependencies: manifests only, so the install layer caches ---
FROM base AS deps
# .pnpmfile.cjs must sit next to the lockfile: the frozen install checks its checksum.
COPY pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
RUN pnpm install --frozen-lockfile

# --- build: web first, then the api (root `build` script order) ---
FROM deps AS build
COPY tsconfig.base.json ./
COPY apps ./apps
RUN pnpm build

# --- production dependencies for @gateway/api only ---
# pnpm 10 needs --legacy here because inject-workspace-packages is not set.
# The second command fails the build if dev tooling leaks in (see .pnpmfile.cjs).
FROM build AS prod-deps
RUN pnpm --filter @gateway/api deploy --prod --legacy /prod \
 && ! ls /prod/node_modules/.pnpm | grep -qE '^(vitest|vite|tsx|drizzle-kit|esbuild|typescript)@'

# --- runtime ---
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
# plugins/web-static.ts resolves ../../../web/dist from dist/plugins/, hence this layout.
COPY --from=build /app/apps/web/dist /app/apps/web/dist
WORKDIR /app/apps/api
COPY --from=prod-deps /prod/package.json ./package.json
COPY --from=prod-deps /prod/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/api/drizzle ./drizzle
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:4000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["sh","-c","node dist/db/migrate.js && exec node dist/server.js"]
