FROM node:22-bookworm-slim AS browser
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production \
    MCP_HTTP_HOST=0.0.0.0 \
    MCP_HTTP_PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npx playwright install --with-deps chromium --only-shell \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*

FROM browser AS build
ENV NODE_ENV=development
COPY tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY compat ./compat
COPY renderer ./renderer
COPY scripts ./scripts
RUN npm test

FROM browser AS runtime
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_HTTP_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/http.js"]
