import { config } from "dotenv";
config();
import { compileDailyReport } from "../server/scheduledReports";
async function main() {
  const report = await compileDailyReport();
  console.log(`Date: ${report.date}`);
  console.log(`Projects: ${JSON.stringify(report.projects)}`);
  console.log(`Rows: ${report.rows.length}`);
  console.log(`Grand total: ${report.grandTotal}`);
  console.log(`Summary: ${report.summary.replace(/\n/g, " | ")}`);
  if (report.rows.length > 0) console.log("First row:", JSON.stringify(report.rows[0]));
}
main().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
