import { describe, expect, it } from "vitest";

describe("daily report email configuration", () => {
  it("authenticates to the configured Resend account", async () => {
    const apiKey = process.env.REPORT_EMAIL_API_KEY;
    expect(apiKey, "REPORT_EMAIL_API_KEY must be configured").toBeTruthy();
    const response = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(response.status, await response.text()).toBeLessThan(400);
  }, 15_000);
});
