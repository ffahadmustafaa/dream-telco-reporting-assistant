import { createRequire } from "module";
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const XLSX = require("xlsx-js-style");
import { notifyOwner } from "./_core/notification";
import { getAppSettings } from "./db";

export type ReportRow = { leader: string; tester: string; values: Record<string, number>; total: number };

export type SmtpDeliveryConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
};

const envReportEmail = process.env.REPORT_EMAIL_TO ?? "ffahadmustafaa@gmail.com";
const envReportFrom = process.env.REPORT_EMAIL_FROM ?? "Dream Telco Reports <reports@example.com>";

/** Delivery settings resolved from the in-app automation settings (admin-configured). */
export async function resolveReportDelivery(): Promise<{ to: string; smtp: SmtpDeliveryConfig | null }> {
  try {
    const settings = await getAppSettings();
    const smtp =
      settings.smtpHost && settings.smtpUser && settings.smtpPass
        ? {
            host: settings.smtpHost,
            port: settings.smtpPort || 587,
            secure: settings.smtpSecure === 1,
            user: settings.smtpUser,
            pass: settings.smtpPass,
            from: settings.smtpFrom || settings.smtpUser,
          }
        : null;
    return { to: settings.adminEmail || envReportEmail, smtp };
  } catch {
    return { to: envReportEmail, smtp: null };
  }
}

async function sendViaSmtp(smtp: SmtpDeliveryConfig, to: string, subject: string, text: string, attachment?: { filename: string; content: Buffer }) {
  const { default: nodemailer } = await import("nodemailer");
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: { user: smtp.user, pass: smtp.pass },
  });
  await transporter.sendMail({
    from: smtp.from,
    to,
    subject,
    text,
    attachments: attachment ? [{ filename: attachment.filename, content: attachment.content }] : [],
  });
}

export function buildReportWorkbook(date: string, projects: string[], rows: ReportRow[]) {
  const matrix: Array<Array<string | number>> = [["Project", ...projects, "Total"]];
  const leaders = Array.from(new Set(rows.map(row => row.leader)));
  for (const leader of leaders) {
    const group = rows.filter(row => row.leader === leader);
    matrix.push([leader, ...projects.map(project => group.reduce((sum, row) => sum + (row.values[project] ?? 0), 0)), group.reduce((sum, row) => sum + row.total, 0)]);
    for (const row of group) matrix.push([row.tester, ...projects.map(project => row.values[project] ?? 0), row.total]);
  }
  matrix.push(["Grand Total", ...projects.map(project => rows.reduce((sum, row) => sum + (row.values[project] ?? 0), 0)), rows.reduce((sum, row) => sum + row.total, 0)]);
  const sheet = XLSX.utils.aoa_to_sheet(matrix);
  const headerStyle = { fill: { fgColor: { rgb: "D9E1F2" } }, font: { bold: true, color: { rgb: "000000" } }, alignment: { horizontal: "center" } };
  const leaderStyle = { fill: { fgColor: { rgb: "D9EAD3" } }, font: { bold: true, color: { rgb: "000000" } } };
  const totalStyle = { fill: { fgColor: { rgb: "B4C6E7" } }, font: { bold: true, color: { rgb: "0F172A" } } };
  for (let column = 0; column < matrix[0]!.length; column++) { const cell = sheet[XLSX.utils.encode_cell({ r: 0, c: column })] as any; if (cell) cell.s = headerStyle; }
  let rowIndex = 1; for (const leader of leaders) { const group = rows.filter(row => row.leader === leader); for (let column = 0; column < matrix[0]!.length; column++) { const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: column })] as any; if (cell) cell.s = leaderStyle; } rowIndex += group.length + 1; }
  for (let column = 0; column < matrix[0]!.length; column++) { const cell = sheet[XLSX.utils.encode_cell({ r: matrix.length - 1, c: column })] as any; if (cell) cell.s = totalStyle; }
  sheet["!cols"] = [{ wch: 24 }, ...projects.map(() => ({ wch: 14 })), { wch: 14 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Daily Report");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows.map(row => ({ Date: date, "Team Leader": row.leader, Tester: row.tester, ...row.values, Total: row.total }))), "Raw Data");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx", cellStyles: true }) as Buffer;
}

export async function deliverDailyReport(date: string, workbook: Buffer, summary: string) {
  const delivery = await resolveReportDelivery();
  const subject = `Daily Operations & OTP Report - ${date}`;
  const filename = `Daily_Operations_Report_${date}.xlsx`;

  // 1) In-app SMTP settings (configured by the admin under Automation).
  if (delivery.smtp) {
    await sendViaSmtp(delivery.smtp, delivery.to, subject, summary, { filename, content: workbook });
    return { channel: "smtp" as const, recipient: delivery.to };
  }

  // 2) Resend via environment (legacy).
  const provider = process.env.REPORT_EMAIL_PROVIDER?.toLowerCase();
  const apiKey = process.env.REPORT_EMAIL_API_KEY;
  if (provider === "resend" && apiKey) {
    const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: envReportFrom, to: [delivery.to], subject, text: summary, attachments: [{ filename, content: workbook.toString("base64") }] }) });
    if (!response.ok) throw new Error(`Report email provider failed (${response.status})`);
    return { channel: "email" as const, recipient: delivery.to };
  }
  const notified = await notifyOwner({ title: subject, content: `${summary}\n\nEmail attachment delivery is not configured. Open the app as admin → Automation and add SMTP settings to enable direct email attachments.` });
  return { channel: notified ? "owner_notification" as const : "unconfigured" as const, recipient: delivery.to };
}

export function reportDeliveryConfig() {
  return { provider: process.env.REPORT_EMAIL_PROVIDER ?? "owner notification fallback", recipient: envReportEmail, emailConfigured: Boolean(process.env.REPORT_EMAIL_API_KEY && process.env.REPORT_EMAIL_PROVIDER) };
}

/** Delivery status for the Automation page (never exposes the SMTP password). */
export async function reportAutomationStatus() {
  const settings = await getAppSettings();
  const delivery = await resolveReportDelivery();
  return {
    recipient: delivery.to,
    smtpConfigured: Boolean(delivery.smtp),
    smtpHost: settings.smtpHost,
    resendConfigured: Boolean(process.env.REPORT_EMAIL_PROVIDER && process.env.REPORT_EMAIL_API_KEY),
    lastAutoReport: settings.lastAutoReport,
  };
}

/** Send a plain-text email through the configured Resend provider. Throws when unconfigured. */
export async function sendSimpleEmail(to: string, subject: string, text: string) {
  const provider = process.env.REPORT_EMAIL_PROVIDER?.toLowerCase();
  const apiKey = process.env.REPORT_EMAIL_API_KEY;
  if (provider !== "resend" || !apiKey) throw new Error("Email delivery is not configured (set REPORT_EMAIL_PROVIDER=resend and REPORT_EMAIL_API_KEY).");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: envReportFrom, to: [to], subject, text }),
  });
  if (!response.ok) throw new Error(`Email provider failed (${response.status})`);
}
