import path from "node:path";
import { loadConfig, State, DATA_DIR } from "./config.js";
import { Telegram } from "./telegram.js";
import { PostWriter } from "./ai.js";
import { AliExpressApi } from "./aliexpress.js";
import { WhatsApp } from "./whatsapp.js";
import { FacebookPage } from "./facebook.js";
import { Bot } from "./bot.js";

const log = {
  info: (...a) => console.log(new Date().toISOString(), ...a),
  warn: (...a) => console.warn(new Date().toISOString(), ...a),
  error: (...a) => console.error(new Date().toISOString(), ...a),
};

async function qrToPng(text) {
  const QRCode = (await import("qrcode")).default;
  return QRCode.toBuffer(text, { width: 600, margin: 2 });
}

async function main() {
  const cfg = loadConfig();
  if (!cfg.telegram_bot_token) {
    log.error("telegram_bot_token is empty. Fill it in the add-on Configuration tab and restart.");
    // Keep the container alive so the log stays readable instead of a restart loop.
    setInterval(() => {}, 1 << 30);
    return;
  }

  const telegram = new Telegram(cfg.telegram_bot_token, log);
  const me = await telegram.call("getMe").catch((e) => {
    log.error(`Telegram: ${e.message} (is the bot token right?)`);
    return null;
  });
  if (!me) {
    setInterval(() => {}, 1 << 30);
    return;
  }
  log.info(`Telegram bot @${me.username} is running.`);

  const state = new State();
  const writer = new PostWriter({ apiKey: cfg.anthropic_api_key, model: cfg.anthropic_model });
  const aliApi = cfg.hasAliExpressApi
    ? new AliExpressApi({ appKey: cfg.aliexpress_app_key, appSecret: cfg.aliexpress_app_secret, trackingId: cfg.aliexpress_tracking_id })
    : null;
  const facebook = cfg.hasFacebook ? new FacebookPage({ pageId: cfg.facebook_page_id, token: cfg.facebook_page_token }) : null;
  const whatsapp = cfg.whatsapp_enabled ? new WhatsApp({ authDir: path.join(DATA_DIR, "whatsapp-auth"), log }) : null;

  const bot = new Bot({ cfg, telegram, writer, aliApi, whatsapp, facebook, state, qrToPng, log });

  if (whatsapp) {
    whatsapp.start().catch((e) => log.error(`[whatsapp] ${e.message}`));
  }

  if (!cfg.telegram_admin_ids.length) {
    log.warn(`No telegram_admin_ids yet. Send any message to @${me.username} to get your Telegram ID.`);
  } else {
    bot.notifyAdmins("✅ הבוט פועל. שלח קישור מעליאקספרס עם תמונה, או /help.");
  }

  const shutdown = () => {
    telegram.stop();
    if (whatsapp) whatsapp.stop();
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await telegram.poll((u) => bot.handleUpdate(u));
}

main().catch((err) => {
  log.error(err.stack || err.message);
  process.exit(1);
});
