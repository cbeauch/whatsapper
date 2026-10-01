"use strict";

const path = require("path");
const QRCode = require("qrcode");
const { MessageMedia } = require("whatsapp-web.js");
const { client, getQr, isInitialized } = require("./whatsappClient");
const { registerHockeyBot } = require("./hockeyBot");

// web server configuration
const fastify = require("fastify")({ logger: true });
registerHockeyBot(fastify, client, isInitialized);

fastify.get("/health", async (_, reply) => {
  const ready = isInitialized();
  return reply.code(ready ? 200 : 503).send({ whatsappReady: ready });
});

// Close Chromium cleanly so its persisted WhatsApp session survives container stops.
fastify.addHook("onClose", async () => { await client.destroy(); });
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  try { await fastify.close(); }
  catch (error) { fastify.log.error({ err: error }, "Shutdown failed"); process.exitCode = 1; }
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

fastify.register(require("@fastify/view"), {
  engine: {
    ejs: require("ejs"),
  },
  root: path.join(__dirname, "templates"),
});

fastify.get("/", function handler(_, reply) {
  reply.view("root.ejs");
});

fastify.get("/qr", async function handler(_, reply) {
  const qr = getQr();
  reply.header("Cache-Control", "no-store");
  return reply.view("qr.ejs", {
    qrImage: qr ? await QRCode.toDataURL(qr, { width: 360 }) : null,
    ready: isInitialized(),
  });
});

fastify.get("/chats", async function handler(_, reply) {
  if (!isInitialized()) {
    return reply.send({ error: "Client not initialized" });
  }
  try {
    const resp = await client.getChats();
    const chats = resp.map((chat) => ({
      name: chat.name,
      id: chat.id._serialized,
    }));
    return reply.view("chats.ejs", { chats: chats });
  } catch (e) {
    fastify.log.error({ err: e }, "Failed to load chats");
    reply.statusCode = 500;
    reply.send({ error: { name: e.name, message: e.message } });
  }
});

fastify.post("/command", async function handler(request, reply) {
  if (!isInitialized()) {
    return reply.send({ error: "Client not initialized" });
  }
  try {
    const { command, params } = request.body;
    // Check if client[command] is a function to avoid arbitrary code execution or errors
    if (typeof client[command] !== "function") {
      reply.statusCode = 400;
      return reply.send({ error: "Invalid command" });
    }
    const resp = await client[command](...params);
    reply.send({ resp: resp });
  } catch (e) {
    reply.statusCode = 500;
    reply.send({ error: e });
  }
});

fastify.post("/command/:type", async function handler(request, reply) {
  if (!isInitialized()) {
    return reply.send({ error: "Client not initialized" });
  }
  try {
    const { type } = request.params;
    const { params } = request.body;

    switch (type) {
      case "media": {
        const remote_id = params[0];
        const media = new MessageMedia(params[1], params[2], params[3]);

        const resp = await client.sendMessage(remote_id, media);
        reply.send({ resp: resp });
        break;
      }
      default:
        reply.statusCode = 400;
        reply.send({ error: "Invalid type" });
    }
  } catch (e) {
    reply.statusCode = 500;
    reply.send({ error: e });
  }
});

fastify.listen({ port: Number(process.env.PORT || 3000), host: process.env.HOST || "0.0.0.0" }, (err) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
});
