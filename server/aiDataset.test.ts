import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { answerDatasetQuestion, parseWorkbook, summarizeDataset } from "./aiDataset";

function makeWorkbook(): Buffer {
  const wb = XLSX.utils.book_new();
  const rows = [
    { Tester: "Bisma", "Section X": 200, "Super X": 50 },
    { Tester: "Ali", "Section X": 0, "Super X": 300 },
    { Tester: "Rida", "Section X": 120, "Super X": "40/40" },
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Daily");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("parseWorkbook", () => {
  it("parses sheets and coerces slash notation", () => {
    const sheets = parseWorkbook(makeWorkbook(), "daily.xlsx");
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.name).toBe("Daily");
    expect(sheets[0]!.rows).toHaveLength(3);
    // "40/40" becomes 80
    expect(sheets[0]!.rows[2]!["Super X"]).toBe(80);
  });
  it("throws on empty workbooks", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), "Empty");
    expect(() => parseWorkbook(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer, "empty.xlsx")).toThrow();
  });
});

describe("summarizeDataset", () => {
  it("reports row counts and a grand total", () => {
    const summary = summarizeDataset(parseWorkbook(makeWorkbook(), "daily.xlsx"));
    expect(summary).toContain("3 rows");
    // 200+50 + 0+300 + 120+80 = 750
    expect(summary).toContain("750");
  });
});

describe("answerDatasetQuestion", () => {
  const sheets = () => parseWorkbook(makeWorkbook(), "daily.xlsx");
  it("totals all numeric project columns for a person", () => {
    expect(answerDatasetQuestion("total work by Bisma", sheets())).toContain("250");
  });
  it("finds the top performer", () => {
    const answer = answerDatasetQuestion("who did the most", sheets());
    expect(answer).toContain("Ali");
  });
  it("compares project columns", () => {
    const answer = answerDatasetQuestion("Section X vs Super X", sheets());
    expect(answer).toContain("Section X: 320");
    expect(answer).toContain("Super X: 430");
  });
  it("returns null for unrecognized questions", () => {
    expect(answerDatasetQuestion("what is the capital of France?", sheets())).toBeNull();
  });
});
