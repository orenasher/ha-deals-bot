ARG BUILD_FROM=node:22-bookworm-slim
FROM ${BUILD_FROM}

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src

CMD ["node", "src/index.js"]
