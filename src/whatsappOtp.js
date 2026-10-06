import { sendPhoneVerificationOtp } from "./sms.js";
import { getWhatsAppBotStatus, sendWhatsAppBotOtp } from "./whatsappBot.js";

/**
 * Formats a Sri Lankan or international phone number for WhatsApp delivery.
 * Examples:
 *   "0771234567"   -> "94771234567"
 *   "+94771234567" -> "94771234567"
 *   "771234567"    -> "94771234567"
 */
export function formatPhoneNumber(phone) {
  let cleaned = String(phone || "").replace(/[^\d+]/g, "");

  if (cleaned.startsWith("+")) {
    cleaned = cleaned.slice(1);
  }

  // Local 10-digit Sri Lankan numbers starting with 0 (e.g., 0771234567)
  if (cleaned.startsWith("0") && cleaned.length === 10) {
    cleaned = `94${cleaned.slice(1)}`;
  }

  // 9-digit local numbers without leading 0 (e.g., 771234567)
  if (cleaned.length === 9 && (cleaned.startsWith("7") || cleaned.startsWith("1"))) {
    cleaned = `94${cleaned}`;
  }

  return cleaned;
}

/**
 * Send an OTP verification code via WhatsApp.
 * Priority:
 *  1. 100% Free Self-Hosted WhatsApp Web Bot (Baileys QR-linked)
 *  2. Meta WhatsApp Cloud API (if configured in .env)
 *  3. Custom WhatsApp Gateway Webhook (if configured in .env)
 *  4. Fallback to SMS if WhatsApp fails or bot is unlinked
 *
 * @param {Object} options
 * @param {string} options.phone - Recipient phone number (e.g. "0771234567")
 * @param {string} options.otpCode - 6-digit OTP verification code
 * @param {string} [options.name] - Customer name
 * @returns {Promise<{success: boolean, channel: string, data?: any, error?: string}>}
 */
export async function sendWhatsAppVerificationOtp({ phone, otpCode, name = "Customer" }) {
  const formattedPhone = formatPhoneNumber(phone);

  // 1. Try Free Local WhatsApp Web Bot First
  const botStatus = getWhatsAppBotStatus();
  if (botStatus.isConnected) {
    const botResult = await sendWhatsAppBotOtp({ phone: formattedPhone, otpCode, name });
    if (botResult.success) {
      console.log(`[WhatsApp OTP] Sent via Free WhatsApp Bot to ${formattedPhone}`);
      return { success: true, channel: "whatsapp", data: botResult };
    }
    console.warn(`[WhatsApp Bot] Send failed (${botResult.error}), trying other methods...`);
  }

  // 2. Check for Meta WhatsApp Cloud API credentials
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const templateName = process.env.WHATSAPP_TEMPLATE_NAME;

  if (phoneNumberId && accessToken) {
    try {
      const endpoint = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
      const otpMessage = `Your GlowNest verification code is: *${otpCode}*.\nValid for 10 minutes.\n\nDo not share this code with anyone.`;

      let payload;
      if (templateName) {
        payload = {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: formattedPhone,
          type: "template",
          template: {
            name: templateName,
            language: { code: process.env.WHATSAPP_TEMPLATE_LANG || "en_US" },
            components: [
              {
                type: "body",
                parameters: [{ type: "text", text: otpCode }],
              },
              {
                type: "button",
                sub_type: "url",
                index: "0",
                parameters: [{ type: "text", text: otpCode }],
              },
            ],
          },
        };
      } else {
        payload = {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: formattedPhone,
          type: "text",
          text: {
            preview_url: false,
            body: otpMessage,
          },
        };
      }

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || data.error) {
        const errorMsg = data.error?.message || `Meta WhatsApp API error ${response.status}`;
        console.error(`[WhatsApp API Error] Failed for ${formattedPhone}:`, errorMsg);
        return await fallbackToSms({ phone, otpCode, originalError: errorMsg });
      }

      console.log(`[WhatsApp API] OTP successfully sent via WhatsApp Cloud API to ${formattedPhone}`);
      return { success: true, channel: "whatsapp", data };
    } catch (err) {
      console.error(`[WhatsApp API Exception] Error sending to ${formattedPhone}:`, err?.message || err);
      return await fallbackToSms({ phone, otpCode, originalError: err?.message });
    }
  }

  // 3. Check for Custom WhatsApp Gateway URL
  const gatewayUrl = process.env.WHATSAPP_GATEWAY_URL;
  const gatewayToken = process.env.WHATSAPP_GATEWAY_TOKEN;

  if (gatewayUrl) {
    try {
      const otpMessage = `Your GlowNest verification code is: *${otpCode}*.\nValid for 10 minutes.\n\nDo not share this code with anyone.`;
      const response = await fetch(gatewayUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: gatewayToken,
          to: formattedPhone,
          body: otpMessage,
          message: otpMessage,
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        console.log(`[WhatsApp Gateway] OTP sent via custom gateway to ${formattedPhone}`);
        return { success: true, channel: "whatsapp", data };
      }
    } catch (err) {
      console.error(`[WhatsApp Gateway Error]`, err?.message || err);
    }
  }

  // 4. Fallback / Dev Output when Bot is not yet scanned
  console.warn(
    `[WhatsApp OTP] WhatsApp Bot is not connected yet. (Open Admin Dashboard > WhatsApp Bot to scan the QR code).`
  );
  console.log(`[WhatsApp OTP - Dev Output] OTP for ${formattedPhone}: ${otpCode}`);

  return await fallbackToSms({ phone, otpCode, originalError: "WhatsApp Bot not scanned" });
}

/**
 * Fallback to SMS if WhatsApp Bot/API is not yet configured
 */
async function fallbackToSms({ phone, otpCode, originalError }) {
  const smsResult = await sendPhoneVerificationOtp({ phone, otpCode });
  if (smsResult.success) {
    console.log(`[OTP Delivery] Successfully fell back to SMS for ${phone}`);
    return { success: true, channel: "sms", data: smsResult.data };
  }

  return {
    success: false,
    channel: "whatsapp",
    error: originalError || smsResult.error || "Delivery failed",
  };
}
