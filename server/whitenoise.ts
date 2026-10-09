/**
 * Whitenoise.one SMS gateway scraper + OTP analytics.
 *
 * The whitenoise account has no API, so this module logs in with plain HTTP
 * (the site is server-rendered HTML with form-based filtering) and parses
 * the SMS log table. A manual SMS-log upload fallback exists for when the
 * site blocks automated logins or has no data.
 */

const WN_BASE = "https://whitenoise.one";
const WN_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface WnConfig {
  email: string | null;
  hasPassword: boolean;
  hasApiKey: boolean;
}

const WN_API_BASE = "https://api.whitenoise.one";

export interface WnRosterRow {
  tester: string;
  teamLeader: string;
  number: string;
}

// ---------------------------------------------------------------------------
// Firestore persistence (credentials + saved roster)
// ---------------------------------------------------------------------------

import { getFirestoreDb } from "./firebase";

const WN_CONFIG_DOC = "whitenoise_config";
const WN_ROSTER_DOC = "whitenoise_roster";

export async function getWhitenoiseConfig(): Promise<WnConfig & { password: string | null; apiKey: string | null }> {
  const db = getFirestoreDb();
  if (!db) return { email: null, hasPassword: false, hasApiKey: false, password: null, apiKey: null };
  const snap = await db.collection(WN_CONFIG_DOC).doc("1").get();
  const data = snap.exists ? (snap.data() as Record<string, unknown>) : {};
  const password = typeof data.password === "string" ? data.password : null;
  const apiKey = typeof data.apiKey === "string" ? data.apiKey : null;
  return {
    email: typeof data.email === "string" ? data.email : null,
    hasPassword: !!password,
    hasApiKey: !!apiKey,
    password,
    apiKey,
  };
}

export async function saveWhitenoiseCredentials(email: string, password: string, apiKey?: string): Promise<void> {
  const db = getFirestoreDb();
  if (!db) throw new Error("Database is unavailable");
  const update: Record<string, unknown> = { email: email.trim(), password, updatedAt: new Date() };
  if (apiKey !== undefined) update.apiKey = apiKey.trim();
  await db.collection(WN_CONFIG_DOC).doc("1").set(update, { merge: true });
}

/**
 * Reserve a virtual number via the whitenoise API.
 * POST/GET https://api.whitenoise.one/exe/start?api_key=KEY&phone=NUMBER&service=SERVICE
 * Returns "Execution started" on success, or an error message.
 */
export async function reserveWhitenoiseNumber(apiKey: string, phone: string, service: string): Promise<{ ok: boolean; message: string }> {
  const params = new URLSearchParams({ api_key: apiKey, phone: phone.trim(), service: service.trim() });
  const res = await fetch(`${WN_API_BASE}/exe/start?${params.toString()}`, {
    headers: { "User-Agent": WN_UA },
  });
  const text = await res.text();
  try {
    const data = JSON.parse(text) as { status?: string; message?: string };
    return { ok: data.status === "OK", message: data.message ?? text.slice(0, 200) };
  } catch {
    return { ok: false, message: text.slice(0, 200) };
  }
}

export async function getWhitenoiseRoster(): Promise<WnRosterRow[]> {
  const db = getFirestoreDb();
  if (!db) return [];
  const snap = await db.collection(WN_ROSTER_DOC).doc("1").get();
  if (!snap.exists) return [];
  const rows = (snap.data() as Record<string, unknown>).rows;
  return Array.isArray(rows) ? (rows as WnRosterRow[]) : [];
}

export async function saveWhitenoiseRoster(rows: WnRosterRow[]): Promise<{ saved: number }> {
  const db = getFirestoreDb();
  if (!db) throw new Error("Database is unavailable");
  const clean = rows
    .filter((r) => r && String(r.number ?? "").trim() && String(r.tester ?? "").trim())
    .map((r) => ({
      tester: String(r.tester).trim(),
      teamLeader: String(r.teamLeader ?? "").trim(),
      number: String(r.number).trim(),
    }));
  await db.collection(WN_ROSTER_DOC).doc("1").set({ rows: clean, updatedAt: new Date() });
  return { saved: clean.length };
}

export interface WnSmsRecord {
  service: string;
  source: string;
  destination: string;
  smsc: string;
  text: string;
  timeSent: string;
  timeReceived: string;
}

/** Normalize a phone number to digits only for matching. */
export function normalizeNumber(value: string | null | undefined): string {
  return String(value ?? "").replace(/\D/g, "");
}

