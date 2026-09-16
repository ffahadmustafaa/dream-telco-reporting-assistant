import type { Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { dailyPerformance, getDb, projects, teamLeaders, testers } from "./db";
import { sdk } from "./_core/sdk";
import { buildReportWorkbook, deliverDailyReport, type ReportRow } from "./reportDelivery";

const karachiDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const toDate = (date: string) => new Date(`${date}T00:00:00.000Z`);

export async function compileDailyReport(date = karachiDate()) {
  const db = await getDb();
  if (!db) throw new Error("Database is unavailable");
  const [projectRows, leaderRows, testerRows, performance] = await Promise.all([
    db.select().from(projects).where(eq(projects.status, "ACTIVE")).orderBy(projects.id),
    db.select().from(teamLeaders).where(eq(teamLeaders.status, "ACTIVE")).orderBy(teamLeaders.id),
    db.select().from(testers).where(eq(testers.status, "ACTIVE")).orderBy(testers.id),
    db.select().from(dailyPerformance).where(and(eq(dailyPerformance.businessDate, toDate(date)))),
  ]);
  const projectsById = new Map(projectRows.map(project => [project.id, project.name]));
  const leadersById = new Map(leaderRows.map(leader => [leader.id, leader.name]));
  const totals = new Map<string, Map<string, number>>();
  for (const tester of testerRows) {
    const leader = leadersById.get(tester.teamLeaderId) ?? "Unassigned";
    const key = `${leader}||${tester.name}`;
    totals.set(key, new Map());
  }
  for (const row of performance) {
    const tester = testerRows.find(item => item.id === row.testerId);
    if (!tester) continue;
    const leader = leadersById.get(tester.teamLeaderId) ?? "Unassigned";
    const key = `${leader}||${tester.name}`;
    const values = totals.get(key) ?? new Map<string, number>();
    const project = projectsById.get(row.projectId);
    if (project) values.set(project, (values.get(project) ?? 0) + Number(row.quantity));
    totals.set(key, values);
  }
  const rows: ReportRow[] = Array.from(totals.entries()).map(([key, values]) => { const [leader, tester] = key.split("||"); return { leader: leader ?? "Unassigned", tester: tester ?? "Unknown", values: Object.fromEntries(projectRows.map(project => [project.name, values.get(project.name) ?? 0])), total: projectRows.reduce((sum, project) => sum + (values.get(project.name) ?? 0), 0) }; });
  const workbook = buildReportWorkbook(date, projectRows.map(project => project.name), rows);
  const grandTotal = rows.reduce((sum, row) => sum + row.total, 0);
  const summary = `Date: ${date}\nActive Team Leaders: ${leaderRows.length}\nActive Testers: ${testerRows.length}\nTester rows: ${rows.length}\nGrand Total OTP: ${grandTotal}`;
  return { date, projects: projectRows.map(project => project.name), rows, workbook, summary, grandTotal };
}

export async function scheduledDailyReport(req: Request, res: Response) {
  const context = { url: req.originalUrl, taskUid: undefined as string | undefined, timestamp: new Date().toISOString() };
  try {
    const user = await sdk.authenticateRequest(req);
    context.taskUid = user.taskUid;
    if (!user.isCron || !user.taskUid) return res.status(403).json({ error: "cron-only" });
    const report = await compileDailyReport();
    const delivery = await deliverDailyReport(report.date, report.workbook, report.summary);
    return res.json({ ok: true, date: report.date, rows: report.rows.length, grandTotal: report.grandTotal, delivery });
  } catch (error) {
    return res.status(500).json({ error: String(error), stack: error instanceof Error ? error.stack : undefined, context, timestamp: new Date().toISOString() });
  }
}
