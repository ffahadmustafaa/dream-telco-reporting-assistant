/**
 * Firestore-backed data layer.
 *
 * Replaces the previous Drizzle/MySQL implementation while preserving the
 * exact same public API and record shapes: numeric auto-increment IDs,
 * JavaScript Date timestamps, decimal fields as numbers, and the same
 * collection/table names.
 */
import { Timestamp } from "firebase-admin/firestore";
import { getFirestoreDb } from "./firebase";

// ---------------------------------------------------------------------------
// Record types (mirror the previous SQL schema, with decimals as numbers)
// ---------------------------------------------------------------------------

export type User = {
  id: number;
  openId: string;
  name: string | null;
  email: string | null;
  loginMethod: string | null;
  passwordHash: string | null;
  role: "user" | "admin";
  accountRole: "admin" | "team_leader" | "tester";
  phoneNumber: string | null;
  teamLeaderId: number | null;
  emailVerified: number;
  phoneVerified: number;
  isVerified: number;
  accountStatus: "active" | "pending" | "blocked";
  createdAt: Date;
  updatedAt: Date;
  lastSignedIn: Date;
};
export type InsertUser = Partial<Omit<User, "id" | "openId">> & { openId: string };

export type OtpVerification = {
  id: number;
  identifier: string;
  otpCode: string;
  expiresAt: Date;
  isUsed: number;
  createdAt: Date;
};
export type InsertOtpVerification = Partial<Omit<OtpVerification, "id">> & {
  identifier: string;
  otpCode: string;
  expiresAt: Date;
};

export type UserSession = {
  id: number;
  userId: number;
  identifier: string | null;
  role: string;
  loginAt: Date;
  lastSeenAt: Date;
  isActive: number;
};
export type InsertUserSession = Partial<Omit<UserSession, "id">> & { userId: number };

export type AuthChallenge = {
  id: number;
  userId: number;
  emailOtp: string;
  phoneOtp: string;
  expiresAt: Date;
  isCompleted: number;
  createdAt: Date;
};
export type InsertAuthChallenge = Partial<Omit<AuthChallenge, "id">> & {
  userId: number;
  emailOtp: string;
  phoneOtp: string;
  expiresAt: Date;
};

export type TeamLeader = {
  id: number;
  name: string;
  status: "ACTIVE" | "INACTIVE";
  dateAdded: Date;
  dateInactive: Date | null;
  notes: string | null;
};
export type InsertTeamLeader = Partial<Omit<TeamLeader, "id">> & { name: string };

export type Tester = {
  id: number;
  name: string;
  teamLeaderId: number;
  status: "ACTIVE" | "INACTIVE";
  dateAdded: Date;
  dateInactive: Date | null;
  notes: string | null;
};
export type InsertTester = Partial<Omit<Tester, "id">> & { name: string; teamLeaderId: number };

export type Project = {
  id: number;
  name: string;
  status: "ACTIVE" | "INACTIVE";
  notes: string | null;
};
export type InsertProject = Partial<Omit<Project, "id">> & { name: string };

export type Target = {
  id: number;
  testerId: number | null;
  teamLeaderId: number | null;
  projectId: number | null;
  target: number;
  effectiveDate: Date;
  endDate: Date | null;
  level: "TESTER" | "TEAM_LEADER" | "PROJECT" | "DAILY" | "WEEKLY" | "MONTHLY";
  status: "ACTIVE" | "INACTIVE";
  notes: string | null;
};
export type InsertTarget = Partial<Omit<Target, "id">> & {
  target: number;
  effectiveDate: Date;
};

export type DailyPerformance = {
  id: number;
  businessDate: Date;
  testerId: number;
  teamLeaderId: number;
  projectId: number;
  quantity: number;
  source: string | null;
  notes: string | null;
  createdAt: Date;
};
export type InsertDailyPerformance = Partial<Omit<DailyPerformance, "id">> & {
  businessDate: Date;
  testerId: number;
  teamLeaderId: number;
  projectId: number;
  quantity: number;
};

export type Payout = {
  id: number;
  payoutDate: Date;
  testerId: number | null;
  teamLeaderId: number | null;
  projectId: number | null;
  testerNameRaw: string;
  projectNameRaw: string | null;
  grossPayout: number;
  deductions: number;
  netPayout: number;
  transactionId: string | null;
  sourceFile: string | null;
  status: "MATCHED" | "UNMATCHED" | "POSSIBLE_MATCH" | "DUPLICATE" | "MISSING_AMOUNT" | "CONFLICT";
  reviewStatus: "PENDING" | "APPROVED" | "REJECTED" | "PAID";
  notes: string | null;
  createdAt: Date;
};
export type InsertPayout = Partial<Omit<Payout, "id">> & {
  payoutDate: Date;
  testerNameRaw: string;
  grossPayout: number;
  netPayout: number;
};

