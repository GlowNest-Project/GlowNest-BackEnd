import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  Browsers,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = join(__dirname, "..", ".whatsapp_auth");

let sock = null;
let botStatus = "initializing"; // "initializing" | "qr_ready" | "connected" | "disconnected"
let currentQrDataUrl = null;
let currentQrString = null;
let connectedUser = null;
let isInitializing = false;

/**
 * Standardize phone number for WhatsApp delivery
 * E.g. 0771234567 -> 94771234567
 */
export function formatPhoneNumber(phone) {
  let cleaned = String(phone || "").replace(/[^\d+]/g, "");
  if (cleaned.startsWith("+")) {
    cleaned = cleaned.slice(1);
  }
  if (cleaned.startsWith("0") && cleaned.length === 10) {
    cleaned = `94${cleaned.slice(1)}`;
  }
  if (cleaned.length === 9 && (cleaned.startsWith("7") || cleaned.startsWith("1"))) {
    cleaned = `94${cleaned}`;
  }
  return cleaned;
}

/**
 * Initializes the WhatsApp Bot socket with multi-device authentication
 */
export async function initWhatsAppBot() {
  if (isInitializing) return;
  isInitializing = true;

  try {
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1043857760] }));
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      browser: Browsers.ubuntu("Chrome"),
      syncFullHistory: false,
      connectTimeoutMs: 60000,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQrString = qr;
        try {
          currentQrDataUrl = await QRCode.toDataURL(qr, {
            width: 280,
            margin: 2,
            color: {
              dark: "#271b16",
              light: "#ffffff",
            },
          });
        } catch (qrErr) {
          console.error("[WhatsApp Bot] QR generation error:", qrErr);
        }
        botStatus = "qr_ready";
        console.log("\n=======================================================");
        console.log("[WhatsApp Bot] New QR Code generated! Ready to scan in GlowNest Admin Dashboard.");
        console.log("=======================================================\n");
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        botStatus = "disconnected";
        currentQrDataUrl = null;
        currentQrString = null;
        connectedUser = null;

        console.log(
          `[WhatsApp Bot] Connection closed (code: ${statusCode || "unknown"}). Logged out: ${Boolean(isLoggedOut)}`
        );

        if (isLoggedOut) {
          try {
            await rm(AUTH_DIR, { recursive: true, force: true });
          } catch {}
          setTimeout(() => {
            isInitializing = false;
            initWhatsAppBot();
          }, 4000);
        } else {
          setTimeout(() => {
            isInitializing = false;
            initWhatsAppBot();
          }, 6000);
        }
      } else if (connection === "open") {
        botStatus = "connected";
        currentQrDataUrl = null;
        currentQrString = null;

        const rawUser = sock?.user?.id || sock?.user?.name || "Connected";
        const cleanUser = String(rawUser).split(":")[0].replace(/@.*/, "");
        connectedUser = cleanUser;

        console.log("\n=======================================================");
        console.log(`[WhatsApp Bot] CONNECTED to WhatsApp successfully! Phone: +${cleanUser}`);
        console.log("GlowNest OTP verification is now active and 100% FREE!");
        console.log("=======================================================\n");
      }
    });
  } catch (error) {
    console.error("[WhatsApp Bot Init Error]:", error?.message || error);
    botStatus = "disconnected";
  } finally {
    isInitializing = false;
  }
}

/**
 * Send an OTP code via the connected WhatsApp Bot
 */
export async function sendWhatsAppBotOtp({ phone, otpCode, name = "Customer" }) {
  if (botStatus !== "connected" || !sock) {
    return {
      success: false,
      reason: "bot_not_connected",
      error: "WhatsApp Bot is not connected. Please scan the QR code in the Admin Panel.",
    };
  }

  const formatted = formatPhoneNumber(phone);
  const defaultJid = `${formatted}@s.whatsapp.net`;
  const message = `✨ *GlowNest Verification Code*\n\nHello ${name},\nYour verification code is: *${otpCode}*\n\nThis code is valid for 10 minutes.\nPlease do not share this PIN with anyone.\n\n— GlowNest Client Care`;

  try {
    const [lookup] = (await sock.onWhatsApp(formatted).catch(() => [])) || [];
    const targetJid = lookup?.jid || defaultJid;
    const sent = await sock.sendMessage(targetJid, { text: message });
    console.log(`[WhatsApp Bot] OTP code ${otpCode} successfully sent to ${targetJid}`);
    return { success: true, messageId: sent?.key?.id };
  } catch (error) {
    console.error(`[WhatsApp Bot] Failed to send message to ${formatted}:`, error?.message || error);
    return { success: false, error: error?.message || "Failed to send WhatsApp message" };
  }
}

/**
 * Get current Bot status and QR code
 */
export function getWhatsAppBotStatus() {
  return {
    status: botStatus,
    isConnected: botStatus === "connected",
    connectedUser,
    qrDataUrl: currentQrDataUrl,
  };
}

/**
 * Disconnect/logout the bot and generate a fresh QR code
 */
export async function disconnectWhatsAppBot() {
  try {
    if (sock) {
      await sock.logout();
    }
  } catch (err) {
    console.warn("[WhatsApp Bot] Logout warning:", err?.message);
  }

  botStatus = "disconnected";
  connectedUser = null;
  currentQrDataUrl = null;
  currentQrString = null;

  try {
    await rm(AUTH_DIR, { recursive: true, force: true });
  } catch {}

  setTimeout(() => {
    isInitializing = false;
    initWhatsAppBot();
  }, 2000);

  return { success: true };
}
