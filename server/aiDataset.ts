/**
 * Spreadsheet upload + natural-language Q&A for the AI assistant.
 *
 * Accepts an XLSX/CSV file (base64), parses every sheet into rows, and
 * answers questions like "total work by Bisma" or "who did the most" over
 * the uploaded data — no database changes required. Parsed datasets are
 * persisted in the `imports` table (rawData = JSON) so questions can be
 * asked later in the same session.
 */
import * as XLSX from "xlsx";

export type DatasetRow = Record<string, string | number>;
export type DatasetSheet = { name: string; rows: DatasetRow[] };

const norm = (s: unknown) => String(s ?? "").toLowerCase().trim().replace(/\s+/g, " ");
const title = (s: unknown) =>
  norm(s)
    .split(" ")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
const fmt = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n || 0);

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const raw = String(v ?? "").replace(/,/g, "").trim();
  if (!raw) return null;
  // Slash notation "120/120" sums the parts.
  if (raw.includes("/")) {
    const parts = raw.split("/").map((p) => Number(p.trim()));
    if (parts.every((p) => Number.isFinite(p) && p >= 0)) return parts.reduce((a, b) => a + b, 0);
    return null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function parseWorkbook(buffer: Buffer, fileName: string): DatasetSheet[] {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheets: DatasetSheet[] = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name]!;
    const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    const rows: DatasetRow[] = json.map((r) => {
      const out: DatasetRow = {};
      for (const [k, v] of Object.entries(r)) {
        const num = toNumber(v);
        out[String(k).trim()] = num != null && String(v).trim() !== "" ? num : String(v ?? "").trim();
      }
      return out;
    });
    if (rows.length) sheets.push({ name, rows });
  }
  if (!sheets.length) throw new Error(`No data rows found in ${fileName}.`);
  return sheets;
}

type ColumnRole = { nameCols: string[]; numericCols: string[] };

function detectColumns(rows: DatasetRow[]): ColumnRole {
  const keys = Object.keys(rows[0] ?? {});
  const nameCols = keys.filter((k) => /name|tester|member|user|employee/i.test(k));
  const numericCols = keys.filter((k) => {
    if (/name|tester|member|user|date|day|team|leader|project/i.test(k)) return false;
    return rows.some((r) => typeof r[k] === "number" && (r[k] as number) !== 0);
  });
  return { nameCols: nameCols.length ? nameCols : keys.slice(0, 1), numericCols };
}

function projectCols(rows: DatasetRow[]): string[] {
  const keys = Object.keys(rows[0] ?? {});
  return keys.filter((k) => {
    const n = norm(k);
    return (n.includes("section") || n.includes("super") || n.includes("inception") || n.includes("project") || n.includes("otp")) && rows.some((r) => typeof r[k] === "number");
  });
}

/** One-paragraph summary of an uploaded dataset, shown right after upload. */
export function summarizeDataset(sheets: DatasetSheet[]): string {
  const parts: string[] = [];
  for (const sheet of sheets) {
    const { nameCols, numericCols } = detectColumns(sheet.rows);
    const nameCol = nameCols[0]!;
    const pCols = projectCols(sheet.rows);
    const valueCols = pCols.length ? pCols : numericCols;
    const grand = sheet.rows.reduce(
      (s, r) => s + valueCols.reduce((a, c) => a + (typeof r[c] === "number" ? (r[c] as number) : 0), 0),
      0
    );
    const lines = [`Sheet "${sheet.name}": ${sheet.rows.length} rows`];
    if (nameCol) lines.push(`names in "${nameCol}"`);
    if (valueCols.length) lines.push(`${valueCols.map((c) => `"${c}"`).join(", ")} → grand total ${fmt(grand)}`);
    parts.push(lines.join(", ") + ".");
  }
  return parts.join(" ");
}

function totalsByName(rows: DatasetRow[], nameCol: string, valueCols: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of rows) {
    const name = title(r[nameCol]);
    if (!name) continue;
    const total = valueCols.reduce((a, c) => a + (typeof r[c] === "number" ? (r[c] as number) : 0), 0);
    map.set(name, (map.get(name) ?? 0) + total);
  }
  return map;
}

/**
 * Answer a natural-language question over parsed sheets.
 * Returns null when the question is not recognized.
 */
export function answerDatasetQuestion(question: string, sheets: DatasetSheet[]): string | null {
  const low = norm(question);
  const answers: string[] = [];

  for (const sheet of sheets) {
    const { nameCols, numericCols } = detectColumns(sheet.rows);
    const nameCol = nameCols[0];
    if (!nameCol) continue;
    const pCols = projectCols(sheet.rows);
    const valueCols = pCols.length ? pCols : numericCols;
    if (!valueCols.length) continue;
    const totals = totalsByName(sheet.rows, nameCol, valueCols);

    // "total work by Bisma" / "how much did Ali do"
    const m = low.match(/(?:total|how much).*?(?:by|for|did)\s+([a-z][a-z ]+)/) || low.match(/^([a-z][a-z ]+?)(?:'s)?\s+(?:total|report)/);
    if (m) {
      const needle = norm(m[1]!);
      const hit = Array.from(totals.entries()).find(([name]) => norm(name) === needle);
      if (hit) answers.push(`${hit[0]}: ${fmt(hit[1])} (sheet "${sheet.name}").`);
      continue;
    }

    // "who did the most" / "top 5"
    if (/top|most|best|leaderboard|highest/.test(low)) {
      const ranked = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);
      if (ranked.length) answers.push(`Top in "${sheet.name}": ` + ranked.map(([n, v], i) => `${i + 1}. ${n} — ${fmt(v)}`).join(", ") + ".");
      continue;
    }

    // "grand total" / "total otps"
    if (/grand total|^total|overall/.test(low)) {
      const grand = Array.from(totals.values()).reduce((a, b) => a + b, 0);
      answers.push(`Grand total in "${sheet.name}": ${fmt(grand)}.`);
      continue;
    }

    // "Section X vs Super X" — per project column totals
    if (/ vs |versus|compare|breakdown|by project/.test(low) && pCols.length >= 2) {
      const parts = pCols.map((c) => {
        const t = sheet.rows.reduce((s, r) => s + (typeof r[c] === "number" ? (r[c] as number) : 0), 0);
        return `${c}: ${fmt(t)}`;
      });
      answers.push(`"${sheet.name}" — ` + parts.join(" vs ") + ".");
      continue;
    }
  }

  return answers.length ? answers.join(" ") : null;
}
