/** Server-only OTP delivery adapters. Credentials are never exposed to the browser. */
export const AUTH_DELIVERY_CONFIG = {
  mode: process.env.AUTH_DELIVERY_MODE === "production" ? "production" : "sandbox",
  emailProvider: process.env.AUTH_EMAIL_PROVIDER ?? "",
  emailApiKeyConfigured: Boolean(process.env.AUTH_EMAIL_API_KEY),
  smsProvider: process.env.AUTH_SMS_PROVIDER ?? "",
  smsApiKeyConfigured: Boolean(process.env.AUTH_SMS_API_KEY),
};

export const isSandboxAuth = AUTH_DELIVERY_CONFIG.mode === "sandbox" || !AUTH_DELIVERY_CONFIG.emailApiKeyConfigured || !AUTH_DELIVERY_CONFIG.smsApiKeyConfigured;

async function sendResendEmail(to: string, subject: string, text: string) {
  const apiKey = process.env.AUTH_EMAIL_API_KEY;
  if (!apiKey) throw new Error("AUTH_EMAIL_API_KEY is not configured");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.AUTH_EMAIL_FROM ?? "Dream Telco Security <security@example.com>",
      to: [to], subject, text,
    }),
  });
  if (!response.ok) throw new Error(`Email OTP delivery failed (${response.status})`);
}

async function sendTwilioSms(to: string, body: string) {
  const accountSid = process.env.AUTH_SMS_ACCOUNT_SID;
  const authToken = process.env.AUTH_SMS_API_KEY;
  const from = process.env.AUTH_SMS_FROM;
  if (!accountSid || !authToken || !from) throw new Error("Twilio SMS credentials are not configured");
  const payload = new URLSearchParams({ To: to, From: from, Body: body });
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: payload,
  });
  if (!response.ok) throw new Error(`Phone OTP delivery failed (${response.status})`);
}

export async function sendDualOtp(toEmail: string, toPhone: string, emailOtp: string, phoneOtp: string) {
  if (isSandboxAuth) return { sandbox: true };
  if (AUTH_DELIVERY_CONFIG.emailProvider.toLowerCase() !== "resend") throw new Error("Set AUTH_EMAIL_PROVIDER=resend for production email OTP delivery");
  if (AUTH_DELIVERY_CONFIG.smsProvider.toLowerCase() !== "twilio") throw new Error("Set AUTH_SMS_PROVIDER=twilio for production phone OTP delivery");
  await Promise.all([
    sendResendEmail(toEmail, "Dream Telco verification code", `Your Dream Telco email verification code is ${emailOtp}. It expires in 10 minutes.`),
    sendTwilioSms(toPhone, `Dream Telco phone verification code: ${phoneOtp}. It expires in 10 minutes.`),
  ]);
  return { sandbox: false };
}
