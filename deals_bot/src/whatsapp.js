// WhatsApp through Baileys (WhatsApp Web protocol, linked device).
// Use a separate number, not your personal one: this is not an official
// WhatsApp API, and WhatsApp may block numbers that it sees as automated.

import { EventEmitter } from "node:events";
import fs from "node:fs";

export class WhatsApp extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.authDir where the login is kept (inside /data, so it is backed up)
   * @param {Function} [opts.loader] returns the Baileys module (tests pass a fake one)
   */
  constructor({ authDir, log = console, loader }) {
    super();
    this.authDir = authDir;
    this.log = log;
    this.loader = loader || (() => import("@whiskeysockets/baileys"));
    this.sock = null;
    this.status = "stopped"; // stopped | connecting | waiting_scan | open
    this.me = null;
    this.retry = 0;
    this.pairingNumber = null;
    this.wantLink = false;
    this.stopped = false;
  }

  hasLogin() {
    return fs.existsSync(`${this.authDir}/creds.json`);
  }

  /** Connect with the saved login. Without one, does nothing until link() is called. */
  async start() {
    if (this.hasLogin()) await this.connect();
  }

  /** Start linking a new device: emits "qr" (QR text), or "pairing_code" when a phone number is given. */
  async link(phoneNumber = null) {
    this.pairingNumber = phoneNumber ? String(phoneNumber).replace(/\D/g, "") : null;
    this.wantLink = true;
    if (this.status === "open") return;
    await this.connect(true);
  }

  async connect(force = false) {
    if (this.sock && !force) return;
    this.closeSocket();
    const B = await this.loader();
    const makeWASocket = B.default?.default || B.default || B.makeWASocket;
    const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = B;
    fs.mkdirSync(this.authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      version = undefined;
    }
    let logger;
    try {
      const pino = (await import("pino")).default;
      logger = pino({ level: "error" });
    } catch {
      logger = undefined;
    }
    this.status = "connecting";
    const sock = makeWASocket({
      auth: state,
      version,
      logger,
      browser: Browsers?.ubuntu ? Browsers.ubuntu("Deals Bot") : undefined,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    this.sock = sock;
    let pairingRequested = false;

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", async (u) => {
      if (sock !== this.sock) return; // an old socket
      const { connection, lastDisconnect, qr } = u;
      if (qr) {
        if (!this.wantLink) {
          // Not linked and nobody asked to link: stay quiet instead of looping on QR codes.
          this.closeSocket();
          this.status = "stopped";
          return;
        }
        this.status = "waiting_scan";
        if (this.pairingNumber && !pairingRequested) {
          pairingRequested = true;
          try {
            const code = await sock.requestPairingCode(this.pairingNumber);
            this.emit("pairing_code", code);
          } catch (err) {
            this.emit("error", new Error(`pairing code: ${err.message}`));
          }
        } else if (!this.pairingNumber) {
          this.emit("qr", qr);
        }
      }
      if (connection === "open") {
        this.status = "open";
        this.retry = 0;
        this.wantLink = false;
        this.me = sock.user ? { id: sock.user.id, name: sock.user.name || sock.user.verifiedName || "" } : null;
        this.log.info(`[whatsapp] connected as ${this.me ? this.me.id : "?"}`);
        this.emit("open", this.me);
      }
      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        this.sock = null;
        if (this.stopped) return;
        if (code === DisconnectReason?.loggedOut) {
          this.status = "stopped";
          this.me = null;
          this.clearLogin();
          this.log.warn("[whatsapp] logged out from the phone");
          this.emit("logged_out");
          return;
        }
        if (!this.hasLogin() && !this.wantLink) {
          this.status = "stopped";
          return;
        }
        // restartRequired (515) right after scanning is normal: reconnect at once.
        const delay = code === DisconnectReason?.restartRequired ? 500 : Math.min(60000, 2000 * 2 ** this.retry++);
        this.status = "connecting";
        this.log.warn(`[whatsapp] connection closed (${code}), reconnecting in ${Math.round(delay / 1000)}s`);
        setTimeout(() => !this.stopped && !this.sock && this.connect().catch((e) => this.log.error(`[whatsapp] ${e.message}`)), delay).unref?.();
      }
    });
  }

  async listGroups() {
    if (!this.sock || this.status !== "open") throw new Error("WhatsApp is not connected");
    const all = await this.sock.groupFetchAllParticipating();
    return Object.values(all || {})
      .map((g) => ({ id: g.id, subject: g.subject || g.id, size: (g.participants || []).length, announce: !!g.announce }))
      .sort((a, b) => b.size - a.size);
  }

  async sendImage(jid, image, caption) {
    if (!this.sock || this.status !== "open") throw new Error("WhatsApp is not connected");
    await this.sock.sendMessage(jid, { image, caption });
  }

  async logout() {
    this.wantLink = false;
    try {
      if (this.sock) await this.sock.logout();
    } catch {
      /* already gone */
    }
    this.closeSocket();
    this.clearLogin();
    this.status = "stopped";
    this.me = null;
  }

  clearLogin() {
    try {
      fs.rmSync(this.authDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  closeSocket() {
    const s = this.sock;
    this.sock = null;
    if (s) {
      try {
        s.ev.removeAllListeners?.("connection.update");
        s.end?.(undefined);
      } catch {
        /* ignore */
      }
    }
  }

  stop() {
    this.stopped = true;
    this.closeSocket();
  }
}
