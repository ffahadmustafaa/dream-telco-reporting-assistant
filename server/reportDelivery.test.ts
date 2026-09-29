import { describe, expect, it } from "vitest";
import { buildReportWorkbook, reportDeliveryConfig } from "./reportDelivery";
import * as XLSX from "xlsx-js-style";

describe("daily report delivery", () => {
  it("creates a non-empty workbook with grouped report sheets", () => {
    const workbook = buildReportWorkbook("2026-09-16", ["Section X", "Super X"], [
      { leader: "Fahad", tester: "Bisma", values: { "Super X": 50, "Section X": 200 }, total: 250 },
      { leader: "Fahad", tester: "Anas", values: { "Super X": 0, "Section X": 100 }, total: 100 },
    ]);
    expect(workbook).toBeInstanceOf(Buffer);
    expect(workbook.length).toBeGreaterThan(100);
    const parsed = XLSX.read(workbook, { type: "buffer", cellStyles: true });
    expect(parsed.SheetNames).toEqual(["Daily Report", "Raw Data"]);
    expect(XLSX.utils.sheet_to_json(parsed.Sheets["Daily Report"], { header: 1 })[0]).toEqual(["Project", "Section X", "Super X", "Total"]);
    expect((parsed.Sheets["Daily Report"] as any).A1.s.fgColor.rgb).toBe("D9E1F2");
    expect((parsed.Sheets["Daily Report"] as any).A2.s.fgColor.rgb).toBe("D9EAD3");
    expect((parsed.Sheets["Daily Report"] as any).A5.s.fgColor.rgb).toBe("B4C6E7");
  });

  it("uses the configured recipient and reports provider readiness", () => {
    const config = reportDeliveryConfig();
    expect(config.recipient).toBe("ffahadmustafaa@gmail.com");
    expect(typeof config.emailConfigured).toBe("boolean");
  });
});
