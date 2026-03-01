FROM --platform=$BUILDPLATFORM node:22-slim AS builder

# Build application and add additional files
WORKDIR /ghostfolio

RUN apt-get update && apt-get install -y --no-install-suggests \
  g++ \
  git \
  make \
  openssl \
  python3 \
  && rm -rf /var/lib/apt/lists/*

# Only add basic files without the application itself to avoid rebuilding
# layers when files (package.json etc.) have not changed
COPY ./.config .config/
COPY ./CHANGELOG.md CHANGELOG.md
COPY ./LICENSE LICENSE
COPY ./package.json package.json
COPY ./package-lock.json package-lock.json
COPY ./prisma/schema.prisma prisma/

RUN npm install

COPY ./apps apps/
COPY ./libs libs/
COPY ./jest.config.ts jest.config.ts
COPY ./jest.preset.js jest.preset.js
COPY ./nx.json nx.json
COPY ./replace.build.mjs replace.build.mjs
COPY ./tsconfig.base.json tsconfig.base.json

ENV NX_DAEMON=false
RUN npm run build:production

# ─── Build the agent ──────────────────────────────────────────────────
# The agent lives under apps/agent as a git submodule.
# If it wasn't initialized in the build context, clone it.
RUN if [ ! -f apps/agent/package.json ]; then \
      echo "Agent submodule not initialized, cloning..."; \
      rm -rf apps/agent; \
      git clone --branch ghostfolio-main --depth 1 \
        https://github.com/RajatA98/ghostfolio-agent.git apps/agent; \
    fi

WORKDIR /ghostfolio/apps/agent
RUN npm ci --ignore-scripts && npx prisma generate 2>/dev/null || true
RUN npm run build
WORKDIR /ghostfolio

# ─── Prepare Ghostfolio dist with node_modules ───────────────────────
WORKDIR /ghostfolio/dist/apps/api
COPY ./package-lock.json /ghostfolio/dist/apps/api/
RUN npm install
COPY .config /ghostfolio/dist/apps/api/.config/
COPY prisma /ghostfolio/dist/apps/api/prisma/
COPY package.json /ghostfolio/dist/apps/api/
RUN npm run database:generate-typings

# ─── Final image ─────────────────────────────────────────────────────
FROM node:22-slim
LABEL org.opencontainers.image.source="https://github.com/ghostfolio/ghostfolio"
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-suggests \
  curl \
  openssl \
  && rm -rf /var/lib/apt/lists/*

# Ghostfolio API
COPY --chown=node:node --from=builder /ghostfolio/dist/apps /ghostfolio/apps/

# Agent (built dist + node_modules + prisma)
COPY --chown=node:node --from=builder /ghostfolio/apps/agent/dist /ghostfolio/agent/dist/
COPY --chown=node:node --from=builder /ghostfolio/apps/agent/node_modules /ghostfolio/agent/node_modules/
COPY --chown=node:node --from=builder /ghostfolio/apps/agent/package.json /ghostfolio/agent/package.json
COPY --chown=node:node --from=builder /ghostfolio/apps/agent/prisma /ghostfolio/agent/prisma/

# Entrypoint
COPY --chown=node:node ./docker/entrypoint.sh /ghostfolio/

WORKDIR /ghostfolio/apps/api
EXPOSE ${PORT:-3333}
USER node
CMD [ "/ghostfolio/entrypoint.sh" ]
