/**
 * Multi-region migration (one-time):
 * 1. Create regions Central A, B, C with invite codes.
 * 2. Move all existing roster team leaders/testers to Central A.
 * 3. Move all existing team_leader/tester users to Central A.
 * 4. Promote ffahadmustafaa@gmail.com to super_admin.
 *
 * Usage: ./node_modules/.bin/tsx scripts/migrate-regions.ts
 * Requires .env with Firebase credentials. Safe to re-run (idempotent).
 */
import { config } from "dotenv";
config();

import {
  listRegions,
  insertRegion,
  generateInviteCode,
  listTeamLeaders,
  updateTeamLeader,
  listTesters,
  updateTester,
  listUsers,
  updateUser,
  getUserByEmail,
  isDbConfigured,
} from "../server/db";

async function main() {
  if (!isDbConfigured()) throw new Error("Database is not configured. Check .env.");

  // 1. Regions
  const existing = await listRegions();
  const byCode = new Map(existing.map(r => [r.code.toUpperCase(), r]));
  const defs = [
    { name: "Central A", code: "A" },
    { name: "Central B", code: "B" },
    { name: "Central C", code: "C" },
  ];
  const regionIds: Record<string, number> = {};
  for (const def of defs) {
    const found = byCode.get(def.code);
    if (found) {
      regionIds[def.code] = found.id;
      console.log(`Region exists: ${found.name} (id ${found.id}) invite=${found.inviteCode}`);
    } else {
      const id = await insertRegion({ name: def.name, code: def.code, inviteCode: generateInviteCode(def.code) });
      regionIds[def.code] = id;
      const created = (await listRegions()).find(r => r.id === id)!;
      console.log(`Region created: ${def.name} (id ${id}) invite=${created.inviteCode}`);
    }
  }
  const regionA = regionIds["A"]!;

  // 2. Roster team leaders -> Central A (only those without a region)
  const leaders = await listTeamLeaders();
  let leadersMoved = 0;
  for (const leader of leaders) {
    if (leader.regionId == null) {
      await updateTeamLeader(leader.id, { regionId: regionA });
      leadersMoved++;
    }
  }
  console.log(`Team leaders moved to Central A: ${leadersMoved}/${leaders.length}`);

  // 3. Roster testers -> Central A (only those without a region)
  const testers = await listTesters();
  let testersMoved = 0;
  for (const tester of testers) {
    if (tester.regionId == null) {
      await updateTester(tester.id, { regionId: regionA });
      testersMoved++;
    }
  }
  console.log(`Testers moved to Central A: ${testersMoved}/${testers.length}`);

  // 4. Users (team_leader/tester roles) -> Central A; promote owner to super_admin
  const users = await listUsers();
  let usersMoved = 0;
  for (const user of users) {
    const patch: Record<string, unknown> = {};
    if ((user.accountRole === "team_leader" || user.accountRole === "tester") && user.regionId == null) {
      patch.regionId = regionA;
    }
    if (user.email?.toLowerCase() === "ffahadmustafaa@gmail.com") {
      patch.accountRole = "super_admin";
      patch.regionId = null;
    }
    if (Object.keys(patch).length) {
      await updateUser(user.id, patch as Parameters<typeof updateUser>[1]);
      usersMoved++;
    }
  }
  console.log(`Users updated (region + super_admin promotion): ${usersMoved}/${users.length}`);

  const owner = await getUserByEmail("ffahadmustafaa@gmail.com");
  console.log(`Owner account: ${owner?.email} role=${owner?.accountRole}`);

  console.log("Migration complete.");
}

main().catch(err => { console.error("Migration failed:", err.message); process.exit(1); });
