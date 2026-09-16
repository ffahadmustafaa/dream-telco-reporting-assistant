/**
 * Authentication delivery configuration.
 *
 * Sandbox mode is intentionally enabled until real providers are wired. When
 * implementing production delivery, add SMTP/SendGrid and Twilio adapters here
 * and read the credentials from server environment variables only:
 * AUTH_EMAIL_PROVIDER, AUTH_EMAIL_API_KEY, AUTH_SMS_PROVIDER, AUTH_SMS_API_KEY.
 * Never expose these values to the browser or store them in the database.
 */
export const AUTH_DELIVERY_CONFIG = {
  mode: process.env.AUTH_DELIVERY_MODE === "production" ? "production" : "sandbox",
  emailProvider: process.env.AUTH_EMAIL_PROVIDER ?? "",
  emailApiKeyConfigured: Boolean(process.env.AUTH_EMAIL_API_KEY),
  smsProvider: process.env.AUTH_SMS_PROVIDER ?? "",
  smsApiKeyConfigured: Boolean(process.env.AUTH_SMS_API_KEY),
};

export const isSandboxAuth = AUTH_DELIVERY_CONFIG.mode === "sandbox" || !AUTH_DELIVERY_CONFIG.emailApiKeyConfigured || !AUTH_DELIVERY_CONFIG.smsApiKeyConfigured;

// Future adapter signatures:
// export async function sendEmailOtp(to: string, code: string) { ... }
// export async function sendSmsOtp(to: string, code: string) { ... }
