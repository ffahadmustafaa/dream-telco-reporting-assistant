import type { Request, Response } from "express";
import {
  isDbConfigured,
  listActiveProjects,
  listPerformanceByDate,
  listTeamLeaders,
  listTesters,
} from "./db";
import { authenticateRequest } from "./_core/session";
import { buildReportWorkbook, deliverDailyReport, type ReportRow } from "./reportDelivery";

const karachiDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const toDate = (date: string) => new Date(`${date}T00:00:00.000Z`);

export async function compileDailyReport(date = karachiDate()) {
  if (!isDbConfigured()) throw new Error("Database is unavailable");
  const [projectRows, leaderRows, testerRows, performance] = await Promise.all([
    listActiveProjects(),
    listTeamLeaders(),
    listTesters(),
    listPerformanceByDate(toDate(date)),
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
  const summary = `Date: ${date}\nTeam Leaders: ${leaderRows.length}\nRoster Testers (including inactive): ${testerRows.length}\nTester rows: ${rows.length}\nGrand Total OTP: ${grandTotal}`;
  return { date, projects: projectRows.map(project => project.name), rows, workbook, summary, grandTotal };
}

export async function scheduledDailyReport(req: Request, res: Response) {
  const context = { url: req.originalUrl, taskUid: undefined as string | undefined, timestamp: new Date().toISOString() };
  try {
    const cronSecret = process.env.REPORT_CRON_SECRET ?? process.env.CRON_SECRET;
    const bearer = req.headers.authorization ?? "";
    if (cronSecret && bearer === `Bearer ${cronSecret}`) {
      context.taskUid = "vercel-cron";
    } else {
      // Fallback: an authenticated admin session may trigger the report manually.
      const user = await authenticateRequest(req);
      if (user.accountRole !== "admin" && user.role !== "admin") return res.status(403).json({ error: "admin-only" });
      context.taskUid = `manual:${user.id}`;
    }
    const report = await compileDailyReport();
    const delivery = await deliverDailyReport(report.date, report.workbook, report.summary);
    return res.json({ ok: true, date: report.date, rows: report.rows.length, grandTotal: report.grandTotal, delivery });
  } catch (error) {
    return res.status(500).json({ error: String(error), stack: error instanceof Error ? error.stack : undefined, context, timestamp: new Date().toISOString() });
  }
}
