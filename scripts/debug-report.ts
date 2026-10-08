import { config } from "dotenv";
config();
import { listActiveProjects, listTeamLeaders, listTesters, listPerformanceByDate, getWorkspaceData } from "../server/db";
async function main() {
  const projects = await listActiveProjects();
  console.log(`Active projects: ${projects.length}`, projects.map(p => p.name));
  const leaders = await listTeamLeaders();
  console.log(`Team leaders: ${leaders.length}`);
  const testers = await listTesters();
  console.log(`Testers: ${testers.length}`);
  const today = new Date().toISOString().split("T")[0]!;
  const perf = await listPerformanceByDate(new Date(`${today}T00:00:00.000Z`));
  console.log(`Performance today (${today}): ${perf.length}`);
  const ws = await getWorkspaceData(new Date(`${today}T00:00:00.000Z`));
  console.log(`WorkspaceData: projects=${ws.projects.length}, leaders=${ws.leaders.length}, testers=${ws.testers.length}, performance=${ws.performance.length}`);
}
main().catch(e => { console.error(e.message); process.exit(1); });
