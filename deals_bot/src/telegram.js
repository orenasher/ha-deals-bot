// Minimal Telegram Bot API client (no dependencies): long polling,
// text/photo messages with inline buttons, file download.

const API_BASE = process.env.TELEGRAM_API_BASE || "https://api.telegram.org";

export class Telegram {
  constructor(token, log = console) {
    this.token = token;
    this.log = log;
    this.offset = 0;
    this.stopped = false;
  }

  async call(method, params = {}) {
    const res = await fetch(`${API_BASE}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(method === "getUpdates" ? 70000 : 30000),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || res.status}`);
    return data.result;
  }

  /** sendPhoto with either an existing file_id/URL (string) or raw bytes (Buffer). */
  async sendPhoto(chatId, photo, caption, extra = {}) {
    if (typeof photo === "string") {
      return this.call("sendPhoto", { chat_id: chatId, photo, caption, ...extra });
    }
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (caption) form.append("caption", caption);
    for (const [k, v] of Object.entries(extra)) form.append(k, typeof v === "string" ? v : JSON.stringify(v));
    form.append("photo", new Blob([photo], { type: "image/jpeg" }), "photo.jpg");
    const res = await fetch(`${API_BASE}/bot${this.token}/sendPhoto`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60000),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error(`Telegram sendPhoto: ${data.description || res.status}`);
    return data.result;
  }

  sendMessage(chatId, text, extra = {}) {
    return this.call("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true, ...extra });
  }

  async downloadFile(fileId) {
    const file = await this.call("getFile", { file_id: fileId });
    const res = await fetch(`${API_BASE}/file/bot${this.token}/${file.file_path}`, {
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`Telegram file download failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Calls onUpdate for every update until stop(). Never throws. */
  async poll(onUpdate) {
    while (!this.stopped) {
      let updates = [];
      try {
        updates = await this.call("getUpdates", {
          offset: this.offset,
          timeout: 50,
          allowed_updates: ["message", "callback_query"],
        });
      } catch (err) {
        this.log.warn(`[telegram] polling: ${err.message}`);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      for (const u of updates) {
        this.offset = u.update_id + 1;
        try {
          await onUpdate(u);
        } catch (err) {
          this.log.error(`[telegram] handling update failed: ${err.stack || err.message}`);
        }
      }
    }
  }

  stop() {
    this.stopped = true;
  }
}
