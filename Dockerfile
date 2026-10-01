FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium tini ca-certificates fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /workspace
COPY package*.json .
COPY patches ./patches
RUN npm ci --omit=dev
COPY app ./app
EXPOSE 3000

VOLUME /data

ENTRYPOINT ["tini", "--", "node", "app/server.js"]
