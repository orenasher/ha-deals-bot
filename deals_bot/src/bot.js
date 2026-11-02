// The conversation with Oren in a private Telegram chat:
// he sends an AliExpress link (and a photo or screenshot), the bot writes a
// Hebrew post, shows a preview with buttons, and publishes on approval.

import crypto from "node:crypto";
import { findAliExpressLinks, resolveProduct, scrapeProduct, downloadImage } from "./aliexpress.js";
import { LINK_PLACEHOLDER } from "./ai.js";

const CAPTION_LIMIT = 1024;
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = 15 * 60 * 1000;
const MAX_QR_SENDS = 6;

const HELP = `שלום! ככה עובדים איתי:

1. שלח לי קישור שותפים של עליאקספרס (מ-Portals, מתחיל ב-s.click.aliexpress.com).
2. צרף תמונה של המוצר או צילום מסך של דף המוצר. אפשר באותה הודעה (תמונה עם הקישור בכיתוב) או בהודעות נפרדות.
3. אפשר להוסיף כמה מילים משלך, למשל "עובד עם Matter, מחיר 45 ש״ח".

אני אכתוב פוסט ואשלח לך תצוגה מקדימה עם כפתורים לפרסום.
לתיקון ידני: ענה (Reply) על התצוגה המקדימה עם הטקסט המתוקן.

פקודות:
/status – מצב החיבורים
/whatsapp – חיבור וואטסאפ (סריקת QR)
/whatsapp 9725XXXXXXXX – חיבור וואטסאפ עם קוד במקום QR
/groups – בחירת קבוצות הוואטסאפ לפרסום
/logout_whatsapp – ניתוק וואטסאפ`;

export class Bot {
  constructor({ cfg, telegram, writer, aliApi, whatsapp, facebook, state, qrToPng, log = console }) {
    this.cfg = cfg;
    this.tg = telegram;
    this.writer = writer;
    this.ali = aliApi;
    this.wa = whatsapp;
    this.fb = facebook;
    this.state = state;
    this.qrToPng = qrToPng;
    this.log = log;
    this.drafts = new Map();
    this.pending = new Map(); // chatId -> { photo, link, notes, at }
    this.groupCache = [];
    this.linkChat = null;
    this.qrSends = 0;
    this.lastQrMsg = null;

    if (this.wa) {
      this.wa.on("qr", (qr) => this.onQr(qr).catch((e) => this.log.error(`[bot] qr: ${e.message}`)));
      this.wa.on("pairing_code", (code) => this.notifyLink(`קוד החיבור לוואטסאפ: ${formatCode(code)}\n\nבטלפון של המספר הנפרד: וואטסאפ ← הגדרות ← מכשירים מקושרים ← קישור מכשיר ← "קישור עם מספר טלפון במקום", והקלד את הקוד.`));
      this.wa.on("open", (me) => {
        const msg = `✅ וואטסאפ מחובר${me && me.id ? ` (${me.id.split(":")[0].split("@")[0]})` : ""}.\nעכשיו שלח /groups כדי לבחור לאילו קבוצות לפרסם.`;
        if (this.linkChat) this.notifyLink(msg);
        this.linkChat = null;
        this.deleteLastQr();
      });
      this.wa.on("logged_out", () => this.notifyAdmins("⚠️ וואטסאפ נותק מהטלפון. שלח /whatsapp כדי לחבר מחדש."));
      this.wa.on("error", (e) => this.linkChat && this.notifyLink(`❌ ${e.message}`));
    }
  }

  isAdmin(userId) {
    return this.cfg.telegram_admin_ids.includes(Number(userId));
  }

  async notifyAdmins(text) {
    for (const id of this.cfg.telegram_admin_ids) {
      await this.tg.sendMessage(id, text).catch((e) => this.log.warn(`[bot] notify ${id}: ${e.message}`));
    }
  }

  notifyLink(text) {
    const chat = this.linkChat || this.cfg.telegram_admin_ids[0];
    if (chat) return this.tg.sendMessage(chat, text).catch(() => {});
  }

  // ---------- updates ----------