/** Login to whitenoise and return the session cookie header value. */
export async function whitenoiseLogin(email: string, password: string): Promise<string> {
  const jar: Record<string, string> = {};
  // Prime the session with a GET first (site sets APPSID on every visit).
  const prime = await fetch(`${WN_BASE}/`, { headers: { "User-Agent": WN_UA }, redirect: "manual" });
  for (const c of prime.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const [k, ...v] = pair.split("=");
    jar[k.trim()] = v.join("=").trim();
  }
  const cookieStr = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");

  const res = await fetch(`${WN_BASE}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": WN_UA,
      Cookie: cookieStr(),
      Referer: `${WN_BASE}/`,
      Origin: WN_BASE,
    },
    body: new URLSearchParams({ email, password }),
    redirect: "manual",
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const [k, ...v] = pair.split("=");
    jar[k.trim()] = v.join("=").trim();
  }
  // Verify login by fetching the SMS page and checking for the logout link.
  const check = await fetch(`${WN_BASE}/sms`, {
    headers: { "User-Agent": WN_UA, Cookie: cookieStr() },
    redirect: "manual",
  });
  const html = await check.text();
  if (!html.includes("/user/logout")) {
    throw new Error("Whitenoise login failed. The site may be rate-limiting automated logins — try the manual SMS upload instead.");
  }
  return cookieStr();
}

/** Fetch one page of the SMS log HTML. */
async function fetchSmsPage(
  cookie: string,
  params: { smsTo?: string; dateFrom?: string; dateTo?: string; page?: number },
): Promise<string> {
  const q = new URLSearchParams();
  if (params.smsTo) q.set("sms_to", params.smsTo);
  q.set("dup", "1");
  if (params.dateFrom) q.set("sms_time_start", params.dateFrom);
  if (params.dateTo) q.set("sms_time_end", params.dateTo);
  q.set("order", "id:desc");
  if (params.page && params.page > 1) q.set("page", String(params.page));
  const res = await fetch(`${WN_BASE}/sms?${q.toString()}`, {
    headers: { "User-Agent": WN_UA, Cookie: cookie },
    redirect: "manual",
  });
  if (res.status !== 200) throw new Error(`Whitenoise SMS page returned HTTP ${res.status}`);
  return res.text();
}

/** Extract the "X - Y of Z" total from the page. */
function parseTotal(html: string): number {
  const m = html.match(/(\d+)\s*-\s*(\d+)\s+of\s+(\d+)/);
  return m ? Number(m[3]) : 0;
}

/**
 * Parse SMS rows from the whitenoise HTML table.
 * Columns: # | (actions) | (actions) | Service | Source | Destination | SMSC | Text | Time sent | Time received | (actions)
 */
export function parseSmsTable(html: string): WnSmsRecord[] {
  const records: WnSmsRecord[] = [];
  // Find all table rows; data rows contain <td> cells.
  const rowMatches = html.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) ?? [];
  for (const rowHtml of rowMatches) {
    const cellMatches = Array.from(rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi));
    if (cellMatches.length < 10) continue;
    const text = (i: number) =>
      (cellMatches[i]?.[1] ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
    const destination = text(5);
    // Skip header/empty rows.
    if (!destination || /destination/i.test(destination)) continue;
    records.push({
      service: text(3),
      source: text(4),
      destination,
      smsc: text(6),
      text: text(7),
      timeSent: text(8),
      timeReceived: text(9),
    });
  }
  return records;
}

/**
 * Fetch SMS records from whitenoise for a date range, optionally filtered
 * to a set of destination numbers. Returns deduplicated records.
 */
export async function fetchWhitenoiseSms(
  email: string,
  password: string,
  opts: { dateFrom: string; dateTo: string; numbers?: string[] },
): Promise<WnSmsRecord[]> {
  const cookie = await whitenoiseLogin(email, password);
  const all: WnSmsRecord[] = [];
  const seen = new Set<string>();

  const push = (recs: WnSmsRecord[]) => {
    for (const r of recs) {
      const key = `${r.destination}|${r.timeReceived}|${r.text}`;
      if (!seen.has(key)) {
        seen.add(key);
        all.push(r);
      }
    }
  };

  if (opts.numbers && opts.numbers.length > 0) {
    // Per-number queries (exact match on whitenoise side), small concurrency.
    const queue = [...opts.numbers];
    const workers = Array.from({ length: 5 }, async () => {
      while (queue.length) {
        const num = queue.shift()!;
        const html = await fetchSmsPage(cookie, { smsTo: num, dateFrom: opts.dateFrom, dateTo: opts.dateTo });
        push(parseSmsTable(html));
      }
    });
    await Promise.all(workers);
  } else {
    // Whole-range fetch with pagination.
    let page = 1;
    for (;;) {
      const html = await fetchSmsPage(cookie, { dateFrom: opts.dateFrom, dateTo: opts.dateTo, page });
      const recs = parseSmsTable(html);
      push(recs);
      const total = parseTotal(html);
      if (recs.length === 0 || all.length >= total || page > 200) break;
      page++;
    }
  }
  return all;
}

/** Date (YYYY-MM-DD) → whitenoise range format start: YYYY-MM-DD.00.00 */
export function wnRangeStart(date: string): string {
  return `${date}.00.00`;
}
/** Date (YYYY-MM-DD) → whitenoise range format end: YYYY-MM-DD.23.59 */
export function wnRangeEnd(date: string): string {
  return `${date}.23.59`;
}

export interface OtpPerNumber {
  tester: string;
  teamLeader: string;
  number: string;
  total: number;
  byApp: Array<{ app: string; count: number }>;
}

export interface AppUsage {
  app: string;
  count: number;
}

export interface TesterTotal {
  tester: string;
  teamLeader: string;
  total: number;
}

/**
 * Match SMS records against the roster and compute all three report views.
 */
export function analyzeOtp(
  roster: WnRosterRow[],
  sms: WnSmsRecord[],
): { perNumber: OtpPerNumber[]; appUsage: AppUsage[]; testerTotals: TesterTotal[] } {
  // Index SMS by normalized destination number.
  const byNumber = new Map<string, WnSmsRecord[]>();
  for (const r of sms) {
    const key = normalizeNumber(r.destination);
    if (!key) continue;
    const list = byNumber.get(key) ?? [];
    list.push(r);
    byNumber.set(key, list);
  }

  const perNumber: OtpPerNumber[] = roster.map((row) => {
    const recs = byNumber.get(normalizeNumber(row.number)) ?? [];
    const appCounts = new Map<string, number>();
    for (const r of recs) {
      const app = r.service?.trim() || "Unknown";
      appCounts.set(app, (appCounts.get(app) ?? 0) + 1);
    }
    return {
      tester: row.tester,
      teamLeader: row.teamLeader,
      number: row.number,
      total: recs.length,
      byApp: Array.from(appCounts.entries())
        .map(([app, count]) => ({ app, count }))
        .sort((a, b) => b.count - a.count),
    };
  });

  const appTotals = new Map<string, number>();
  for (const r of sms) {
    const app = r.service?.trim() || "Unknown";
    appTotals.set(app, (appTotals.get(app) ?? 0) + 1);
  }
  const appUsage: AppUsage[] = Array.from(appTotals.entries())
    .map(([app, count]) => ({ app, count }))
    .sort((a, b) => b.count - a.count);

  const testerTotals: TesterTotal[] = perNumber.map((p) => ({
    tester: p.tester,
    teamLeader: p.teamLeader,
    total: p.total,
  }));

  return { perNumber, appUsage, testerTotals };
}

/**
 * Parse a manually uploaded SMS log. Accepts rows as arrays (from an Excel
 * sheet) or tab/comma-separated text. Expected columns (any order, matched
 * by header name): service/app, source, destination/number, smsc, text,
 * time sent, time received. Headers are optional — falls back to positional:
 * [service, source, destination, smsc, text, timeSent, timeReceived].
 */
export function parseManualSmsLog(rows: string[][]): WnSmsRecord[] {
  if (!rows.length) return [];
  const header = rows[0]!.map((c) => String(c ?? "").toLowerCase());
  const findIdx = (...names: string[]) => header.findIndex((h) => names.some((n) => h.includes(n)));
  let serviceIdx = findIdx("service", "app");
  let sourceIdx = findIdx("source", "from");
  let destIdx = findIdx("destination", "number", "to", "mobile");
  let smscIdx = findIdx("smsc", "route");
  let textIdx = findIdx("text", "message", "content");
  let sentIdx = findIdx("time sent", "sent");
  let recvIdx = findIdx("time received", "received", "time");

  let dataRows = rows;
  const hasHeader = destIdx >= 0 || serviceIdx >= 0;
  if (hasHeader) {
    dataRows = rows.slice(1);
    if (serviceIdx < 0) serviceIdx = 0;
    if (sourceIdx < 0) sourceIdx = 1;
    if (destIdx < 0) destIdx = 2;
    if (smscIdx < 0) smscIdx = 3;
    if (textIdx < 0) textIdx = 4;
    if (sentIdx < 0) sentIdx = 5;
    if (recvIdx < 0) recvIdx = 6;
  } else {
    serviceIdx = 0; sourceIdx = 1; destIdx = 2; smscIdx = 3; textIdx = 4; sentIdx = 5; recvIdx = 6;
  }

  return dataRows
    .filter((r) => r.length > Math.max(destIdx, 0) && String(r[destIdx] ?? "").trim())
    .map((r) => ({
      service: String(r[serviceIdx] ?? "").trim(),
      source: String(r[sourceIdx] ?? "").trim(),
      destination: String(r[destIdx] ?? "").trim(),
      smsc: String(r[smscIdx] ?? "").trim(),
      text: String(r[textIdx] ?? "").trim(),
      timeSent: String(r[sentIdx] ?? "").trim(),
      timeReceived: String(r[recvIdx] ?? "").trim(),
    }));
}
