import { describe, expect, it } from "vitest";
import { answerWorkspaceQuestion, parseAssistantCommand, parseProjectName, parseQuantity, type WorkspaceSnapshot } from "./aiAssistant";

const PROJECTS = ["Section X", "Super X"];

describe("parseQuantity", () => {
  it("parses plain numbers, commas, and slash notation", () => {
    expect(parseQuantity("50")).toBe(50);
    expect(parseQuantity("1,200")).toBe(1200);
    expect(parseQuantity("120/120")).toBe(240);
    expect(parseQuantity("30/40/50")).toBe(120);
    expect(parseQuantity("abc")).toBeNull();
    expect(parseQuantity("-5")).toBeNull();
  });
});

describe("parseProjectName", () => {
  it("matches canonical names and the legacy Inception alias", () => {
    expect(parseProjectName("did 50 on super x", PROJECTS)).toBe("Super X");
    expect(parseProjectName("200 section x", PROJECTS)).toBe("Section X");
    expect(parseProjectName("200 inception", PROJECTS)).toBe("Section X");
    expect(parseProjectName("no project here", PROJECTS)).toBeNull();
  });
});

describe("parseAssistantCommand", () => {
  it("parses a basic report", () => {
    expect(parseAssistantCommand("Bisma did 50 OTP on Super X", PROJECTS)).toEqual({
      type: "log_report", name: "Bisma", quantity: 50, project: "Super X", teamLeader: null,
    });
  });
  it("parses a report with an under clause and slash quantity", () => {
    expect(parseAssistantCommand("Zara did 80/20 on Section X under Mehwish", PROJECTS)).toEqual({
      type: "log_report", name: "Zara", quantity: 100, project: "Section X", teamLeader: "Mehwish",
    });
  });
  it("parses roster commands", () => {
    expect(parseAssistantCommand("Add tester Ali under Ayesha", PROJECTS)).toEqual({ type: "add_tester", name: "Ali", teamLeader: "Ayesha" });
    expect(parseAssistantCommand("Remove tester Ali", PROJECTS)).toEqual({ type: "remove_tester", name: "Ali" });
    expect(parseAssistantCommand("Add team leader Hamza", PROJECTS)).toEqual({ type: "add_team_leader", name: "Hamza" });
    expect(parseAssistantCommand("Remove team leader Hamza", PROJECTS)).toEqual({ type: "remove_team_leader", name: "Hamza" });
    expect(parseAssistantCommand("Set target 5000 for Bisma", PROJECTS)).toEqual({ type: "set_target", name: "Bisma", quantity: 5000 });
  });
  it("returns unknown for free-form questions", () => {
    expect(parseAssistantCommand("Who did the most today?", PROJECTS).type).toBe("unknown");
  });
});

const snapshot = (): WorkspaceSnapshot => ({
  testers: [
    { id: 1, name: "Bisma", teamLeaderId: 10, status: "ACTIVE" },
    { id: 2, name: "Ali", teamLeaderId: 10, status: "ACTIVE" },
    { id: 3, name: "Rida", teamLeaderId: 11, status: "ACTIVE" },
  ],
  leaders: [
    { id: 10, name: "Mehwish", status: "ACTIVE" },
    { id: 11, name: "Ayesha", status: "ACTIVE" },
  ],
  projects: [
    { id: 100, name: "Section X" },
    { id: 101, name: "Super X" },
  ],
  performance: [
    { testerId: 1, projectId: 100, quantity: 200 },
    { testerId: 1, projectId: 101, quantity: 50 },
    { testerId: 2, projectId: 101, quantity: 300 },
  ],
});

describe("answerWorkspaceQuestion", () => {
  it("totals work by person across all numeric project columns", () => {
    expect(answerWorkspaceQuestion("total work by Bisma", snapshot())).toContain("250");
  });
  it("answers top performer", () => {
    const answer = answerWorkspaceQuestion("who did the most today?", snapshot());
    expect(answer).toContain("Ali");
    expect(answer).toContain("300");
  });
  it("answers team totals", () => {
    expect(answerWorkspaceQuestion("team total for Mehwish", snapshot())).toContain("550");
  });
  it("lists missing reporters", () => {
    const answer = answerWorkspaceQuestion("who hasn't reported today?", snapshot());
    expect(answer).toContain("Rida");
  });
  it("compares Section X vs Super X", () => {
    const answer = answerWorkspaceQuestion("Section X vs Super X", snapshot());
    expect(answer).toContain("Section X: 200");
    expect(answer).toContain("Super X: 350");
  });
  it("returns null for unrecognized questions", () => {
    expect(answerWorkspaceQuestion("what is the weather like?", snapshot())).toBeNull();
  });
});