  async handleUpdate(u) {
    if (u.callback_query) return this.onCallback(u.callback_query);
    const m = u.message;
    if (!m || !m.chat || m.chat.type !== "private" || !m.from) return;

    if (!this.cfg.telegram_admin_ids.length) {
      return this.tg.sendMessage(
        m.chat.id,
        `ה-ID שלך בטלגרם: ${m.from.id}\n\nהכנס אותו בהגדרות התוסף ב-Home Assistant, בשדה telegram_admin_ids, ואז הפעל מחדש את התוסף.`
      );
    }
    if (!this.isAdmin(m.from.id)) {
      return this.tg.sendMessage(m.chat.id, "זה בוט פרטי.");
    }

    const text = (m.text || m.caption || "").trim();
    if (text.startsWith("/")) return this.onCommand(m, text);

    // A reply to a preview with text and no link = the corrected post.
    const replyTo = m.reply_to_message && this.findDraftByMessage(m.chat.id, m.reply_to_message.message_id);
    if (replyTo && text && !findAliExpressLinks(text).length && !m.photo) {
      return this.applyManualEdit(m.chat.id, replyTo, text);
    }

    return this.onContent(m, text);
  }

  async onCommand(m, text) {
    const [cmd, ...args] = text.split(/\s+/);
    const name = cmd.replace(/@.*$/, "").toLowerCase();
    const chat = m.chat.id;
    switch (name) {
      case "/start":
      case "/help":
        return this.tg.sendMessage(chat, HELP);
      case "/status":
        return this.tg.sendMessage(chat, await this.statusText());
      case "/whatsapp":
        return this.startWhatsAppLink(chat, args.join(""));
      case "/groups":
        return this.showGroups(chat);
      case "/logout_whatsapp":
        if (!this.wa) return this.tg.sendMessage(chat, "וואטסאפ כבוי בהגדרות התוסף.");
        await this.wa.logout();
        return this.tg.sendMessage(chat, "וואטסאפ נותק. אפשר לחבר מחדש עם /whatsapp.");
      default:
        return this.tg.sendMessage(chat, "פקודה לא מוכרת. שלח /help.");
    }
  }

  // ---------- building a draft ----------

