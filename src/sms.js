/**
 * Formats a Sri Lankan or international phone number for SMS delivery.
 * Examples:
 *   "0771234567" -> "94771234567"
 *   "771234567"  -> "94771234567"
 *   "+94771234567" -> "94771234567"
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
 * Send an SMS OTP verification code using Notify.lk API
 *
 * @param {Object} options
 * @param {string} options.phone - Recipient mobile number (e.g. 0771234567)
 * @param {string} options.otpCode - 6-digit OTP code
 * @returns {Promise<{success: boolean, data?: any, error?: string}>}
 */
export async function sendPhoneVerificationOtp({ phone, otpCode }) {
  const userId = process.env.NOTIFYLK_USER_ID;
  const apiKey = process.env.NOTIFYLK_API_KEY;
  const senderId = process.env.NOTIFYLK_SENDER_ID || "NotifyDEMO";

  // If credentials are not yet configured in .env, log a clear message and don't fail
  if (!userId || !apiKey) {
    console.warn(
      `[SMS] Notify.lk credentials (NOTIFYLK_USER_ID, NOTIFYLK_API_KEY) not set in .env. Phone OTP for ${phone}: ${otpCode}`
    );
    return { success: false, reason: "Notify.lk credentials not set" };
  }

  const formattedTo = formatPhoneNumber(phone);
  const message = `Your GlowNest verification code is: ${otpCode}. Valid for 10 minutes.`;

  try {
    const endpoint = "https://app.notify.lk/api/v1/send";
    const body = new URLSearchParams({
      user_id: userId,
      api_key: apiKey,
      sender_id: senderId,
      to: formattedTo,
      message,
    });

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.status === "error") {
      const errorMsg = data.message || `Notify.lk HTTP error ${response.status}`;
      console.error(`[SMS Gateway Error] Notify.lk failed for ${formattedTo}:`, errorMsg);
      return { success: false, error: errorMsg };
    }

    console.log(`[SMS Gateway] OTP successfully sent via Notify.lk to ${formattedTo}`);
    return { success: true, data };
  } catch (error) {
    console.error(`[SMS Gateway Exception] Failed to send SMS to ${formattedTo}:`, error?.message || error);
    return { success: false, error: error?.message };
  }
}
