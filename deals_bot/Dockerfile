# Fixed Debian-based Node image: Home Assistant's default base images are
# Alpine without Node/npm, and the WhatsApp library needs Node 20+.
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src

CMD ["node", "src/index.js"]
