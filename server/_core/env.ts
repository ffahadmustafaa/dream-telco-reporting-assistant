export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  isProduction: process.env.NODE_ENV === "production",
  // Generic OpenAI-compatible chat endpoint (Vercel, Render, local).
  // Falls back to the legacy Manus Forge variables when they exist.
  llmApiUrl: process.env.LLM_API_URL ?? process.env.BUILT_IN_FORGE_API_URL ?? "",
  llmApiKey: process.env.LLM_API_KEY ?? process.env.BUILT_IN_FORGE_API_KEY ?? "",
  llmModel: process.env.LLM_MODEL ?? "openai/gpt-4o-mini",
  reportEmailApiKey: process.env.REPORT_EMAIL_API_KEY ?? process.env.RESEND_API_KEY ?? "",
  reportFromEmail: process.env.REPORT_FROM_EMAIL ?? "",
};
