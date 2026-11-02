// Settings come from the add-on's Configuration tab (Home Assistant writes
// them to /data/options.json). DATA_DIR is the add-on's private storage,
// which is included in Home Assistant backups.

import fs from "node:fs";
import path from "node:path";

export const DATA_DIR = process.env.DATA_DIR || "/data";
const OPTIONS_PATH = process.env.OPTIONS_PATH || path.join(DATA_DIR, "options.json");

const DEFAULTS = {
  telegram_bot_token: "",
  telegram_admin_ids: [],
  telegram_channel: "",
  anthropic_api_key: "",
  anthropic_model: "claude-sonnet-5-5",
  disclosure: "",
  whatsapp_enabled: true,
  whatsapp_delay_seconds: 5,
  facebook_page_id: "",
  facebook_page_token: "",
  aliexpress_app_key: "",
  aliexpress_app_secret: "",
  aliexpress_tracking_id: "",
};

export function loadConfig() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(OPTIONS_PATH, "utf8"));
  } catch (err) {
    console.warn(`[config] could not read ${OPTIONS_PATH}: ${err.message}`);
  }
  const cfg = { ...DEFAULTS, ...raw };
  for (const k of Object.keys(cfg)) if (typeof cfg[k] === "string") cfg[k] = cfg[k].trim();
  cfg.telegram_admin_ids = (Array.isArray(cfg.telegram_admin_ids) ? cfg.telegram_admin_ids : [])
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x) && x !== 0);
  // "@mychannel", "mychannel", "https://t.me/mychannel" or a numeric id all work.
  let ch = cfg.telegram_channel;
  if (ch) {
    ch = ch.replace(/^https?:\/\/t\.me\//i, "").replace(/\/$/, "");
    if (!/^-?\d+$/.test(ch) && !ch.startsWith("@")) ch = "@" + ch;
  }
  cfg.telegram_channel = ch;
  cfg.whatsapp_delay_seconds = Math.min(60, Math.max(1, Number(cfg.whatsapp_delay_seconds) || 5));
  cfg.hasAliExpressApi = !!(cfg.aliexpress_app_key && cfg.aliexpress_app_secret && cfg.aliexpress_tracking_id);
  cfg.hasFacebook = !!(cfg.facebook_page_id && cfg.facebook_page_token);
  return cfg;
}

/** Small JSON store for things changed from Telegram (e.g. chosen WhatsApp groups). */
export class State {
  constructor(file = path.join(DATA_DIR, "state.json")) {
    this.file = file;
    try {
      this.data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      this.data = {};
    }
  }
  get(key, fallback) {
    return key in this.data ? this.data[key] : fallback;
  }
  set(key, value) {
    this.data[key] = value;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.error(`[state] could not save: ${err.message}`);
    }
  }
}