  async onContent(m, text) {
    const chat = m.chat.id;
    const links = findAliExpressLinks(text);
    const notes = links.reduce((t, l) => t.split(l).join(" "), text).replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
    let photoId = null;
    if (m.photo && m.photo.length) photoId = m.photo[m.photo.length - 1].file_id;
    else if (m.document && /^image\//.test(m.document.mime_type || "")) photoId = m.document.file_id;

    // Merge with a photo or link sent a moment ago.
    const prev = this.pending.get(chat);
    const fresh = prev && Date.now() - prev.at < PENDING_TTL_MS ? prev : null;
    const link = links[0] || (fresh && fresh.link) || null;
    const photo = photoId || (fresh && fresh.photo) || null;
    const allNotes = [fresh && fresh.notes, notes].filter(Boolean).join("\n");

    if (!link) {
      if (photo) {
        this.pending.set(chat, { photo, link: null, notes: allNotes, at: Date.now() });
        return this.tg.sendMessage(chat, "קיבלתי את התמונה. עכשיו שלח את קישור השותפים למוצר.");
      }
      return this.tg.sendMessage(chat, "לא מצאתי קישור של עליאקספרס בהודעה. שלח /help להסבר.");
    }
    this.pending.delete(chat);
    await this.tg.call("sendChatAction", { chat_id: chat, action: "typing" }).catch(() => {});

    const warnings = [];
    let affiliateLink = link;
    let product = null;
    let productId = null;
    try {
      ({ productId } = await resolveProduct(link));
    } catch {
      productId = null;
    }

    if (this.ali && productId) {
      try {
        product = await this.ali.productDetails(productId);
        if (!isAffiliateLink(link)) {
          const generated = await this.ali.affiliateLink(product?.detailUrl || `https://www.aliexpress.com/item/${productId}.html`);
          if (generated) affiliateLink = generated;
        }
      } catch (err) {
        warnings.push(`לא הצלחתי לקרוא את המוצר מה-API של עליאקספרס: ${err.message}`);
      }
    }
    if (!product && productId) {
      const scraped = await scrapeProduct(productId);
      if (scraped) product = { title: scraped.title, image: scraped.image };
    }
    if (!isAffiliateLink(affiliateLink)) {
      warnings.push("הקישור לא נראה כמו קישור שותפים (s.click.aliexpress.com), אז ייתכן שלא תקבל עליו עמלה. כדאי ליצור אותו ב-Portals ← Link Generator.");
    }

    let image = null;
    if (photo) {
      image = await this.tg.downloadFile(photo);
    } else if (product && product.image) {
      try {
        image = await downloadImage(product.image);
      } catch {
        image = null;
      }
    }
    if (!image) {
      this.pending.set(chat, { photo: null, link: affiliateLink, notes: allNotes, at: Date.now() });
      return this.tg.sendMessage(chat, "קיבלתי את הקישור. לא הצלחתי להביא תמונה של המוצר לבד, אז שלח לי תמונה של המוצר או צילום מסך של דף המוצר.");
    }

    const draft = {
      id: crypto.randomBytes(4).toString("hex"),
      chat,
      link: affiliateLink,
      productId,
      product,
      notes: allNotes,
      image,
      createdAt: Date.now(),
      warnings,
      published: false,
    };
    await this.writeAndPreview(draft);
  }

  async writeAndPreview(draft, { instruction } = {}) {
    let result;
    try {
      result = await this.writer.write({
        image: draft.image,
        product: draft.product ? { ...draft.product, image: undefined, images: undefined, promotionLink: undefined } : null,
        notes: draft.notes,
        previousPost: instruction ? draft.post : undefined,
        instruction,
      });
    } catch (err) {
      return this.tg.sendMessage(draft.chat, `❌ לא הצלחתי לכתוב את הפוסט: ${err.message}`);
    }
    draft.post = result.post;
    draft.productName = result.productName;
    draft.aiWarnings = result.warnings;
    this.saveDraft(draft);
    return this.sendPreview(draft);
  }

  async sendPreview(draft) {
    const text = this.finalText(draft);
    const markup = { inline_keyboard: this.buttons(draft) };
    let msg;
    if (text.length <= CAPTION_LIMIT) {
      msg = await this.tg.sendPhoto(draft.chat, draft.photoFileId || draft.image, text, { reply_markup: markup });
    } else {
      await this.tg.sendPhoto(draft.chat, draft.photoFileId || draft.image, "");
      msg = await this.tg.sendMessage(draft.chat, text, { reply_markup: markup });
    }
    if (msg.photo && msg.photo.length) draft.photoFileId = msg.photo[msg.photo.length - 1].file_id;
    draft.previewMessageIds = [...(draft.previewMessageIds || []), msg.message_id];
    const notes = [...(draft.warnings || []), ...(draft.aiWarnings || [])];
    const lines = ["👆 תצוגה מקדימה. לתיקון ידני: ענה (Reply) על ההודעה עם הטקסט המתוקן."];
    if (notes.length) lines.push("", "⚠️ לבדוק לפני פרסום:", ...notes.map((n) => `• ${n}`));
    await this.tg.sendMessage(draft.chat, lines.join("\n"));
  }

  buttons(draft) {
    const id = draft.id;
    const only = [];
    if (this.cfg.telegram_channel) only.push({ text: "רק טלגרם", callback_data: `pub:${id}:tg` });
    if (this.wa) only.push({ text: "רק וואטסאפ", callback_data: `pub:${id}:wa` });
    if (this.fb) only.push({ text: "רק פייסבוק", callback_data: `pub:${id}:fb` });
    const rows = [[{ text: "📢 פרסם בכל מקום", callback_data: `pub:${id}:all` }]];
    if (only.length > 1) rows.push(only);
    rows.push([
      { text: "🔄 גרסה אחרת", callback_data: `re:${id}` },
      { text: "✂️ קצר יותר", callback_data: `sh:${id}` },
    ]);
    rows.push([{ text: "❌ בטל", callback_data: `x:${id}` }]);
    return rows;
  }

  finalText(draft) {
    const body = draft.post.split(LINK_PLACEHOLDER).join(draft.link);
    return this.cfg.disclosure ? `${body}\n\n${this.cfg.disclosure}` : body;
  }

  saveDraft(draft) {
    const now = Date.now();
    for (const [k, d] of this.drafts) if (now - d.createdAt > DRAFT_TTL_MS) this.drafts.delete(k);
    this.drafts.set(draft.id, draft);
  }

  findDraftByMessage(chat, messageId) {
    for (const d of this.drafts.values()) {
      if (d.chat === chat && (d.previewMessageIds || []).includes(messageId)) return d;
    }
    return null;
  }

  async applyManualEdit(chat, draft, text) {
    if (draft.published) return this.tg.sendMessage(chat, "הפוסט הזה כבר פורסם.");
    // Keep the affiliate link: if the edited text lost it, put the link line back.
    let post = text;
    if (this.cfg.disclosure) post = post.split(this.cfg.disclosure).join("").trim();
    if (post.includes(draft.link)) post = post.split(draft.link).join(LINK_PLACEHOLDER);
    if (!post.includes(LINK_PLACEHOLDER)) post += `\n\n👉 לרכישה: ${LINK_PLACEHOLDER}`;
    draft.post = post;
    draft.aiWarnings = [];
    draft.warnings = [];
    await this.sendPreview(draft);
  }

  // ---------- buttons ----------

  async onCallback(q) {
    const answer = (text) => this.tg.call("answerCallbackQuery", { callback_query_id: q.id, text }).catch(() => {});
    if (!q.from || !this.isAdmin(q.from.id)) return answer("זה בוט פרטי.");
    const [kind, id, arg] = String(q.data || "").split(":");

    if (kind === "wg") return this.toggleGroup(q, id).then(() => answer());

    const draft = this.drafts.get(id);
    if (!draft) return answer("הטיוטה הזו כבר לא זמינה. שלח את המוצר מחדש.");
    if (draft.published && kind !== "x") return answer("כבר פורסם.");

    if (kind === "x") {
      this.drafts.delete(id);
      await this.removeButtons(q.message);
      await answer("בוטל");
      return this.tg.sendMessage(draft.chat, "בוטל.");
    }
    if (kind === "re" || kind === "sh") {
      await answer("כותב גרסה חדשה...");
      await this.removeButtons(q.message);
      return this.writeAndPreview(draft, { instruction: kind === "sh" ? "קצר יותר, עד 400 תווים." : "גרסה אחרת, עם פתיחה שונה." });
    }
    if (kind === "pub") {
      if (draft.publishing) return answer("כבר מפרסם...");
      draft.publishing = true;
      await answer("מפרסם...");
      await this.removeButtons(q.message);
      try {
        await this.publish(draft, arg || "all");
      } finally {
        draft.publishing = false;
      }
    }
  }

  async removeButtons(message) {
    if (!message) return;
    await this.tg
      .call("editMessageReplyMarkup", { chat_id: message.chat.id, message_id: message.message_id, reply_markup: { inline_keyboard: [] } })
      .catch(() => {});
  }

  // ---------- publishing ----------

  async publish(draft, where) {
    const text = this.finalText(draft);
    const results = [];
    let anyOk = false;
    const want = (k) => where === "all" || where === k;

    if (want("tg")) {
      if (!this.cfg.telegram_channel) {
        if (where === "tg") results.push("✈️ טלגרם: לא הוגדר ערוץ (telegram_channel).");
      } else {
        try {
          if (text.length <= CAPTION_LIMIT) {
            await this.tg.sendPhoto(this.cfg.telegram_channel, draft.photoFileId || draft.image, text);
          } else {
            await this.tg.sendPhoto(this.cfg.telegram_channel, draft.photoFileId || draft.image, "");
            await this.tg.sendMessage(this.cfg.telegram_channel, text);
          }
          results.push("✅ טלגרם: פורסם בערוץ");
          anyOk = true;
        } catch (err) {
          results.push(`❌ טלגרם: ${err.message}`);
        }
      }
    }

    if (want("wa") && this.wa) {
      const groups = this.state.get("whatsapp_groups", []);
      if (this.wa.status !== "open") {
        results.push("❌ וואטסאפ: לא מחובר. שלח /whatsapp.");
      } else if (!groups.length) {
        results.push("❌ וואטסאפ: לא נבחרו קבוצות. שלח /groups.");
      } else {
        let ok = 0;
        const failed = [];
        for (let i = 0; i < groups.length; i++) {
          if (i > 0) await sleep(this.cfg.whatsapp_delay_seconds * 1000 * (0.8 + Math.random() * 0.4));
          try {
            await this.wa.sendImage(groups[i].id, draft.image, text);
            ok++;
          } catch (err) {
            failed.push(`${groups[i].subject} (${err.message})`);
          }
        }
        results.push(`${ok ? "✅" : "❌"} וואטסאפ: ${ok}/${groups.length} קבוצות${failed.length ? `\n   נכשל: ${failed.join(", ")}` : ""}`);
        if (ok) anyOk = true;
      }
    }

    if (want("fb") && this.fb) {
      try {
        const url = await this.fb.postPhoto(draft.image, text);
        results.push(`✅ פייסבוק: פורסם בדף${url ? `\n   ${url}` : ""}`);
        anyOk = true;
      } catch (err) {
        results.push(`❌ פייסבוק: ${err.message}`);
      }
    }

    if (anyOk) draft.published = true;
    else {
      // Nothing went out: put the buttons back so it can be tried again.
      const msg = await this.tg.sendMessage(draft.chat, "לא פורסם בשום מקום. אפשר לנסות שוב:", { reply_markup: { inline_keyboard: this.buttons(draft) } });
      draft.previewMessageIds.push(msg.message_id);
    }

    const summary = [...results];
    if (anyOk && this.fb && want("fb")) summary.push("", "לקבוצות הפייסבוק: פתח את הפוסט בדף ← שתף ← שתף בקבוצה.");
    await this.tg.sendMessage(draft.chat, summary.join("\n") || "לא נבחר יעד לפרסום.");
    if (anyOk) await this.tg.sendMessage(draft.chat, text); // easy to long-press and copy anywhere else
  }

  // ---------- WhatsApp setup ----------

  async startWhatsAppLink(chat, phone) {
    if (!this.wa) return this.tg.sendMessage(chat, "וואטסאפ כבוי בהגדרות התוסף (whatsapp_enabled).");
    if (this.wa.status === "open") {
      return this.tg.sendMessage(chat, `וואטסאפ כבר מחובר. לבחירת קבוצות: /groups\nלניתוק: /logout_whatsapp`);
    }
    this.linkChat = chat;
    this.qrSends = 0;
    await this.tg.sendMessage(
      chat,
      phone
        ? "מבקש קוד חיבור מוואטסאפ..."
        : "שולח קוד QR. בטלפון של המספר הנפרד: וואטסאפ ← הגדרות ← מכשירים מקושרים ← קישור מכשיר, וסרוק את הקוד שיגיע עכשיו.\n\n(הקוד מתחלף כל כמה שניות, אני אשלח את החדש.)"
    );
    try {
      await this.wa.link(phone || null);
    } catch (err) {
      return this.tg.sendMessage(chat, `❌ החיבור לוואטסאפ נכשל: ${err.message}`);
    }
  }

  async onQr(qr) {
    if (!this.linkChat) return;
    this.qrSends++;
    if (this.qrSends > MAX_QR_SENDS) {
      this.wa.wantLink = false;
      this.wa.closeSocket();
      this.wa.status = "stopped";
      await this.deleteLastQr();
      await this.tg.sendMessage(this.linkChat, "הקוד לא נסרק בזמן. שלח /whatsapp כדי לנסות שוב.");
      this.linkChat = null;
      return;
    }
    const png = await this.qrToPng(qr);
    await this.deleteLastQr();
    const msg = await this.tg.sendPhoto(this.linkChat, png, `סרוק עם וואטסאפ של המספר הנפרד (${this.qrSends}/${MAX_QR_SENDS})`);
    this.lastQrMsg = { chat: this.linkChat, id: msg.message_id };
  }

  async deleteLastQr() {
    if (!this.lastQrMsg) return;
    const { chat, id } = this.lastQrMsg;
    this.lastQrMsg = null;
    await this.tg.call("deleteMessage", { chat_id: chat, message_id: id }).catch(() => {});
  }

  async showGroups(chat) {
    if (!this.wa) return this.tg.sendMessage(chat, "וואטסאפ כבוי בהגדרות התוסף.");
    if (this.wa.status !== "open") return this.tg.sendMessage(chat, "וואטסאפ לא מחובר. שלח /whatsapp קודם.");
    try {
      this.groupCache = await this.wa.listGroups();
    } catch (err) {
      return this.tg.sendMessage(chat, `❌ לא הצלחתי לקרוא את הקבוצות: ${err.message}`);
    }
    if (!this.groupCache.length) return this.tg.sendMessage(chat, "המספר הזה לא חבר באף קבוצה. הוסף אותו לקבוצות (רצוי כמנהל) ונסה שוב.");
    return this.tg.sendMessage(chat, "סמן לאילו קבוצות לפרסם (לחיצה מסמנת או מבטלת):\n\nבקבוצה שרק מנהלים יכולים לכתוב בה, המספר צריך להיות מנהל.", {
      reply_markup: { inline_keyboard: this.groupButtons() },
    });
  }

  groupButtons() {
    const chosen = new Set(this.state.get("whatsapp_groups", []).map((g) => g.id));
    return this.groupCache.slice(0, 40).map((g) => [
      { text: `${chosen.has(g.id) ? "✅" : "⬜"} ${g.subject} (${g.size})${g.announce ? " 🔒" : ""}`.slice(0, 60), callback_data: `wg:${g.id}`.slice(0, 64) },
    ]);
  }

  async toggleGroup(q, groupId) {
    const g = this.groupCache.find((x) => x.id === groupId);
    let chosen = this.state.get("whatsapp_groups", []);
    if (chosen.some((x) => x.id === groupId)) chosen = chosen.filter((x) => x.id !== groupId);
    else if (g) chosen = [...chosen, { id: g.id, subject: g.subject }];
    this.state.set("whatsapp_groups", chosen);
    if (q.message) {
      await this.tg
        .call("editMessageReplyMarkup", { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: this.groupButtons() } })
        .catch(() => {});
    }
  }