export type PayoutRule = {
  id: number;
  projectId: number;
  testerId: number | null;
  ratePerOtp: number | null;
  fixedAmount: number | null;
  status: "ACTIVE" | "INACTIVE";
  notes: string | null;
  createdAt: Date;
};
export type InsertPayoutRule = Partial<Omit<PayoutRule, "id">> & { projectId: number };

export type ImportRecord = {
  id: number;
  fileName: string;
  sourceKey: string | null;
  sourceUrl: string | null;
  uploadedBy: number | null;
  recordCount: number;
  matchedCount: number;
  exceptionCount: number;
  status: "PROCESSED" | "PARTIAL" | "FAILED";
  rawData: string | null;
  createdAt: Date;
};
export type InsertImportRecord = Partial<Omit<ImportRecord, "id">> & { fileName: string };

export type AuditLog = {
  id: number;
  action: string;
  userId: number | null;
  userCommand: string | null;
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
  createdAt: Date;
};
export type InsertAuditLog = Partial<Omit<AuditLog, "id">> & { action: string };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const COLLECTIONS = {
  users: "users",
  otpVerifications: "otp_verifications",
  userSessions: "user_sessions",
  authChallenges: "auth_challenges",
  teamLeaders: "team_leaders",
  testers: "testers",
  projects: "projects",
  targets: "targets",
  dailyPerformance: "daily_performance",
  payouts: "payouts",
  payoutRules: "payout_rules",
  imports: "imports",
  auditLogs: "audit_logs",
} as const;

type CollectionKey = keyof typeof COLLECTIONS;

function requireDb() {
  const db = getFirestoreDb();
  if (!db) throw new Error("Database is unavailable");
  return db;
}

/** True when Firebase credentials are configured. */
export function isDbConfigured(): boolean {
  return getFirestoreDb() !== null;
}

/** Allocate the next numeric ID for a collection using a Firestore transaction. */
async function nextId(collection: CollectionKey): Promise<number> {
  const db = requireDb();
  const counterRef = db.collection("_counters").doc(COLLECTIONS[collection]);
  const id = await db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    const current = snap.exists ? Number(snap.data()?.next ?? 1) : 1;
    tx.set(counterRef, { next: current + 1 }, { merge: true });
    return current;
  });
  return id;
}

/** Convert Firestore Timestamps to JS Dates recursively on read. */
function fromDoc<T>(doc: { id: string; data: () => unknown }): T {
  return convertTimestamps<T>(doc.data() as Record<string, unknown>);
}

function convertTimestamps<T>(value: unknown): T {
  if (value instanceof Timestamp) return value.toDate() as unknown as T;
  if (value instanceof Date) return value as unknown as T;
  if (Array.isArray(value)) return value.map((v) => convertTimestamps(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = convertTimestamps(v);
    }
    return out as T;
  }
  return value as T;
}

/** Convert Dates to Timestamps and drop undefined fields on write. */
function toFirestoreData(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value instanceof Date) return Timestamp.fromDate(value);
  if (Array.isArray(value)) return value.map((v) => toFirestoreData(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = toFirestoreData(v);
    }
    return out;
  }
  return value;
}

async function getById<T>(collection: CollectionKey, id: number): Promise<T | undefined> {
  const db = getFirestoreDb();
  if (!db) return undefined;
  const snap = await db.collection(COLLECTIONS[collection]).doc(String(id)).get();
  if (!snap.exists) return undefined;
  return fromDoc<T>(snap as never);
}

async function listAll<T>(collection: CollectionKey): Promise<T[]> {
  const db = getFirestoreDb();
  if (!db) return [];
  const snap = await db.collection(COLLECTIONS[collection]).get();
  return snap.docs.map((d) => fromDoc<T>(d as never));
}

async function insertOne<T extends { id: number }>(
  collection: CollectionKey,
  values: Record<string, unknown>
): Promise<number> {
  const db = requireDb();
  const id = await nextId(collection);
  const ref = db.collection(COLLECTIONS[collection]).doc(String(id));
  await ref.set(toFirestoreData({ ...values, id }) as Record<string, unknown>);
  return id;
}

