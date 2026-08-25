import nodemailer from "nodemailer";

function getTransporter() {
  const user = process.env.SMTP_USER || process.env.GMAIL_USER || "";
  const pass = process.env.SMTP_PASS || process.env.GMAIL_PASS || process.env.GMAIL_APP_PASSWORD || "";

  if (!user || !pass) {
    return null;
  }

  const port = Number(process.env.SMTP_PORT || 465);
  const secure = process.env.SMTP_SECURE !== "false" && port === 465;

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port,
    secure,
    auth: {
      user,
      pass,
    },
  });
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Send an OTP verification code via Gmail / SMTP
 * @param {Object} options
 * @param {string} options.to - Recipient email address
 * @param {string} options.otpCode - The 6-digit OTP code
 * @param {string} [options.name] - Recipient name
 */
export async function sendEmailVerificationOtp({ to, otpCode, name = "Valued Customer" }) {
  const transporter = getTransporter();
  const senderEmail = process.env.SMTP_USER || process.env.GMAIL_USER || "no-reply@glownest.com";
  const fromHeader = process.env.EMAIL_FROM || process.env.SMTP_FROM || `"GlowNest" <${senderEmail}>`;

  if (!transporter) {
    console.warn(`[Mailer] SMTP credentials not configured (SMTP_USER / SMTP_PASS). OTP for ${to}: ${otpCode}`);
    return { success: false, reason: "SMTP credentials not configured" };
  }

  const htmlContent = `
    <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 28px; border: 1px solid #eaeaea; border-radius: 12px; background-color: #ffffff;">
      <div style="text-align: center; margin-bottom: 24px;">
        <h1 style="color: #1a202c; font-size: 24px; font-weight: 700; margin: 0;">GlowNest</h1>
        <p style="color: #718096; font-size: 14px; margin-top: 4px;">Account Verification</p>
      </div>
      <p style="color: #2d3748; font-size: 15px; line-height: 1.6;">Hello <strong>${escapeHtml(name)}</strong>,</p>
      <p style="color: #4a5568; font-size: 15px; line-height: 1.6;">Thank you for registering with GlowNest. Please use the verification code below to verify your email address and activate your account:</p>
      
      <div style="text-align: center; margin: 30px 0;">
        <div style="display: inline-block; background: linear-gradient(135deg, #f7fafc 0%, #edf2f7 100%); border: 2px dashed #cbd5e0; border-radius: 10px; padding: 14px 32px;">
          <span style="font-size: 32px; font-weight: 800; letter-spacing: 8px; color: #2b6cb0; font-family: monospace;">${otpCode}</span>
        </div>
      </div>
      
      <p style="color: #718096; font-size: 13px; line-height: 1.5;">This code is valid for <strong>10 minutes</strong>. If you did not initiate this request, please disregard this email.</p>
      
      <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
      <p style="font-size: 12px; color: #a0aec0; text-align: center; margin: 0;">&copy; ${new Date().getFullYear()} GlowNest. All rights reserved.</p>
    </div>
  `;

  const textContent = `Hello ${name},\n\nYour GlowNest verification code is: ${otpCode}\n\nThis code expires in 10 minutes. If you did not request this code, you can safely ignore this email.\n\n— GlowNest Team`;

  const info = await transporter.sendMail({
    from: fromHeader,
    to,
    subject: `${otpCode} is your GlowNest verification code`,
    text: textContent,
    html: htmlContent,
  });

  console.log(`[Mailer] Verification OTP sent to ${to} (Message ID: ${info.messageId})`);
  return { success: true, messageId: info.messageId };
}
