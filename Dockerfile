# RetailEval Terminal — production image for Coolify
# Node 22 on Alpine: small, and BusyBox wget is built in, which Coolify's
# health checks rely on inside the container.
FROM node:22-alpine

ENV NODE_ENV=production
# 3000 and 5000 are taken on this Coolify host, so the app stays on 4242.
ENV PORT=4242

WORKDIR /app

# Install dependencies first so this layer is cached between code changes.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy only what the app needs — never the local .env (secrets stay in
# Coolify's Environment Variables, injected at runtime). tools/ is dev-only
# (local mocks) and deliberately left out of the image.
COPY --chown=node:node server.js ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node views ./views
COPY --chown=node:node public ./public

# Run as the unprivileged user that ships with the Node image.
USER node

EXPOSE 4242

# Coolify honors this and waits for the container to report healthy before
# routing traffic / finishing a rolling update. Checks the app over HTTP on
# localhost; any 200 from the terminal page means Express is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO /dev/null "http://127.0.0.1:${PORT}/" || exit 1

CMD ["node", "server.js"]
