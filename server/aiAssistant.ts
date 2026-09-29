/**
 * Deterministic AI-assistant layer for Dream Telco.
 *
 * Parses plain-language commands ("Bisma did 50 OTP on Super X under Mehwish")
 * and answers common workspace questions WITHOUT an LLM round-trip, so roster
 * changes and report logging are instant and predictable. The tRPC
 * `assistant.chat` procedure tries this first and falls back to the LLM for
 * anything it does not understand.
 *
 * Role scoping is applied by the caller: pass only the rows the current user
 * is allowed to see (admin = everything, team leader = own team,
 * tester = own tester row).
 */

export const norm = (s: string) => String(s ?? "").toLowerCase().trim().replace(/\s+/g, " ");

export const title = (s: string) =>
  norm(s)
    .split(" ")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");

export function parseQuantity(value: string | number): number | null {
  const raw = String(value).trim().replace(/,/g, "");
  if (!raw) return null;
  // Slash notation: "120/120" means 120 + 120.
  const parts = raw.split("/").map((p) => Number(p.trim()));
  if (parts.length > 1) {
    if (parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
    return parts.reduce((a, b) => a + b, 0);
  }
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Canonical project name, or null when the text names no known project. */
export function parseProjectName(text: string, projectNames: string[]): string | null {
  const t = norm(text);
  for (const name of projectNames) {
    const n = norm(name);
    if (t.includes(n)) return name;
  }
  // Legacy alias: the old "Inception" project was renamed to "Section X".
  if (t.includes("inception")) {
    const hit = projectNames.find((p) => norm(p) === "section x");
    if (hit) return hit;
  }
  return null;
}

export type AssistantCommand =
  | { type: "log_report"; name: string; quantity: number; project: string; teamLeader: string | null }
  | { type: "add_tester"; name: string; teamLeader: string }
  | { type: "remove_tester"; name: string }
  | { type: "add_team_leader"; name: string }
  | { type: "remove_team_leader"; name: string }
  | { type: "set_target"; name: string; quantity: number }
  | { type: "unknown"; text: string };

/**
 * Parse a single assistant message into a command. `projectNames` are the
 * active project names from the database (e.g. ["Section X", "Super X"]).
 */
export function parseAssistantCommand(text: string, projectNames: string[]): AssistantCommand {
  const t = text.trim();
  const low = t.toLowerCase();
  let m: RegExpMatchArray | null;

  m = low.match(/(?:add|create)\s+(?:new\s+)?team\s*leader\s+([a-z][a-z ]+)/);
  if (m) return { type: "add_team_leader", name: title(m[1]!) };

  m = low.match(/(?:add|create)\s+(?:new\s+)?tester\s+([a-z][a-z ]+?)\s+(?:under|to|in|with)\s+([a-z][a-z ]+)/);
  if (m) return { type: "add_tester", name: title(m[1]!), teamLeader: title(m[2]!) };

  m = low.match(/(?:remove|delete|deactivate)\s+tester\s+([a-z][a-z ]+)/);
  if (m) return { type: "remove_tester", name: title(m[1]!) };

  m = low.match(/(?:remove|delete|deactivate)\s+team\s*leader\s+([a-z][a-z ]+)/);
  if (m) return { type: "remove_team_leader", name: title(m[1]!) };

  m = low.match(/set\s+(?:monthly\s+)?target\s+(\d[\d,]*)\s+for\s+([a-z][a-z ]+)/);
  if (m) {
    const qty = parseQuantity(m[1]!);
    if (qty != null) return { type: "set_target", quantity: qty, name: title(m[2]!) };
  }

  // Optional "under <Team Leader>" suffix, e.g. "Bisma did 50 OTP on Super X under Mehwish".
  // Unknown testers are auto-added under that team leader by the caller.
  let teamLeader: string | null = null;
  let work = t;
  const underM = work.match(/\s+under\s+([a-z][a-z ]+)\s*$/i);
  if (underM) {
    teamLeader = title(underM[1]!.trim());
    work = work.slice(0, underM.index);
  }

  // "Bisma did 50 OTP on Super X" | "Ali 120/120 Section X" | "log 200 for Rida super x"
  m = work.match(/([A-Za-z][A-Za-z ]*?)\s+(?:did|done|completed?|submitted?|logged?|has|have)?\s*(\d[\d,\s\/]*)\s*(?:otps?)?\s*(?:on|in|for)?\s*(section\s*x|super\s*x|inception)/i);
  if (m) {
    const qty = parseQuantity(m[2]!);
    const project = parseProjectName(m[3]!, projectNames);
    if (qty != null && project) {
      return { type: "log_report", name: title(m[1]!.trim()), quantity: qty, project, teamLeader };
    }
  }
  return { type: "unknown", text: t };
}

// ---------------------------------------------------------------------------
// Workspace questions (deterministic answers over a role-scoped snapshot)
// ---------------------------------------------------------------------------

export type SnapshotTester = { id: number; name: string; teamLeaderId: number; status: string };
export type SnapshotLeader = { id: number; name: string; status: string };
export type SnapshotProject = { id: number; name: string };
export type SnapshotRow = { testerId: number; projectId: number; quantity: number };

export type WorkspaceSnapshot = {
  testers: SnapshotTester[];
  leaders: SnapshotLeader[];
  projects: SnapshotProject[];
  /** Performance rows for the day being asked about (already filtered by date). */
  performance: SnapshotRow[];
};

const fmt = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n || 0);

function findTester(snapshot: WorkspaceSnapshot, name: string) {
  const needle = norm(name);
  return snapshot.testers.find((t) => norm(t.name) === needle);
}

function totalForTester(snapshot: WorkspaceSnapshot, testerId: number, projectId?: number) {
  return snapshot.performance
    .filter((r) => r.testerId === testerId && (projectId == null || r.projectId === projectId))
    .reduce((sum, r) => sum + r.quantity, 0);
}

/**
 * Answer common reporting questions. Returns null when the text is not a
 * recognized question (caller falls back to the LLM).
 */
export function answerWorkspaceQuestion(text: string, snapshot: WorkspaceSnapshot): string | null {
  const low = norm(text);
  const projectNames = snapshot.projects.map((p) => p.name);
  const mentionedProject = parseProjectName(text, projectNames);
  const mentionedProjectId = mentionedProject
    ? snapshot.projects.find((p) => p.name === mentionedProject)?.id
    : undefined;

  // "team total for Mehwish" / "how much did Mehwish's team do"
  let m = low.match(/team\s+(?:total|performance).*?(?:for\s+)?([a-z][a-z ]+)/) || low.match(/([a-z][a-z ]+?)(?:'s)?\s+team\s+(?:total|did)/);
  if (m) {
    const leader = snapshot.leaders.find((l) => norm(l.name) === norm(m![1]!));
    if (!leader) return null;
    const memberIds = new Set(snapshot.testers.filter((t) => t.teamLeaderId === leader.id).map((t) => t.id));
    const total = snapshot.performance
      .filter((r) => memberIds.has(r.testerId) && (mentionedProjectId == null || r.projectId === mentionedProjectId))
      .reduce((sum, r) => sum + r.quantity, 0);
    const scope = mentionedProject ? ` on ${mentionedProject}` : "";
    return `${leader.name}'s team did ${fmt(total)} OTPs${scope} today.`;
  }

  // "who hasn't reported" / "missing reporters" / "zero"
  // "top performer" / "who did the most" / "leaderboard"
  if (/top|most|best|leaderboard|ranking/.test(low)) {
    const ranked = snapshot.testers
      .map((t) => ({ name: t.name, total: totalForTester(snapshot, t.id, mentionedProjectId) }))
      .filter((r) => r.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);
    if (!ranked.length) return "No OTPs have been reported yet today.";
    const scope = mentionedProject ? ` (${mentionedProject})` : "";
    return `Top performers today${scope}: ` + ranked.map((r, i) => `${i + 1}. ${r.name} — ${fmt(r.total)}`).join(", ") + ".";
  }

  // "total work by Bisma" / "how much did Ali do"
  m = low.match(/(?:total|how much).*?(?:by|for|did)\s+([a-z][a-z ]+)/);
  if (!m) m = low.match(/^([a-z][a-z ]+?)(?:'s)?\s+(?:total|report|numbers|performance)/);
  if (m) {
    const tester = findTester(snapshot, m[1]!);
    if (!tester) return null; // unknown name -> let the LLM/command layer handle it
    const total = totalForTester(snapshot, tester.id, mentionedProjectId);
    const scope = mentionedProject ? ` on ${mentionedProject}` : "";
    return `${tester.name} did ${fmt(total)} OTPs${scope} today.`;
  }

  if (/not .*report|missing|haven't|hasn't|zero|didn.?t/.test(low)) {
    const reported = new Set(snapshot.performance.map((r) => r.testerId));
    const missing = snapshot.testers.filter((t) => t.status === "ACTIVE" && !reported.has(t.id));
    if (!missing.length) return "Everyone on the roster has reported today. 🎉";
    return `Haven't reported today (${missing.length}): ` + missing.map((t) => t.name).join(", ") + ".";
  }

  // "Section X vs Super X" / "compare projects"
  if (/ vs |versus|compare/.test(low) || (projectNames.length >= 2 && projectNames.every((p) => low.includes(norm(p))))) {
    const parts = snapshot.projects.map((p) => {
      const total = snapshot.performance.filter((r) => r.projectId === p.id).reduce((s, r) => s + r.quantity, 0);
      return `${p.name}: ${fmt(total)}`;
    });
    return "Today — " + parts.join(" vs ") + ".";
  }

  // "total for Super X" / "how much on Section X"
  if (mentionedProject && /total|much|many/.test(low)) {
    const total = snapshot.performance
      .filter((r) => r.projectId === mentionedProjectId)
      .reduce((sum, r) => sum + r.quantity, 0);
    return `Total on ${mentionedProject} today: ${fmt(total)} OTPs.`;
  }

  return null;
}
