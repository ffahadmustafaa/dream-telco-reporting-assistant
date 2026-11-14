/**
 * Verify: a user removed from the User Directory must not show in the Excel
 * report — and neither must a deactivated (INACTIVE) tester.
 *
 * Setup (production Firestore, test data only, cleaned up at the end):
 * - "ZZ Remove Me": a tester user account + matching ACTIVE roster entry with
 *   real performance today -> must appear in the report BEFORE the delete,
 *   and be gone from the roster + the report AFTER userManagement.delete.
 * - "ZZ Inactive Me": an INACTIVE roster entry with performance today ->
 *   must never appear in the report.
 *
 * Run with the local dev server up: `pnpm dev` (port 3000).
 * Usage: ./node_modules/.bin/tsx scripts/verify-remove-user-report.ts
 */
import "dotenv/config";
// xlsx-js-style is CJS (same library as server/reportDelivery.ts); default
// import carries its full API under tsx.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import XLSX from "xlsx-js-style";
import {
  deletePerformanceByTester,
  deleteTester,
  deleteUser,
  getTester,
  insertPerformance,
  insertTester,
  insertUser,
  listActiveProjects,
  listTeamLeaders,
  listTesters,
  listUsers,
} from "../server/db";
import { createSessionToken } from "../server/_core/session";

const BASE = "http://localhost:3000/api/trpc";
const NAME_ACTIVE = "ZZ Remove Me";
const NAME_INACTIVE = "ZZ Inactive Me";

function karachiDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

async function trpc(path: string, token: string, input: unknown) {
  const res = await fetch(`${BASE}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `app_session_id=${token}` },
    body: JSON.stringify({ json: input }),
  });
  const body = (await res.json()) as any;
  if (!res.ok || body?.error) throw new Error(`${path} failed (${res.status}): ${JSON.stringify(body?.error ?? body)}`);
  return body.result.data.json;
}

async function reportNames(token: string): Promise<string[]> {
  const out = await trpc("adminDashboard.exportReport", token, {});
  const buf = Buffer.from(out.contentBase64, "base64");
  const wb = XLSX.read(buf, { type: "buffer" });
  const names: string[] = [];
  for (const sheet of Object.values(wb.Sheets)) {
    const rows = XLSX.utils.sheet_to_json(sheet!, { header: 1 }) as unknown[][];
    for (const row of rows) for (const cell of row) if (typeof cell === "string") names.push(cell);
  }
  return names;
}

async function main() {
  const leaders = await listTeamLeaders();
  const leader = leaders.find(l => l.name === "Fahad Mustafa") ?? leaders[0]!;
  const projects = await listActiveProjects();
  const project = projects[0]!;
  const today = new Date(`${karachiDate()}T00:00:00.000Z`);

  const admin = (await listUsers()).find(u => u.accountRole === "super_admin")!;
  const token = await createSessionToken(admin.openId, { name: admin.name ?? "admin" });

  // --- setup ---
  const userId = await insertUser({
    openId: "test-zz-remove-me", name: NAME_ACTIVE, email: "zz-remove-me-test@example.com",
    loginMethod: "email", passwordHash: null, role: "user", accountRole: "tester",
    phoneNumber: null, teamLeaderId: leader.id, regionId: leader.regionId ?? 1,
    emailVerified: 1, phoneVerified: 1, isVerified: 1, accountStatus: "active",
    createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
  } as any);
  const testerId = await insertTester({ name: NAME_ACTIVE, teamLeaderId: leader.id, status: "ACTIVE", regionId: leader.regionId ?? 1, dateAdded: new Date(), dateInactive: null, notes: "verify script" });
  await insertPerformance({ businessDate: today, testerId, teamLeaderId: leader.id, projectId: project.id, quantity: 5, source: "verify script", notes: null });
  const inactiveId = await insertTester({ name: NAME_INACTIVE, teamLeaderId: leader.id, status: "INACTIVE", regionId: leader.regionId ?? 1, dateAdded: new Date(), dateInactive: new Date(), notes: "verify script" });
  await insertPerformance({ businessDate: today, testerId: inactiveId, teamLeaderId: leader.id, projectId: project.id, quantity: 3, source: "verify script", notes: null });
  console.log(`setup: user=${userId} tester=${testerId} inactiveTester=${inactiveId} leader=${leader.id} project=${project.id}`);

  try {
    // --- before delete: active tester shows, inactive tester does not ---
    const before = await reportNames(token);
    const activeShows = before.includes(NAME_ACTIVE);
    const inactiveShows = before.includes(NAME_INACTIVE);
    console.log(`before delete: "${NAME_ACTIVE}" in report = ${activeShows} (want true); "${NAME_INACTIVE}" in report = ${inactiveShows} (want false)`);
    if (!activeShows) throw new Error("SETUP FAIL: active test tester did not appear in the report before deletion");
    if (inactiveShows) throw new Error("FAIL: INACTIVE tester still appears in the Excel report");

    // --- delete the user from the directory (the reported flow) ---
    const del = await trpc("userManagement.delete", token, { userId });
    console.log("userManagement.delete:", JSON.stringify(del));
    const rosterAfter = (await listTesters()).find(t => t.id === testerId);
    const userAfter = (await listUsers()).find(u => u.id === userId);
    console.log(`after delete: roster entry present = ${!!rosterAfter} (want false); user present = ${!!userAfter} (want false)`);
    if (rosterAfter) throw new Error("FAIL: roster tester entry survived the directory delete");
    if (userAfter) throw new Error("FAIL: user account survived the delete");

    // --- after delete: removed tester must be gone from the report too ---
    const after = await reportNames(token);
    const removedShows = after.includes(NAME_ACTIVE);
    const inactiveShowsAfter = after.includes(NAME_INACTIVE);
    console.log(`after delete: "${NAME_ACTIVE}" in report = ${removedShows} (want false); "${NAME_INACTIVE}" in report = ${inactiveShowsAfter} (want false)`);
    if (removedShows) throw new Error("FAIL: removed user still appears in the Excel report");
    if (inactiveShowsAfter) throw new Error("FAIL: INACTIVE tester still appears in the Excel report");
    console.log("PASS: removed user and inactive tester are both absent from the Excel report");
  } finally {
    // --- cleanup (best effort) ---
    await deletePerformanceByTester(testerId).catch(() => {});
    await deletePerformanceByTester(inactiveId).catch(() => {});
    const t = await getTester(testerId).catch(() => null);
    if (t) await deleteTester(testerId).catch(() => {});
    await deleteTester(inactiveId).catch(() => {});
    await deleteUser(userId).catch(() => {});
    console.log("cleanup done");
  }
}

main().catch(err => { console.error(err); process.exit(1); });
