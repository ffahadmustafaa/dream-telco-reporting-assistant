import * as XLSX from "xlsx";
import { notifyOwner } from "./_core/notification";

export type ReportRow = { leader: string; tester: string; values: Record<string, number>; total: number };

const reportEmail = process.env.REPORT_EMAIL_TO ?? "ffahadmustafaa@gmail.com";
const reportFrom = process.env.REPORT_EMAIL_FROM ?? "Dream Telco Reports <reports@example.com>";

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
  const headerStyle = { fill: { fgColor: { rgb: "9FC5E8" } }, font: { bold: true, color: { rgb: "000000" } }, alignment: { horizontal: "center" } };
  const leaderStyle = { fill: { fgColor: { rgb: "C6E0B4" } }, font: { bold: true, color: { rgb: "000000" } } };
  const totalStyle = { fill: { fgColor: { rgb: "B4C6E7" } }, font: { bold: true, color: { rgb: "0F172A" } } };
  for (let column = 0; column < matrix[0]!.length; column++) { const cell = sheet[XLSX.utils.encode_cell({ r: 0, c: column })] as any; if (cell) cell.s = headerStyle; }
  let rowIndex = 1; for (const leader of leaders) { const group = rows.filter(row => row.leader === leader); for (let column = 0; column < matrix[0]!.length; column++) { const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: column })] as any; if (cell) cell.s = leaderStyle; } rowIndex += group.length + 1; }
  for (let column = 0; column < matrix[0]!.length; column++) { const cell = sheet[XLSX.utils.encode_cell({ r: matrix.length - 1, c: column })] as any; if (cell) cell.s = totalStyle; }
  sheet["!cols"] = [{ wch: 24 }, ...projects.map(() => ({ wch: 14 })), { wch: 14 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Daily Report");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows.map(row => ({ Date: date, "Team Leader": row.leader, Tester: row.tester, ...row.values, Total: row.total }))), "Raw Data");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export async function deliverDailyReport(date: string, workbook: Buffer, summary: string) {
  const provider = process.env.REPORT_EMAIL_PROVIDER?.toLowerCase();
  const apiKey = process.env.REPORT_EMAIL_API_KEY;
  if (provider === "resend" && apiKey) {
    const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: reportFrom, to: [reportEmail], subject: `Daily Operations & OTP Report - ${date}`, text: summary, attachments: [{ filename: `Daily_Operations_Report_${date}.xlsx`, content: workbook.toString("base64") }] }) });
    if (!response.ok) throw new Error(`Report email provider failed (${response.status})`);
    return { channel: "email" as const, recipient: reportEmail };
  }
  const notified = await notifyOwner({ title: `Daily Operations & OTP Report - ${date}`, content: `${summary}\n\nEmail attachment delivery is not configured. Set REPORT_EMAIL_PROVIDER=resend, REPORT_EMAIL_API_KEY, and REPORT_EMAIL_FROM to enable direct email attachments.` });
  return { channel: notified ? "owner_notification" as const : "unconfigured" as const, recipient: reportEmail };
}

export function reportDeliveryConfig() {
  return { provider: process.env.REPORT_EMAIL_PROVIDER ?? "owner notification fallback", recipient: reportEmail, emailConfigured: Boolean(process.env.REPORT_EMAIL_API_KEY && process.env.REPORT_EMAIL_PROVIDER) };
}
