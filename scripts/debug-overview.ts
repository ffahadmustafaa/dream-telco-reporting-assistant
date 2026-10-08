import { config } from "dotenv";
config();
import { getUserByEmail } from "../server/db";
// Simulate the overview filtering logic for each role
import { listTeamLeaders, listTesters, listProjects, listPerformanceByDate, getWorkspaceData } from "../server/db";

async function testUser(email: string) {
  const user = await getUserByEmail(email);
  if (!user) { console.log(`${email}: NOT FOUND`); return; }
  console.log(`\n${email}: accountRole=${user.accountRole}, regionId=${user.regionId}`);
  const today = new Date().toISOString().split("T")[0]!;
  let data = await getWorkspaceData(new Date(`${today}T00:00:00.000Z`));
  console.log(`  Before filter: projects=${data.projects.length}, testers=${data.testers.length}, leaders=${data.leaders.length}`);
}

async function main() {
  await testUser("ffahadmustafaa@gmail.com");
  await testUser("hqall01@gmail.com");
  await testUser("regiona01@gmail.com");
}
main().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
