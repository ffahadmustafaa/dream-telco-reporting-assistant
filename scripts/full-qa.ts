/**
 * Comprehensive API test harness for Dream Telco.
 * Tests every endpoint as every role, verifying auth + data scoping.
 * Run: ./node_modules/.bin/tsx scripts/full-qa.ts
 */
import "dotenv/config";

import { createSessionToken } from "../server/_core/session";
import { getUserByEmail, listUsers } from "../server/db";

const BASE = "http://localhost:3000/api/trpc";

type Role = "super_admin" | "hq_admin" | "manager" | "team_leader" | "tester";

interface TestResult {
  name: string;
  role: Role;
  endpoint: string;
  expected: "success" | "forbidden";
  actual: "success" | "forbidden" | "error";
  detail: string;
  pass: boolean;
}

const results: TestResult[] = [];

async function getToken(email: string): Promise<string> {
  const user = await getUserByEmail(email);
  if (!user) throw new Error(`User not found: ${email}`);
  return createSessionToken(user.openId, { name: user.name ?? "Test" });
}

async function call(endpoint: string, token: string, input?: unknown, method: "query" | "mutation" = "query"): Promise<{ ok: boolean; data?: any; error?: string }> {
  const [router, proc] = endpoint.split(".");
  
  let url: string;
  let fetchOptions: RequestInit;
  
  if (method === "mutation") {
    // Mutations use POST with batch format
    url = `${BASE}/${router}.${proc}?batch=1`;
    fetchOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `app_session_id=${token}`,
      },
      body: JSON.stringify({ "0": { json: input ?? {} } }),
    };
  } else {
    url = input !== undefined
      ? `${BASE}/${router}.${proc}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`
      : `${BASE}/${router}.${proc}`;
    fetchOptions = {
      method: "GET",
      headers: { Cookie: `app_session_id=${token}` },
    };
  }
  
  const res = await fetch(url, fetchOptions);
  
  const text = await res.text();
  try {
    const json = JSON.parse(text);
    // Handle batch response format
    const result = Array.isArray(json) ? json[0] : json;
    if (result?.error) {
      return { ok: false, error: result.error.message || JSON.stringify(result.error) };
    }
    const data = result?.result?.data;
    // Unwrap superjson
    return { ok: true, data: data?.json ?? data };
  } catch {
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
}

async function test(
  name: string,
  role: Role,
  token: string,
  endpoint: string,
  input: unknown,
  expected: "success" | "forbidden",
  validate?: (data: any) => string | null,
  method: "query" | "mutation" = "query"
) {
  const res = await call(endpoint, token, input, method);
  const actual = res.ok ? "success" : (res.error?.includes("permission") || res.error?.includes("FORBIDDEN") || res.error?.includes("Unauthorized") ? "forbidden" : "error");
  
  let detail = res.ok ? "OK" : res.error ?? "Unknown";
  let pass = actual === expected;
  
  if (res.ok && validate) {
    const validationError = validate(res.data);
    if (validationError) {
      pass = false;
      detail = `Validation failed: ${validationError}`;
    }
  }
  
  if (!res.ok && expected === "success") {
    pass = false;
  }
  
  results.push({ name, role, endpoint, expected, actual, detail: detail.slice(0, 150), pass });
}