  // ---------- status ----------

  async statusText() {
    const lines = ["מצב הבוט:"];
    if (this.cfg.telegram_channel) {
      try {
        const chat = await this.tg.call("getChat", { chat_id: this.cfg.telegram_channel });
        lines.push(`✅ ערוץ טלגרם: ${chat.title || this.cfg.telegram_channel}`);
      } catch (err) {
        lines.push(`❌ ערוץ טלגרם (${this.cfg.telegram_channel}): ${err.message}. ודא שהבוט מנהל בערוץ.`);
      }
    } else lines.push("➖ ערוץ טלגרם: לא הוגדר");
    if (this.wa) {
      const groups = this.state.get("whatsapp_groups", []);
      const st = { open: "✅ מחובר", connecting: "⏳ מתחבר", waiting_scan: "⏳ ממתין לסריקה", stopped: "❌ לא מחובר (שלח /whatsapp)" }[this.wa.status] || this.wa.status;
      lines.push(`וואטסאפ: ${st}, ${groups.length} קבוצות נבחרו`);
    } else lines.push("➖ וואטסאפ: כבוי בהגדרות");
    if (this.fb) {
      try {
        lines.push(`✅ דף פייסבוק: ${await this.fb.check()}`);
      } catch (err) {
        lines.push(`❌ דף פייסבוק: ${err.message}`);
      }
    } else lines.push("➖ דף פייסבוק: לא הוגדר");
    lines.push(this.ali ? "✅ API של עליאקספרס: מוגדר" : "➖ API של עליאקספרס: עוד לא (עובדים עם קישורים מ-Portals)");
    lines.push(this.writer.apiKey ? `✅ כתיבת פוסטים: ${this.writer.model}` : "❌ כתיבת פוסטים: חסר anthropic_api_key");
    return lines.join("\n");
  }
}

export function isAffiliateLink(url) {
  return /s\.click\.aliexpress\.com|[?&](aff_fcid|aff_fsk|aff_platform|aff_trace_key|sk)=/i.test(url || "");
}

function formatCode(code) {
  const c = String(code || "");
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
