const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const path = require("path");

const dataRoot = process.platform === "win32"
  ? path.join(__dirname, "..", "data")
  : "/data";

const client = new Client({
  puppeteer: {
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
    ],
  },
  authStrategy: new LocalAuth({
    dataPath: process.env.WWEBJS_AUTH_PATH || path.join(dataRoot, ".wwebjs_auth"),
  }),
  webVersionCache: {
    path: process.env.WWEBJS_CACHE_PATH || path.join(dataRoot, ".wwebjs_cache"),
  },
});

let receivedQr = null;
let clientInitialized = false;

// show qr code in console
client.on("qr", (qr) => {
  console.log("QR RECEIVED", qr);
  receivedQr = qr;
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  clientInitialized = true;
  receivedQr = null;
  console.log("Client is ready!");
});

client.on("disconnected", () => {
  clientInitialized = false;
  receivedQr = null;
});

client.initialize().catch((error) => {
  console.error("WhatsApp initialization failed:", error);
  process.exit(1);
});

module.exports = {
  client,
  getQr: () => receivedQr,
  isInitialized: () => clientInitialized,
};