async function main() {
  console.log("Setting up test tokens...\n");
  
  const tokens: Record<Role, string> = {
    super_admin: await getToken("ffahadmustafaa@gmail.com"),
    hq_admin: await getToken("hqall01@gmail.com"),
    manager: await getToken("regiona01@gmail.com"),
    team_leader: "", // Will find a team leader
    tester: "", // Will find a tester
  };
  
  // Find a team leader and tester
  const users = await listUsers();
  const tl = users.find(u => u.accountRole === "team_leader");
  const tester = users.find(u => u.accountRole === "tester");
  if (tl) tokens.team_leader = await getToken(tl.email!);
  if (tester) tokens.tester = await getToken(tester.email!);
  
  console.log("Running tests...\n");
  
  const today = new Date().toISOString().split("T")[0];
  
  // === DASHBOARD OVERVIEW ===
  for (const role of Object.keys(tokens) as Role[]) {
    if (!tokens[role]) continue;
    await test(`Overview loads`, role, tokens[role], "dashboard.overview", { date: today }, "success", (data) => {
      if (!data || !Array.isArray(data.projects)) return "missing projects";
      if (!Array.isArray(data.testers)) return "missing testers";
      return null;
    });
  }
  
  // === ROSTER ===
  for (const role of Object.keys(tokens) as Role[]) {
    if (!tokens[role]) continue;
    const expected = role === "tester" ? "success" : "success"; // Returns empty for testers, not forbidden
    await test(`Roster list`, role, tokens[role], "roster.list", undefined, expected);
  }
  
  // === TARGETS ===
  for (const role of Object.keys(tokens) as Role[]) {
    if (!tokens[role]) continue;
    await test(`Targets list`, role, tokens[role], "targets.list", undefined, "success");
  }
  
  // === PAYOUTS ===
  for (const role of Object.keys(tokens) as Role[]) {
    if (!tokens[role]) continue;
    await test(`Payouts list`, role, tokens[role], "payouts.list", undefined, "success", (data) => {
      if (role === "tester" && Array.isArray(data)) {
        const withAmounts = data.filter((p: any) => p.netPayout > 0 || p.grossPayout > 0);
        if (withAmounts.length > 0) return `tester sees ${withAmounts.length} payouts with amounts`;
      }
      return null;
    });
  }
  
  // Payout import should fail for testers/team_leaders
  if (tokens.tester) {
    await test(`Payout import blocked for tester`, "tester", tokens.tester, "payouts.importText", { fileName: "test.txt", rawText: "Ali, 5000" }, "forbidden", undefined, "mutation");
  }
  if (tokens.team_leader) {
    await test(`Payout import blocked for team_leader`, "team_leader", tokens.team_leader, "payouts.importText", { fileName: "test.txt", rawText: "Ali, 5000" }, "forbidden", undefined, "mutation");
  }
  
  // === USER MANAGEMENT ===
  for (const role of ["super_admin", "hq_admin", "manager"] as Role[]) {
    if (!tokens[role]) continue;
    await test(`User directory`, role, tokens[role], "userManagement.directory", undefined, "success", (data) => {
      if (!Array.isArray(data)) return "not an array";
      if (role === "manager") {
        const staff = data.filter((u: any) => ["manager", "hq_admin", "super_admin", "admin"].includes(u.accountRole));
        if (staff.length > 0) return `manager sees ${staff.length} staff accounts`;
      }
      return null;
    });
  }
  if (tokens.team_leader) {
    await test(`User directory blocked for TL`, "team_leader", tokens.team_leader, "userManagement.directory", undefined, "forbidden");
  }
  
  // === ADMIN DASHBOARD ===
  for (const role of ["super_admin", "hq_admin", "manager"] as Role[]) {
    if (!tokens[role]) continue;
    await test(`Admin summary`, role, tokens[role], "adminDashboard.summary", undefined, "success");
  }
  
  // exportReport should be super_admin only
  if (tokens.hq_admin) {
    await test(`exportReport blocked for HQ`, "hq_admin", tokens.hq_admin, "adminDashboard.exportReport", undefined, "forbidden", undefined, "mutation");
  }
  if (tokens.manager) {
    await test(`exportReport blocked for manager`, "manager", tokens.manager, "adminDashboard.exportReport", undefined, "forbidden", undefined, "mutation");
  }
  await test(`exportReport works for super`, "super_admin", tokens.super_admin, "adminDashboard.exportReport", undefined, "success", (data) => {
    if (!data?.contentBase64) return "no file content";
    if (!data?.rows || data.rows === 0) return "empty report";
    return null;
  }, "mutation");
  
  // exportDailyReport should work for manager+ (region-scoped)
  for (const role of ["super_admin", "hq_admin", "manager"] as Role[]) {
    if (!tokens[role]) continue;
    await test(`Daily export (region-scoped)`, role, tokens[role], "adminDashboard.exportDailyReport", { date: today }, "success", (data) => {
      if (!data?.contentBase64) return "no file content";
      return null;
    }, "mutation");
  }
  
  // === REGIONS (super only) ===
  await test(`Regions list (super)`, "super_admin", tokens.super_admin, "regions.list", undefined, "success");
  if (tokens.hq_admin) {
    await test(`Regions list blocked for HQ`, "hq_admin", tokens.hq_admin, "regions.list", undefined, "forbidden");
  }
  
  // === SETTINGS/AUTOMATION (super only) ===
  await test(`Settings get (super)`, "super_admin", tokens.super_admin, "settings.get", undefined, "success");
  if (tokens.hq_admin) {
    await test(`Settings blocked for HQ`, "hq_admin", tokens.hq_admin, "settings.get", undefined, "forbidden");
  }
  
  // === WHITENOISE (super only) ===
  await test(`Whitenoise config (super)`, "super_admin", tokens.super_admin, "whitenoise.getConfig", undefined, "success");
  if (tokens.hq_admin) {
    await test(`Whitenoise blocked for HQ`, "hq_admin", tokens.hq_admin, "whitenoise.getConfig", undefined, "forbidden");
  }
  
  // === AUDIT ===
  for (const role of ["super_admin", "hq_admin", "manager"] as Role[]) {
    if (!tokens[role]) continue;
    await test(`Audit list`, role, tokens[role], "audit.list", undefined, "success");
  }
  if (tokens.team_leader) {
    await test(`Audit blocked for TL`, "team_leader", tokens.team_leader, "audit.list", undefined, "forbidden");
  }
  
  // === PERFORMANCE HISTORY ===
  if (tokens.tester) {
    await test(`My history (tester)`, "tester", tokens.tester, "performance.myHistory", undefined, "success");
  }
  if (tokens.team_leader) {
    await test(`Team history (TL)`, "team_leader", tokens.team_leader, "performance.teamHistory", undefined, "success");
  }
  if (tokens.manager) {
    await test(`Team history (manager)`, "manager", tokens.manager, "performance.teamHistory", undefined, "success");
  }
  
  // Print results
  console.log("\n" + "=".repeat(80));
  console.log("TEST RESULTS");
  console.log("=".repeat(80) + "\n");
  
  const passed = results.filter(r => r.pass);
  const failed = results.filter(r => !r.pass);
  
  for (const r of results) {
    const icon = r.pass ? "✅" : "❌";
    console.log(`${icon} [${r.role}] ${r.name} (${r.endpoint})`);
    if (!r.pass) {
      console.log(`   Expected: ${r.expected}, Got: ${r.actual} - ${r.detail}`);
    }
  }
  
  console.log("\n" + "=".repeat(80));
  console.log(`PASSED: ${passed.length}/${results.length}`);
  if (failed.length > 0) {
    console.log(`FAILED: ${failed.length}`);
    console.log("\nFailed tests:");
    for (const r of failed) {
      console.log(`  - [${r.role}] ${r.name}: ${r.detail}`);
    }
  }
  console.log("=".repeat(80));
  
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(e => {
  console.error("Test harness failed:", e);
  process.exit(1);
});
