import { and, desc, eq, gte, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, auditLogs, dailyPerformance, imports, otpVerifications, payouts, payoutRules, projects, targets, teamLeaders, testers, userSessions, users } from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) return;
  const values: InsertUser = { openId: user.openId };
  const updateSet: Record<string, unknown> = {};
  for (const field of ["name", "email", "loginMethod"] as const) {
    if (user[field] !== undefined) { values[field] = user[field] ?? null; updateSet[field] = user[field] ?? null; }
  }
  if (user.lastSignedIn !== undefined) { values.lastSignedIn = user.lastSignedIn; updateSet.lastSignedIn = user.lastSignedIn; }
  if (user.email?.toLowerCase() === "ffahadmustafaa@gmail.com" || user.openId === ENV.ownerOpenId) { values.role = "admin"; values.accountRole = "admin"; values.isVerified = 1; values.accountStatus = "active"; updateSet.role = "admin"; updateSet.accountRole = "admin"; updateSet.isVerified = 1; updateSet.accountStatus = "active"; }
  else if (user.role !== undefined) { values.role = user.role; updateSet.role = user.role; }
  values.lastSignedIn ??= new Date();
  if (!Object.keys(updateSet).length) updateSet.lastSignedIn = new Date();
  await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result[0];
}

export async function ensureWorkspaceInitialized(userId?: number) {
  const db = await getDb();
  if (!db) return;
  const existingProjects = await db.select().from(projects);
  const names = new Set(existingProjects.map(project => project.name));
  const defaults = ["Super X", "Inception"].filter(name => !names.has(name));
  if (defaults.length) await db.insert(projects).values(defaults.map(name => ({ name })));
}

export async function getWorkspaceData(date: Date) {
  const db = await getDb();
  if (!db) return { leaders: [], testers: [], projects: [], performance: [], targets: [], payouts: [], imports: [] };
  await ensureWorkspaceInitialized();
  const start = new Date(date); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  const [leaders, roster, projectRows, performance, targetRows, payoutRows, importRows] = await Promise.all([
    db.select().from(teamLeaders).orderBy(teamLeaders.name),
    db.select().from(testers).orderBy(testers.name),
    db.select().from(projects).orderBy(projects.name),
    db.select().from(dailyPerformance).where(and(gte(dailyPerformance.businessDate, start), lt(dailyPerformance.businessDate, end))),
    db.select().from(targets).where(eq(targets.status, "ACTIVE")),
    db.select().from(payouts).orderBy(desc(payouts.createdAt)).limit(200),
    db.select().from(imports).orderBy(desc(imports.createdAt)).limit(20),
  ]);
  return { leaders, testers: roster, projects: projectRows, performance, targets: targetRows, payouts: payoutRows, imports: importRows };
}

export async function addAuditLog(entry: { action: string; userId?: number; userCommand?: string; oldValue?: unknown; newValue?: unknown; reason?: string }) {
  const db = await getDb();
  if (!db) return;
  await db.insert(auditLogs).values({ action: entry.action, userId: entry.userId, userCommand: entry.userCommand, oldValue: entry.oldValue ? JSON.stringify(entry.oldValue) : undefined, newValue: entry.newValue ? JSON.stringify(entry.newValue) : undefined, reason: entry.reason });
}

export async function listAuditLogs() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(100);
}

export { auditLogs, dailyPerformance, imports, otpVerifications, payouts, payoutRules, projects, targets, teamLeaders, testers, userSessions, users };
