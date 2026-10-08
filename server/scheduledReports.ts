import type { Request, Response } from "express";
import {
  getAppSettings,
  isDbConfigured,
  listActiveProjects,
  listPerformanceByDate,
  listRegions,
  listTeamLeaders,
  listTesters,
  listUsers,
  updateAppSettings,
} from "./db";
import { authenticateRequest } from "./_core/session";
import { buildReportWorkbook, deliverDailyReport, deliverReportTo, type ReportRow } from "./reportDelivery";

const karachiDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const toDate = (date: string) => new Date(`${date}T00:00:00.000Z`);

export async function compileDailyReport(date = karachiDate(), regionId?: number) {
  if (!isDbConfigured()) throw new Error("Database is unavailable");
  const [projectRows, allLeaders, allTesters, performance] = await Promise.all([
    listActiveProjects(),
    listTeamLeaders(),
    listTesters(),
    listPerformanceByDate(toDate(date)),
  ]);
  const leaderRows = regionId == null ? allLeaders : allLeaders.filter(l => l.regionId === regionId);
  const testerRows = regionId == null ? allTesters : allTesters.filter(t => t.regionId === regionId);
  const leaderIds = new Set(leaderRows.map(l => l.id));
  const testerIds = new Set(testerRows.map(t => t.id));
  const projectsById = new Map(projectRows.map(project => [project.id, project.name]));
  const leadersById = new Map(leaderRows.map(leader => [leader.id, leader.name]));
  const totals = new Map<string, Map<string, number>>();
  for (const tester of testerRows) {
    const leader = leadersById.get(tester.teamLeaderId) ?? "Unassigned";
    const key = `${leader}||${tester.name}`;
    totals.set(key, new Map());
  }
  for (const row of performance) {
    if (!testerIds.has(row.testerId)) continue;
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
      const role = user.accountRole;
      if (role !== "super_admin" && role !== "hq_admin" && role !== "admin" && user.role !== "admin") return res.status(403).json({ error: "admin-only" });
      context.taskUid = `manual:${user.id}`;
    }
    const report = await compileDailyReport();
    const settings = await getAppSettings();
    // Paused by admin: skip all report emails but keep the cron alive.
    if (settings.autoReportEnabled === 0) {
      return res.json({ ok: true, skipped: true, reason: "Daily auto-report is paused in Automation settings.", date: report.date });
    }
    // Honor the admin-configured report time: the deployment cron fires daily, but if the
    // configured time is far from "now" in the configured timezone, skip the send so a
    // mistimed manual hit doesn't blast a duplicate report. "Run now" in the app bypasses this.
    const nowParts = new Intl.DateTimeFormat("en-GB", { timeZone: settings.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
    const [nowH, nowM] = nowParts.split(":").map(Number);
    const [cfgH, cfgM] = settings.reportTime.split(":").map(Number);
    const driftMinutes = Math.abs((nowH! * 60 + nowM!) - (cfgH! * 60 + cfgM!));
    const fromCron = context.taskUid === "vercel-cron";
    if (fromCron && driftMinutes > 90) {
      return res.json({ ok: true, skipped: true, reason: `Configured report time is ${settings.reportTime} (${settings.timezone}); current time is ${nowParts}.`, date: report.date });
    }
    const delivery = await deliverDailyReport(report.date, report.workbook, report.summary);
    // Per-region reports: each region manager gets their region's Excel.
    // HQ admins and the super admin get the global report.
    const [regions, users] = await Promise.all([listRegions(), listUsers()]);
    const regionDeliveries: Array<{ region: string; recipient: string; channel: string }> = [];
    for (const region of regions.filter(r => r.status === "ACTIVE")) {
      const manager = users.find(u => u.accountRole === "manager" && u.regionId === region.id && u.accountStatus === "active" && u.email);
      if (!manager?.email) continue;
      try {
        const regionReport = await compileDailyReport(report.date, region.id);
        const result = await deliverReportTo(manager.email, report.date, regionReport.workbook, `${regionReport.summary}\n\nRegion: ${region.name}`, region.name);
        regionDeliveries.push({ region: region.name, recipient: manager.email, channel: result.channel });
      } catch (error) {
        regionDeliveries.push({ region: region.name, recipient: manager.email, channel: `failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    const globalRecipients = users.filter(u => (u.accountRole === "super_admin" || u.accountRole === "hq_admin") && u.accountStatus === "active" && u.email);
    const globalDeliveries: Array<{ recipient: string; channel: string }> = [];
    for (const recipient of globalRecipients) {
      if (!recipient.email || recipient.email === delivery.recipient) continue;
      try {
        const result = await deliverReportTo(recipient.email, report.date, report.workbook, `${report.summary}\n\nGlobal report — all regions.`, undefined);
        globalDeliveries.push({ recipient: recipient.email, channel: result.channel });
      } catch (error) {
        globalDeliveries.push({ recipient: recipient.email, channel: `failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    await updateAppSettings({ lastAutoReport: new Date().toISOString() });
    return res.json({ ok: true, date: report.date, rows: report.rows.length, grandTotal: report.grandTotal, delivery, regionDeliveries, globalDeliveries });
  } catch (error) {
    return res.status(500).json({ error: String(error), stack: error instanceof Error ? error.stack : undefined, context, timestamp: new Date().toISOString() });
  }
}
