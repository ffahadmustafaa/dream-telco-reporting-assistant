import { decimal, index, int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export const teamLeaders = mysqlTable("team_leaders", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 160 }).notNull().unique(),
  status: mysqlEnum("status", ["ACTIVE", "INACTIVE"]).default("ACTIVE").notNull(),
  dateAdded: timestamp("dateAdded").defaultNow().notNull(),
  dateInactive: timestamp("dateInactive"),
  notes: text("notes"),
});

export const testers = mysqlTable("testers", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 160 }).notNull(),
  teamLeaderId: int("teamLeaderId").notNull(),
  status: mysqlEnum("status", ["ACTIVE", "INACTIVE"]).default("ACTIVE").notNull(),
  dateAdded: timestamp("dateAdded").defaultNow().notNull(),
  dateInactive: timestamp("dateInactive"),
  notes: text("notes"),
}, (table) => ({ leaderIdx: index("testers_team_leader_idx").on(table.teamLeaderId) }));

export const projects = mysqlTable("projects", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 160 }).notNull().unique(),
  status: mysqlEnum("status", ["ACTIVE", "INACTIVE"]).default("ACTIVE").notNull(),
  notes: text("notes"),
});

export const targets = mysqlTable("targets", {
  id: int("id").autoincrement().primaryKey(),
  testerId: int("testerId"),
  teamLeaderId: int("teamLeaderId"),
  projectId: int("projectId"),
  target: decimal("target", { precision: 12, scale: 2 }).notNull(),
  effectiveDate: timestamp("effectiveDate").notNull(),
  endDate: timestamp("endDate"),
  level: mysqlEnum("level", ["TESTER", "TEAM_LEADER", "PROJECT", "DAILY", "WEEKLY", "MONTHLY"]).default("TESTER").notNull(),
  status: mysqlEnum("status", ["ACTIVE", "INACTIVE"]).default("ACTIVE").notNull(),
  notes: text("notes"),
});

export const dailyPerformance = mysqlTable("daily_performance", {
  id: int("id").autoincrement().primaryKey(),
  businessDate: timestamp("businessDate").notNull(),
  testerId: int("testerId").notNull(),
  teamLeaderId: int("teamLeaderId").notNull(),
  projectId: int("projectId").notNull(),
  quantity: decimal("quantity", { precision: 12, scale: 2 }).notNull(),
  source: varchar("source", { length: 255 }),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({ dateIdx: index("performance_date_idx").on(table.businessDate), testerIdx: index("performance_tester_idx").on(table.testerId) }));

export const payouts = mysqlTable("payouts", {
  id: int("id").autoincrement().primaryKey(),
  payoutDate: timestamp("payoutDate").notNull(),
  testerId: int("testerId"),
  teamLeaderId: int("teamLeaderId"),
  projectId: int("projectId"),
  testerNameRaw: varchar("testerNameRaw", { length: 160 }).notNull(),
  projectNameRaw: varchar("projectNameRaw", { length: 160 }),
  grossPayout: decimal("grossPayout", { precision: 12, scale: 2 }).notNull(),
  deductions: decimal("deductions", { precision: 12, scale: 2 }).default("0").notNull(),
  netPayout: decimal("netPayout", { precision: 12, scale: 2 }).notNull(),
  transactionId: varchar("transactionId", { length: 160 }),
  sourceFile: varchar("sourceFile", { length: 255 }),
  status: mysqlEnum("status", ["MATCHED", "UNMATCHED", "POSSIBLE_MATCH", "DUPLICATE", "MISSING_AMOUNT", "CONFLICT"]).default("MATCHED").notNull(),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({ dateIdx: index("payout_date_idx").on(table.payoutDate), statusIdx: index("payout_status_idx").on(table.status) }));

export const imports = mysqlTable("imports", {
  id: int("id").autoincrement().primaryKey(),
  fileName: varchar("fileName", { length: 255 }).notNull(),
  sourceKey: varchar("sourceKey", { length: 500 }),
  sourceUrl: varchar("sourceUrl", { length: 500 }),
  recordCount: int("recordCount").default(0).notNull(),
  matchedCount: int("matchedCount").default(0).notNull(),
  exceptionCount: int("exceptionCount").default(0).notNull(),
  status: mysqlEnum("status", ["PROCESSED", "PARTIAL", "FAILED"]).default("PROCESSED").notNull(),
  rawData: text("rawData"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const auditLogs = mysqlTable("audit_logs", {
  id: int("id").autoincrement().primaryKey(),
  action: varchar("action", { length: 120 }).notNull(),
  userId: int("userId"),
  userCommand: text("userCommand"),
  oldValue: text("oldValue"),
  newValue: text("newValue"),
  reason: text("reason"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type TeamLeader = typeof teamLeaders.$inferSelect;
export type Tester = typeof testers.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Target = typeof targets.$inferSelect;
export type DailyPerformance = typeof dailyPerformance.$inferSelect;
export type Payout = typeof payouts.$inferSelect;
