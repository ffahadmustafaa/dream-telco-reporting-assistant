import { describe, expect, it } from "vitest";
import { buildReportWorkbook, reportDeliveryConfig } from "./reportDelivery";

describe("daily report delivery", () => {
  it("creates a non-empty workbook with grouped report sheets", () => {
    const workbook = buildReportWorkbook("2026-09-16", ["Super X", "Inception"], [
      { leader: "Fahad", tester: "Bisma", values: { "Super X": 50, Inception: 200 }, total: 250 },
      { leader: "Fahad", tester: "Anas", values: { "Super X": 0, Inception: 100 }, total: 100 },
    ]);
    expect(workbook).toBeInstanceOf(Buffer);
    expect(workbook.length).toBeGreaterThan(100);
  });

  it("uses the configured recipient and reports provider readiness", () => {
    const config = reportDeliveryConfig();
    expect(config.recipient).toBe("ffahadmustafaa@gmail.com");
    expect(typeof config.emailConfigured).toBe("boolean");
  });
});
