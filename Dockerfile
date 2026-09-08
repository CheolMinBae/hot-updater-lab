FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# The official console is installed by the pinned hot-updater CLI dependency.
# Keep devDependencies because this image also runs the CLI and TS config.
COPY --chown=node:node package.json package-lock.json ./
RUN chown node:node /app
USER node
RUN npm ci --include=dev --no-audit --no-fund \
    && npm cache clean --force

COPY --chown=node:node src ./src
COPY --chown=node:node scripts/fixture-build.ts ./scripts/fixture-build.ts
COPY --chown=node:node fixtures ./fixtures
COPY --chown=node:node hot-updater.config.ts tsconfig.json ./

EXPOSE 3007 1422

# Override with ["npx", "hot-updater", "console"] for the console service.
CMD ["node", "--import", "tsx", "src/index.ts"]