async function updateOne(collection: CollectionKey, id: number, patch: Record<string, unknown>): Promise<void> {
  const db = requireDb();
  const ref = db.collection(COLLECTIONS[collection]).doc(String(id));
  await ref.update(toFirestoreData(patch) as Record<string, unknown>);
}

async function deleteOne(collection: CollectionKey, id: number): Promise<void> {
  const db = requireDb();
  await db.collection(COLLECTIONS[collection]).doc(String(id)).delete();
}

async function deleteWhere<T>(collection: CollectionKey, predicate: (row: T) => boolean): Promise<void> {
  const db = requireDb();
  const rows = await listAll<T>(collection);
  const matches = rows.filter(predicate);
  if (matches.length === 0) return;
  const batch = db.batch();
  for (const row of matches) {
    batch.delete(db.collection(COLLECTIONS[collection]).doc(String((row as { id: number }).id)));
  }
  await batch.commit();
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export async function listUsers(): Promise<User[]> {
  const rows = await listAll<User>("users");
  return rows.sort((a, b) => b.id - a.id);
}

export async function getUser(id: number): Promise<User | undefined> {
  return getById<User>("users", id);
}

export async function getUserByOpenId(openId: string): Promise<User | undefined> {
  const db = getFirestoreDb();
  if (!db) return undefined;
  const snap = await db.collection(COLLECTIONS.users).where("openId", "==", openId).limit(1).get();
  if (snap.empty) return undefined;
  return fromDoc<User>(snap.docs[0] as never);
}

export async function insertUser(values: InsertUser): Promise<number> {
  return insertOne<User>("users", values as Record<string, unknown>);
}

export async function updateUser(id: number, patch: Partial<User>): Promise<void> {
  return updateOne("users", id, patch as Record<string, unknown>);
}

export async function deleteUser(id: number): Promise<void> {
  return deleteOne("users", id);
}

/** Insert or update a user keyed by openId (mirrors the previous upsert). */
export async function upsertUser(user: InsertUser): Promise<void> {
  const db = getFirestoreDb();
  if (!db) throw new Error("Database is unavailable");
  const now = new Date();
  const existing = await getUserByOpenId(user.openId);
  const clean = toFirestoreData({
    ...user,
    updatedAt: user.updatedAt ?? now,
    createdAt: existing?.createdAt ?? user.createdAt ?? now,
    lastSignedIn: user.lastSignedIn ?? now,
  }) as Record<string, unknown>;
  if (existing) {
    await db.collection(COLLECTIONS.users).doc(String(existing.id)).set(clean, { merge: true });
  } else {
    const id = await nextId("users");
    await db.collection(COLLECTIONS.users).doc(String(id)).set({ ...clean, id });
  }
}

// ---------------------------------------------------------------------------
// User sessions
// ---------------------------------------------------------------------------

export async function listUserSessions(): Promise<UserSession[]> {
  return listAll<UserSession>("userSessions");
}

export async function insertUserSession(values: InsertUserSession): Promise<number> {
  return insertOne<UserSession>("userSessions", values as Record<string, unknown>);
}

export async function updateUserSessionByUserId(userId: number, patch: Partial<UserSession>): Promise<void> {
  const db = getFirestoreDb();
  if (!db) throw new Error("Database is unavailable");
  const snap = await db.collection(COLLECTIONS.userSessions).where("userId", "==", userId).limit(1).get();
  if (snap.empty) return;
  await snap.docs[0].ref.update(toFirestoreData(patch) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// OTP verifications
// ---------------------------------------------------------------------------

/** All OTP records, newest first. */
export async function listOtpVerifications(): Promise<OtpVerification[]> {
  const rows = await listAll<OtpVerification>("otpVerifications");
  return rows.sort((a, b) => b.id - a.id);
}

export async function insertOtpVerification(values: InsertOtpVerification): Promise<number> {
  return insertOne<OtpVerification>("otpVerifications", values as Record<string, unknown>);
}

export async function updateOtpVerification(id: number, patch: Partial<OtpVerification>): Promise<void> {
  return updateOne("otpVerifications", id, patch as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Auth challenges
// ---------------------------------------------------------------------------

/** All challenges, newest first. */
export async function listAuthChallenges(): Promise<AuthChallenge[]> {
  const rows = await listAll<AuthChallenge>("authChallenges");
  return rows.sort((a, b) => b.id - a.id);
}

export async function insertAuthChallenge(values: InsertAuthChallenge): Promise<number> {
  return insertOne<AuthChallenge>("authChallenges", values as Record<string, unknown>);
}

export async function updateAuthChallenge(id: number, patch: Partial<AuthChallenge>): Promise<void> {
  return updateOne("authChallenges", id, patch as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Team leaders
// ---------------------------------------------------------------------------

/** All team leaders, ordered by name. */
export async function listTeamLeaders(): Promise<TeamLeader[]> {
  const rows = await listAll<TeamLeader>("teamLeaders");
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getTeamLeader(id: number): Promise<TeamLeader | undefined> {
  return getById<TeamLeader>("teamLeaders", id);
}

export async function insertTeamLeader(values: InsertTeamLeader): Promise<number> {
  return insertOne<TeamLeader>("teamLeaders", values as Record<string, unknown>);
}

export async function updateTeamLeader(id: number, patch: Partial<TeamLeader>): Promise<void> {
  return updateOne("teamLeaders", id, patch as Record<string, unknown>);
}

export async function deleteTeamLeader(id: number): Promise<void> {
  return deleteOne("teamLeaders", id);
}

/** Find a team leader by name, or create + reactivate it when missing. */
export async function upsertTeamLeader(name: string): Promise<TeamLeader> {
  const rows = await listTeamLeaders();
  const existing = rows.find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    if (existing.status !== "ACTIVE") await updateTeamLeader(existing.id, { status: "ACTIVE" });
    return { ...existing, status: "ACTIVE" as const };
  }
  const id = await insertTeamLeader({ name, status: "ACTIVE", dateAdded: new Date(), dateInactive: null, notes: null });
  return (await getTeamLeader(id))!;
}

/** Find a tester by name, or create + reactivate it when missing. */
export async function upsertTesterByName(name: string, teamLeaderId: number): Promise<Tester> {
  const rows = await listTesters();
  const existing = rows.find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    await updateTester(existing.id, { status: "ACTIVE", teamLeaderId });
    return { ...existing, status: "ACTIVE" as const, teamLeaderId };
  }
  const id = await insertTester({ name, teamLeaderId, status: "ACTIVE", dateAdded: new Date(), dateInactive: null, notes: null });
  return (await getTester(id))!;
}

// ---------------------------------------------------------------------------
// Testers
// ---------------------------------------------------------------------------

/** All testers, ordered by name. */
export async function listTesters(): Promise<Tester[]> {
  const rows = await listAll<Tester>("testers");
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getTester(id: number): Promise<Tester | undefined> {
  return getById<Tester>("testers", id);
}

export async function insertTester(values: InsertTester): Promise<number> {
  return insertOne<Tester>("testers", values as Record<string, unknown>);
}

export async function updateTester(id: number, patch: Partial<Tester>): Promise<void> {
  return updateOne("testers", id, patch as Record<string, unknown>);
}

export async function deleteTester(id: number): Promise<void> {
  return deleteOne("testers", id);
}

export async function deleteTestersByLeader(leaderId: number): Promise<void> {
  return deleteWhere<Tester>("testers", (t) => t.teamLeaderId === leaderId);
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/** All projects, ordered by id. */
export async function listProjects(): Promise<Project[]> {
  const rows = await listAll<Project>("projects");
  return rows.sort((a, b) => a.id - b.id);
}

/** Active projects only, ordered by id. */
export async function listActiveProjects(): Promise<Project[]> {
  const rows = await listProjects();
  return rows.filter((p) => p.status === "ACTIVE");
}

export async function insertProject(values: InsertProject): Promise<number> {
  return insertOne<Project>("projects", values as Record<string, unknown>);
}

export async function updateProject(id: number, patch: Partial<Project>): Promise<void> {
  return updateOne("projects", id, patch as Record<string, unknown>);
}

export async function deleteProject(id: number): Promise<void> {
  return deleteOne("projects", id);
}

/** Insert a project by name, reactivating it when it already exists. */
export async function upsertProjectByName(name: string, notes?: string): Promise<Project> {
  const db = getFirestoreDb();
  if (!db) throw new Error("Database is unavailable");
  const snap = await db.collection(COLLECTIONS.projects).where("name", "==", name).limit(1).get();
  if (!snap.empty) {
    const row = fromDoc<Project>(snap.docs[0] as never);
    const patch: Partial<Project> = { status: "ACTIVE" };
    if (notes !== undefined) patch.notes = notes;
    await snap.docs[0].ref.update(toFirestoreData(patch) as Record<string, unknown>);
    return { ...row, ...patch };
  }
  const now = new Date();
  const id = await nextId("projects");
  const record: Project = { id, name, status: "ACTIVE", notes: notes ?? null };
  await db.collection(COLLECTIONS.projects).doc(String(id)).set(toFirestoreData(record) as Record<string, unknown>);
  return record;
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export async function listTargets(): Promise<Target[]> {
  return listAll<Target>("targets");
}

export async function listActiveTargets(): Promise<Target[]> {
  const rows = await listTargets();
  return rows.filter((t) => t.status === "ACTIVE");
}

export async function insertTarget(values: InsertTarget): Promise<number> {
  return insertOne<Target>("targets", values as Record<string, unknown>);
}

export async function deleteTargetsByTester(testerId: number): Promise<void> {
  return deleteWhere<Target>("targets", (t) => t.testerId === testerId);
}

export async function deleteTargetsByLeader(leaderId: number): Promise<void> {
  return deleteWhere<Target>("targets", (t) => t.teamLeaderId === leaderId);
}

// ---------------------------------------------------------------------------
// Daily performance
// ---------------------------------------------------------------------------

/** Performance rows for one business day (midnight-to-midnight in local time). */
export async function listPerformanceByDate(date: Date): Promise<DailyPerformance[]> {
  const db = getFirestoreDb();
  if (!db) return [];
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const snap = await db
    .collection(COLLECTIONS.dailyPerformance)
    .where("businessDate", ">=", Timestamp.fromDate(start))
    .where("businessDate", "<", Timestamp.fromDate(end))
    .get();
  return snap.docs.map((d) => fromDoc<DailyPerformance>(d as never));
}

/** Performance rows touching a project (newest first), used to guard project deletion. */
export async function listPerformanceByProject(projectId: number, limit = 1): Promise<DailyPerformance[]> {
  const db = getFirestoreDb();
  if (!db) return [];
  const snap = await db
    .collection(COLLECTIONS.dailyPerformance)
    .where("projectId", "==", projectId)
    .orderBy("businessDate", "desc")
    .limit(limit)
    .get();
  return snap.docs.map((d) => fromDoc<DailyPerformance>(d as never));
}

export async function findPerformance(
  date: Date,
  testerId: number,
  projectId: number
): Promise<DailyPerformance | undefined> {
  const rows = await listPerformanceByDate(date);
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return rows.find(
    (p) =>
      p.testerId === testerId &&
      p.projectId === projectId &&
      p.businessDate >= start &&
      p.businessDate < end
  );
}

export async function insertPerformance(values: InsertDailyPerformance): Promise<number> {
  return insertOne<DailyPerformance>("dailyPerformance", values as Record<string, unknown>);
}

export async function updatePerformance(id: number, patch: Partial<DailyPerformance>): Promise<void> {
  return updateOne("dailyPerformance", id, patch as Record<string, unknown>);
}

export async function deletePerformanceByTester(testerId: number): Promise<void> {
  return deleteWhere<DailyPerformance>("dailyPerformance", (p) => p.testerId === testerId);
}

/** Recent performance rows for a tester, newest first. */
export async function listPerformanceByTester(testerId: number, limit = 200): Promise<DailyPerformance[]> {
  const db = getFirestoreDb();
  if (!db) return [];
  const snap = await db
    .collection(COLLECTIONS.dailyPerformance)
    .where("testerId", "==", testerId)
    .orderBy("businessDate", "desc")
    .limit(limit)
    .get();
  return snap.docs.map((d) => fromDoc<DailyPerformance>(d as never));
}

// ---------------------------------------------------------------------------
// Payouts
// ---------------------------------------------------------------------------

/** All payouts, newest first. */
export async function listPayouts(limit = 300): Promise<Payout[]> {
  const db = getFirestoreDb();
  if (!db) return [];
  const snap = await db.collection(COLLECTIONS.payouts).orderBy("createdAt", "desc").limit(limit).get();
  return snap.docs.map((d) => fromDoc<Payout>(d as never));
}

export async function getPayout(id: number): Promise<Payout | undefined> {
  return getById<Payout>("payouts", id);
}

export async function insertPayout(values: InsertPayout): Promise<number> {
  return insertOne<Payout>("payouts", values as Record<string, unknown>);
}

export async function updatePayout(id: number, patch: Partial<Payout>): Promise<void> {
  return updateOne("payouts", id, patch as Record<string, unknown>);
}

export async function deletePayout(id: number): Promise<void> {
  return deleteOne("payouts", id);
}

export async function deletePayoutsByTester(testerId: number): Promise<void> {
  return deleteWhere<Payout>("payouts", (p) => p.testerId === testerId);
}

export async function deletePayoutsByLeader(leaderId: number): Promise<void> {
  return deleteWhere<Payout>("payouts", (p) => p.teamLeaderId === leaderId);
}

// ---------------------------------------------------------------------------
// Payout rules
// ---------------------------------------------------------------------------

export async function listPayoutRules(): Promise<PayoutRule[]> {
  return listAll<PayoutRule>("payoutRules");
}

export async function listActivePayoutRules(): Promise<PayoutRule[]> {
  const rows = await listPayoutRules();
  return rows.filter((r) => r.status === "ACTIVE");
}

export async function insertPayoutRule(values: InsertPayoutRule): Promise<number> {
  return insertOne<PayoutRule>("payoutRules", values as Record<string, unknown>);
}

export async function updatePayoutRule(id: number, patch: Partial<PayoutRule>): Promise<void> {
  return updateOne("payoutRules", id, patch as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

/** Imports, newest first. */
export async function listImports(limit = 20): Promise<ImportRecord[]> {
  const db = getFirestoreDb();
  if (!db) return [];
  const snap = await db.collection(COLLECTIONS.imports).orderBy("createdAt", "desc").limit(limit).get();
  return snap.docs.map((d) => fromDoc<ImportRecord>(d as never));
}

export async function getImport(id: number): Promise<ImportRecord | undefined> {
  return getById<ImportRecord>("imports", id);
}

export async function insertImport(values: InsertImportRecord): Promise<number> {
  return insertOne<ImportRecord>("imports", values as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Audit logs
// ---------------------------------------------------------------------------

/** Tolerant audit-log writer used across routers. Accepts partial entries. */
export async function addAuditLog(opts: {
  action: string;
  userId?: number | null;
  userCommand?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
}): Promise<void> {
  try {
    await insertOne("auditLogs", {
      action: opts.action,
      userId: opts.userId ?? null,
      userCommand: opts.userCommand ?? null,
      oldValue: opts.oldValue === undefined ? null : (opts.oldValue as Record<string, unknown>),
      newValue: opts.newValue === undefined ? null : (opts.newValue as Record<string, unknown>),
      reason: opts.reason ?? null,
      createdAt: new Date(),
    } as Record<string, unknown>);
  } catch {
    // Audit logging must never break the main flow.
  }
}

/** Audit logs, newest first (max 100). */
export async function listAuditLogs(limit = 100): Promise<AuditLog[]> {
  const db = getFirestoreDb();
  if (!db) return [];
  const snap = await db.collection(COLLECTIONS.auditLogs).orderBy("createdAt", "desc").limit(limit).get();
  return snap.docs.map((d) => fromDoc<AuditLog>(d as never));
}

// ---------------------------------------------------------------------------
// Workspace helpers
// ---------------------------------------------------------------------------

export interface WorkspaceData {
  leaders: TeamLeader[];
  testers: Tester[];
  projects: Project[];
  performance: DailyPerformance[];
  targets: Target[];
  payouts: Payout[];
  imports: ImportRecord[];
}

/**
 * Seed canonical projects and the default payout rule on first use.
 * Safe to call repeatedly; existing rows are left untouched.
 */
export async function ensureWorkspaceInitialized(_userId?: number): Promise<void> {
  const db = getFirestoreDb();
  if (!db) return;
  const projects = await listProjects();
  if (projects.length === 0) {
    for (const name of ["Section X", "Super X"]) {
      await upsertProjectByName(name);
    }
  }
  const rules = await listPayoutRules();
  if (rules.length === 0) {
    const sectionX = (await listProjects()).find((p) => p.name === "Section X");
    await insertPayoutRule({
      projectId: sectionX?.id ?? 1,
      testerId: null,
      ratePerOtp: 100,
      fixedAmount: null,
      status: "ACTIVE",
      notes: "Standard OTP rate",
      createdAt: new Date(),
    });
  }
}

export async function getWorkspaceData(date: Date): Promise<WorkspaceData> {
  const db = getFirestoreDb();
  if (!db) {
    return { leaders: [], testers: [], projects: [], performance: [], targets: [], payouts: [], imports: [] };
  }
  const [leaders, testers, projects, performance, targets, payouts, imports] = await Promise.all([
    listTeamLeaders(),
    listTesters(),
    listProjects(),
    listPerformanceByDate(date),
    listActiveTargets(),
    listPayouts(),
    listImports(),
  ]);
  return { leaders, testers, projects, performance, targets, payouts, imports };
}
