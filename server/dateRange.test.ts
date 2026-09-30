import { describe, expect, it } from "vitest";
import { parseQuestionDateRange } from "./aiAssistant";

const TODAY = "2026-09-30";

describe("parseQuestionDateRange", () => {
  it("defaults to today", () => {
    expect(parseQuestionDateRange("who did the most", TODAY)).toEqual({ from: TODAY, to: TODAY, label: "today" });
  });

  it("parses yesterday", () => {
    expect(parseQuestionDateRange("who did the most yesterday", TODAY)).toEqual({ from: "2026-09-29", to: "2026-09-29", label: "yesterday" });
  });

  it("parses this week / last 7 days / past week", () => {
    expect(parseQuestionDateRange("total for this week", TODAY)).toEqual({ from: "2026-09-24", to: TODAY, label: "the last 7 days" });
    expect(parseQuestionDateRange("how much in the last 7 days", TODAY).from).toBe("2026-09-24");
    expect(parseQuestionDateRange("report for the past week", TODAY).from).toBe("2026-09-24");
  });

  it("parses this month", () => {
    expect(parseQuestionDateRange("totals this month", TODAY)).toEqual({ from: "2026-09-01", to: TODAY, label: "this month" });
  });

  it("parses an explicit YYYY-MM-DD date", () => {
    expect(parseQuestionDateRange("who reported on 2026-09-15", TODAY)).toEqual({ from: "2026-09-15", to: "2026-09-15", label: "2026-09-15" });
  });

  it("handles month boundaries for yesterday", () => {
    expect(parseQuestionDateRange("yesterday's total", "2026-10-01")).toEqual({ from: "2026-09-30", to: "2026-09-30", label: "yesterday" });
  });
});
