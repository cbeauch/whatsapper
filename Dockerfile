FROM zenika/alpine-chrome:124-with-puppeteer

WORKDIR /workspace
USER root
COPY package*.json .
COPY patches ./patches
RUN npm ci --omit=dev
COPY app ./app
EXPOSE 3000

VOLUME /data

ENTRYPOINT ["tini", "--", "node", "app/server.js"]
