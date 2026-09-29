import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { invokeLLM } from "./_core/llm";
import { adminProcedure, protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { addAuditLog, authChallenges, dailyPerformance, ensureWorkspaceInitialized, getDb, getWorkspaceData, imports, listAuditLogs, otpVerifications, payouts, payoutRules, projects, targets, teamLeaders, testers, userSessions, users } from "./db";
import { and, desc, eq } from "drizzle-orm";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { sdk } from "./_core/sdk";
import { isSandboxAuth, sendDualOtp, sendSecurityEmail } from "./_core/authDelivery";
import { compileDailyReport } from "./scheduledReports";
import { deliverDailyReport, reportDeliveryConfig } from "./reportDelivery";
import { answerWorkspaceQuestion, parseAssistantCommand, type AssistantCommand, type WorkspaceSnapshot } from "./aiAssistant";
import { answerDatasetQuestion, parseWorkbook, summarizeDataset } from "./aiDataset";

const dateInput = z.string().optional();
const toDate = (value?: string) => value ? new Date(`${value}T00:00:00.000Z`) : new Date();
const money = (value: string | number | null | undefined) => Number(value ?? 0);
export const parseQuantity = (value: string | number) => { const raw = String(value).trim().replace(/,/g, ""); const parts = raw.split("/").map(part => Number(part.trim())); if (parts.length > 1) return parts.reduce((sum, item) => sum + (Number.isFinite(item) && item >= 0 ? item : 0), 0); const parsed = Number(raw); return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0; };
const parseAmount = (value: string | number | null | undefined) => { if (typeof value === "number") return value; const raw = String(value ?? "").trim().toLowerCase().replace(/,/g, ""); const multiplier = raw.endsWith("k") ? 1000 : 1; const parsed = Number(raw.replace(/k$/, "")); return Number.isFinite(parsed) ? parsed * multiplier : 0; };
const cleanName = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
const textFromLLM = (value: string | Array<{ type: string; text?: string }>) => typeof value === "string" ? value : value.map(part => part.text ?? "").join("\n");
const hashPassword = (password: string) => { const salt = randomBytes(16).toString("hex"); return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`; };
const verifyPassword = (password: string, stored: string) => { const [salt, hash] = stored.split(":"); if (!salt || !hash) return false; const derived = scryptSync(password, salt, 64); const expected = Buffer.from(hash, "hex"); return expected.length === derived.length && timingSafeEqual(expected, derived); };
const setLocalSession = async (ctx: { req: any; res: any }, user: { openId: string; name: string | null }, remember = false) => { const token = await sdk.createSessionToken(user.openId, { name: user.name ?? "Workspace user" }); ctx.res.cookie(COOKIE_NAME, token, { ...getSessionCookieOptions(ctx.req), ...(remember ? { maxAge: 365 * 24 * 60 * 60 * 1000 } : {}) }); };
const stripSecrets = (user: any) => { if (!user) return null; const { passwordHash: _passwordHash, ...safeUser } = user; return safeUser; };

type DbClient = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type RosterTester = typeof testers.$inferSelect;
type RosterLeader = typeof teamLeaders.$inferSelect;
type ProjectRecord = typeof projects.$inferSelect;
type CommandUser = { id: number; name: string | null; accountRole: "admin" | "team_leader" | "tester"; isAdmin: boolean };
type CommandData = { roster: RosterTester[]; leaderRows: RosterLeader[]; projectRows: ProjectRecord[]; reportDate: string; latest: string };

/** Role-scoped snapshot for deterministic assistant Q&A. */
async function buildWorkspaceSnapshot(db: DbClient, scopeTesters: RosterTester[], scopeLeaders: RosterLeader[], projectRows: ProjectRecord[], reportDate: string): Promise<WorkspaceSnapshot> {
  const perf = await db.select().from(dailyPerformance).where(eq(dailyPerformance.businessDate, toDate(reportDate)));
  const testerIds = new Set(scopeTesters.map(item => item.id));
  return {
    testers: scopeTesters.map(item => ({ id: item.id, name: item.name, teamLeaderId: item.teamLeaderId, status: item.status })),
    leaders: scopeLeaders.map(item => ({ id: item.id, name: item.name, status: item.status })),
    projects: projectRows.map(item => ({ id: item.id, name: item.name })),
    performance: perf.filter(item => testerIds.has(item.testerId)).map(item => ({ testerId: item.testerId, projectId: item.projectId, quantity: money(item.quantity) })),
  };
}

/**
 * Execute a deterministic assistant command with strict role scoping:
 * - testers can only log their own work
 * - team leaders are scoped to their own team
 * - unknown testers in a report are auto-added (admin may also create the missing team leader)
 * - removals deactivate instead of deleting, preserving history
 * - a team leader cannot be removed while active testers remain on the team
 */
async function executeAssistantCommand(db: DbClient, user: CommandUser, command: AssistantCommand, data: CommandData): Promise<string> {
  const { roster, leaderRows, projectRows, reportDate, latest } = data;
  const findLeader = (name: string) => leaderRows.find(item => cleanName(item.name) === cleanName(name));
  const findTesters = (name: string) => roster.filter(item => cleanName(item.name) === cleanName(name));
  const ownLeader = user.accountRole === "team_leader" ? findLeader(user.name ?? "") : undefined;

  const accumulate = async (testerId: number, teamLeaderId: number, projectId: number, quantity: number) => {
    const date = toDate(reportDate);
    const existing = (await db.select().from(dailyPerformance).where(and(eq(dailyPerformance.businessDate, date), eq(dailyPerformance.testerId, testerId), eq(dailyPerformance.projectId, projectId))).limit(1))[0];
    const total = (existing ? money(existing.quantity) : 0) + quantity;
    if (existing) await db.update(dailyPerformance).set({ teamLeaderId, quantity: String(total), source: "AI assistant", notes: latest.slice(0, 1000) }).where(eq(dailyPerformance.id, existing.id));
    else await db.insert(dailyPerformance).values({ businessDate: date, testerId, teamLeaderId, projectId, quantity: String(quantity), source: "AI assistant", notes: latest.slice(0, 1000) });
    return total;
  };

  switch (command.type) {
    case "log_report": {
      const project = projectRows.find(item => item.name === command.project);
      if (!project) return `I don't know the project "${command.project}". Active projects: ${projectRows.map(item => item.name).join(", ")}.`;
      let tester: RosterTester | undefined;
      let createdNote = "";
      if (user.accountRole === "tester") {
        tester = roster.find(item => cleanName(item.name) === cleanName(user.name ?? ""));
        if (!tester) return "Your tester profile isn't linked yet — ask your Team Leader to set it up.";
        if (cleanName(command.name) !== cleanName(tester.name)) return `You can only log your own work, ${tester.name}.`;
      } else {
        const matches = findTesters(command.name).filter(item => item.status === "ACTIVE");
        if (matches.length === 1) {
          tester = matches[0];
          if (user.accountRole === "team_leader" && (!ownLeader || tester!.teamLeaderId !== ownLeader.id)) return `${command.name} is not on your team, so I can't log this for them.`;
        } else {
          let leader = command.teamLeader ? findLeader(command.teamLeader) : undefined;
          if (command.teamLeader && !leader) {
            if (!user.isAdmin) return `Team Leader "${command.teamLeader}" isn't on the roster, and only an Admin can create one. Ask an Admin to add them first.`;
            const inserted = await db.insert(teamLeaders).values({ name: command.teamLeader, notes: "Auto-created from an AI report" }).$returningId();
            leader = { id: inserted[0]!.id, name: command.teamLeader, status: "ACTIVE" } as RosterLeader;
            leaderRows.push(leader);
            createdNote = ` Created Team Leader ${command.teamLeader}.`;
          }
          if (!leader) {
            if (user.accountRole === "team_leader" && ownLeader) leader = ownLeader;
            else return `I don't know a tester named "${command.name}". Add "under <Team Leader>" to the message and I'll add them to the roster automatically.`;
          }
          if (user.accountRole === "team_leader" && (!ownLeader || leader.id !== ownLeader.id)) return "You can only add testers to your own team.";
          const inserted = await db.insert(testers).values({ name: command.name, teamLeaderId: leader.id, notes: "Auto-added from an AI report" }).$returningId();
          tester = { id: inserted[0]!.id, name: command.name, teamLeaderId: leader.id, status: "ACTIVE" } as RosterTester;
          roster.push(tester);
          createdNote += ` Added ${command.name} to ${leader.name}'s team.`;
          await addAuditLog({ action: "Tester Auto-Added", userId: user.id, userCommand: latest, newValue: { name: command.name, teamLeaderId: leader.id } });
        }
      }
      const total = await accumulate(tester!.id, tester!.teamLeaderId, project.id, command.quantity);
      await addAuditLog({ action: "AI Report Logged", userId: user.id, userCommand: latest, newValue: { tester: tester!.name, project: project.name, quantity: command.quantity, date: reportDate } });
      return `Logged ${command.quantity} OTP on ${project.name} for ${tester!.name}.${createdNote} ${tester!.name}'s total today: ${total}.`;
    }
    case "add_tester": {
      if (user.accountRole === "tester") return "Only Team Leaders and Admins can add testers.";
      const leader = findLeader(command.teamLeader);
      if (!leader) return `I couldn't find Team Leader "${command.teamLeader}".`;
      if (user.accountRole === "team_leader" && (!ownLeader || leader.id !== ownLeader.id)) return "You can only add testers to your own team.";
      const existing = findTesters(command.name)[0];
      if (existing) {
        await db.update(testers).set({ status: "ACTIVE", teamLeaderId: leader.id }).where(eq(testers.id, existing.id));
        return `${command.name} is back on the roster under ${leader.name}.`;
      }
      await db.insert(testers).values({ name: command.name, teamLeaderId: leader.id });
      await addAuditLog({ action: "Tester Added", userId: user.id, userCommand: latest, newValue: { name: command.name, teamLeaderId: leader.id } });
      return `Added tester ${command.name} under ${leader.name}.`;
    }
    case "remove_tester": {
      if (user.accountRole === "tester") return "Only Team Leaders and Admins can remove testers.";
      const matches = findTesters(command.name);
      if (!matches.length) return `I couldn't find a tester named "${command.name}".`;
      const lines: string[] = [];
      for (const item of matches) {
        if (user.accountRole === "team_leader" && (!ownLeader || item.teamLeaderId !== ownLeader.id)) { lines.push(`${item.name} is not on your team.`); continue; }
        if (item.status !== "ACTIVE") { lines.push(`${item.name} is already inactive.`); continue; }
        await db.update(testers).set({ status: "INACTIVE", dateInactive: new Date() }).where(eq(testers.id, item.id));
        await addAuditLog({ action: "Tester Deactivated", userId: user.id, userCommand: latest, oldValue: item, reason: "AI removal command (history preserved)" });
        lines.push(`Deactivated ${item.name}. Their past reports are kept.`);
      }
      return lines.join(" ");
    }
    case "add_team_leader": {
      if (!user.isAdmin) return "Only an Admin can add a Team Leader.";
      const existing = findLeader(command.name);
      if (existing) {
        await db.update(teamLeaders).set({ status: "ACTIVE" }).where(eq(teamLeaders.id, existing.id));
        return `${command.name} is already a Team Leader (reactivated).`;
      }
      await db.insert(teamLeaders).values({ name: command.name });
      await addAuditLog({ action: "Team Leader Added", userId: user.id, userCommand: latest, newValue: { name: command.name } });
      return `Added Team Leader ${command.name}.`;
    }
    case "remove_team_leader": {
      if (!user.isAdmin) return "Only an Admin can remove a Team Leader.";
      const leader = findLeader(command.name);
      if (!leader) return `I couldn't find Team Leader "${command.name}".`;
      const activeChildren = roster.filter(item => item.teamLeaderId === leader.id && item.status === "ACTIVE");
      if (activeChildren.length) return `Can't remove ${leader.name}: ${activeChildren.length} active tester${activeChildren.length === 1 ? "" : "s"} (${activeChildren.map(item => item.name).join(", ")}) ${activeChildren.length === 1 ? "is" : "are"} still on the team. Move or deactivate them first.`;
      await db.update(teamLeaders).set({ status: "INACTIVE" }).where(eq(teamLeaders.id, leader.id));
      await addAuditLog({ action: "Team Leader Deactivated", userId: user.id, userCommand: latest, oldValue: leader, reason: "AI removal command (history preserved)" });
      return `Deactivated Team Leader ${leader.name}. Their history is preserved.`;
    }
    case "set_target": {
      if (user.accountRole === "tester") return "Only Team Leaders and Admins can set targets.";
      const matches = findTesters(command.name).filter(item => item.status === "ACTIVE");
      const tester = user.accountRole === "team_leader" ? matches.find(item => ownLeader && item.teamLeaderId === ownLeader.id) : matches[0];
      if (!tester) return `I couldn't find an active tester named "${command.name}"${user.accountRole === "team_leader" ? " on your team" : ""}.`;
      await db.insert(targets).values({ target: String(command.quantity), level: "TESTER", testerId: tester.id, effectiveDate: toDate(reportDate) });
      await addAuditLog({ action: "Target Changed", userId: user.id, userCommand: latest, newValue: { tester: tester.name, target: command.quantity } });
      return `Set ${tester.name}'s target to ${command.quantity} OTPs.`;
    }
    default:
      return "I didn't understand that. Try something like \u201cBisma did 50 OTP on Super X\u201d.";
  }
}
export const appRouter = router({
  system: router({ health: publicProcedure.query(() => ({ ok: true })) }),
  auth: router({
    registrationTeamLeaders: publicProcedure.query(async () => { const db = await getDb(); if (!db) return []; const [rosterLeaders, activeUsers] = await Promise.all([db.select().from(teamLeaders).where(eq(teamLeaders.status, "ACTIVE")).orderBy(teamLeaders.name), db.select().from(users)]); const names = new Set(rosterLeaders.map(leader => cleanName(leader.name))); const userNames = activeUsers.filter(user => user.accountRole === "team_leader" && user.accountStatus === "active" && user.name && !names.has(cleanName(user.name))).map(user => ({ id: user.id, name: user.name!, status: "ACTIVE" as const })); return [...rosterLeaders.map(leader => ({ id: leader.id, name: leader.name, status: leader.status })), ...userNames].sort((a, b) => a.name.localeCompare(b.name)); }),
    me: publicProcedure.query(opts => stripSecrets(opts.ctx.user)),
    myProfile: protectedProcedure.query(async ({ ctx }) => { const db = await getDb(); if (!db) return { user: stripSecrets(ctx.user), teamLeader: null }; const leader = ctx.user.teamLeaderId ? (await db.select().from(teamLeaders).where(eq(teamLeaders.id, ctx.user.teamLeaderId)).limit(1))[0] : undefined; return { user: stripSecrets(ctx.user), teamLeader: leader ? { id: leader.id, name: leader.name, status: leader.status } : null }; }),
    updateProfile: protectedProcedure.input(z.object({ name: z.string().min(2).max(100), email: z.string().email().max(320), phoneNumber: z.string().regex(/^\+[1-9]\d{7,14}$/, "Use international phone format"), currentPassword: z.string().min(1) })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); if (!ctx.user.passwordHash || !verifyPassword(input.currentPassword, ctx.user.passwordHash)) throw new Error("Current password is incorrect"); const email = input.email.trim().toLowerCase(); const phone = input.phoneNumber.trim(); const others = (await db.select().from(users)).filter(user => user.id !== ctx.user.id); if (others.some(user => user.email?.toLowerCase() === email)) throw new Error("That email is already registered"); if (others.some(user => user.phoneNumber === phone)) throw new Error("That phone number is already registered"); await db.update(users).set({ name: input.name.trim(), email, phoneNumber: phone }).where(eq(users.id, ctx.user.id)); await setLocalSession(ctx, { openId: ctx.user.openId, name: input.name.trim() }, true); await addAuditLog({ action: "Profile Updated", userId: ctx.user.id, newValue: { name: input.name.trim(), email, phoneNumber: phone }, reason: "Password-confirmed self-service update" }); return { success: true, user: { name: input.name.trim(), email, phoneNumber: phone } }; }),
    logout: publicProcedure.mutation(async ({ ctx }) => { if (ctx.user) { const db = await getDb(); if (db) await db.update(userSessions).set({ isActive: 0, lastSeenAt: new Date() }).where(eq(userSessions.userId, ctx.user.id)); } ctx.res.clearCookie(COOKIE_NAME, { ...getSessionCookieOptions(ctx.req), maxAge: -1 }); return { success: true } as const; }),
    register: publicProcedure.input(z.object({ name: z.string().min(2).max(100), email: z.string().email().max(320), phoneNumber: z.string().regex(/^\+[1-9]\d{7,14}$/, "Use international format, e.g. +923001234567"), password: z.string().min(8), role: z.enum(["tester", "team_leader"]).default("tester"), teamLeaderId: z.number().int().positive().nullable().optional(), newTeamLeaderName: z.string().min(2).max(160).optional() })).mutation(async ({ input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); const email = input.email.trim().toLowerCase(); const phoneNumber = input.phoneNumber.trim(); const existing = await db.select().from(users); if (existing.some(user => user.email?.toLowerCase() === email)) throw new Error("That email is already registered"); if (existing.some(user => user.phoneNumber === phoneNumber)) throw new Error("That phone number is already registered"); let teamLeaderId: number | undefined; if (input.role === "tester") { if (input.teamLeaderId) { const leader = (await db.select().from(teamLeaders).where(eq(teamLeaders.id, input.teamLeaderId)).limit(1))[0]; if (!leader || leader.status !== "ACTIVE") throw new Error("Selected Team Leader is not active"); teamLeaderId = leader.id; } else if (input.newTeamLeaderName?.trim()) { const leaderName = input.newTeamLeaderName.trim(); const duplicate = (await db.select().from(teamLeaders)).find(item => cleanName(item.name) === cleanName(leaderName)); if (duplicate) { if (duplicate.status !== "ACTIVE") throw new Error("That Team Leader is not active"); teamLeaderId = duplicate.id; } else { const inserted = await db.insert(teamLeaders).values({ name: leaderName, notes: `Added during registration by ${input.name.trim()}` }).$returningId(); teamLeaderId = inserted[0]!.id; } } else throw new Error("Select an active Team Leader for this Tester account, or add a new one"); } const inserted = await db.insert(users).values({ openId: `local_${randomBytes(16).toString("hex")}`, name: input.name.trim(), email, phoneNumber, passwordHash: hashPassword(input.password), loginMethod: "local", role: "user", accountRole: email === "ffahadmustafaa@gmail.com" ? "admin" : input.role, teamLeaderId, accountStatus: "pending", isVerified: 0, emailVerified: 0, phoneVerified: 0 }).$returningId(); return { userId: inserted[0]!.id, email, phoneNumber, sandboxMode: true }; }),
    requestRegistrationOtp: publicProcedure.input(z.object({ userId: z.number() })).mutation(async ({ input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); const user = (await db.select().from(users).where(eq(users.id, input.userId)).limit(1))[0]; if (!user) throw new Error("Registration account not found"); const emailOtp = isSandboxAuth ? "123456" : String(Math.floor(100000 + Math.random() * 900000)); const phoneOtp = isSandboxAuth ? "123456" : String(Math.floor(100000 + Math.random() * 900000)); await db.insert(authChallenges).values({ userId: user.id, emailOtp, phoneOtp, expiresAt: new Date(Date.now() + 10 * 60 * 1000) }); await sendDualOtp(user.email ?? "", user.phoneNumber ?? "", emailOtp, phoneOtp); return { sandboxMode: isSandboxAuth, emailOtp: isSandboxAuth ? emailOtp : "", phoneOtp: isSandboxAuth ? phoneOtp : "", expiresInMinutes: 10, message: isSandboxAuth ? "Sandbox mode: use the displayed test codes." : "Dual OTP sent to the registered email and phone." }; }),
    verifyRegistrationOtp: publicProcedure.input(z.object({ userId: z.number(), emailOtp: z.string().length(6), phoneOtp: z.string().length(6), remember: z.boolean().optional().default(false) })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); const user = (await db.select().from(users).where(eq(users.id, input.userId)).limit(1))[0]; if (!user) throw new Error("Registration account not found"); const match = (await db.select().from(authChallenges)).reverse().find(item => item.userId === input.userId && item.emailOtp === input.emailOtp && item.phoneOtp === input.phoneOtp && item.isCompleted === 0 && item.expiresAt > new Date()); if (!match) throw new Error("Both OTP codes must be correct and unexpired."); const isRootAdmin = user.email?.toLowerCase() === "ffahadmustafaa@gmail.com"; await db.update(authChallenges).set({ isCompleted: 1 }).where(eq(authChallenges.id, match.id)); await db.update(users).set({ emailVerified: 1, phoneVerified: 1, isVerified: 1, accountStatus: "active", role: isRootAdmin ? "admin" : "user", accountRole: isRootAdmin ? "admin" : user.accountRole, lastSignedIn: new Date() }).where(eq(users.id, user.id)); if (user.accountRole === "team_leader") { const existingLeader = (await db.select().from(teamLeaders)).find(leader => cleanName(leader.name) === cleanName(user.name ?? "")); if (!existingLeader && user.name) await db.insert(teamLeaders).values({ name: user.name, status: "ACTIVE" }); } await setLocalSession(ctx, { openId: user.openId, name: user.name }, input.remember); return { success: true, redirect: isRootAdmin ? "/" : "/daily", role: isRootAdmin ? "admin" : user.accountRole }; }),
    login: publicProcedure.input(z.object({ identifier: z.string().min(3), password: z.string().min(1), remember: z.boolean().optional().default(false) })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); const identifier = input.identifier.trim().toLowerCase(); const user = (await db.select().from(users)).find(item => item.email?.toLowerCase() === identifier || item.phoneNumber?.toLowerCase() === identifier); if (!user || !user.passwordHash || !verifyPassword(input.password, user.passwordHash)) throw new Error("Invalid email/phone or password"); if (user.accountStatus === "blocked") throw new Error("This account is blocked"); if (!user.isVerified || !user.emailVerified || !user.phoneVerified) throw new Error("Verify both email and phone OTPs before signing in"); await db.update(users).set({ lastSignedIn: new Date() }).where(eq(users.id, user.id)); if (user.accountRole === "team_leader") { const existingLeader = (await db.select().from(teamLeaders)).find(leader => cleanName(leader.name) === cleanName(user.name ?? "")); if (!existingLeader && user.name) await db.insert(teamLeaders).values({ name: user.name, status: "ACTIVE" }); } await setLocalSession(ctx, { openId: user.openId, name: user.name }, input.remember); return { success: true, redirect: user.role === "admin" ? "/" : "/daily", role: user.accountRole }; }),
    requestPasswordReset: publicProcedure.input(z.object({ identifier: z.string().min(3).max(320) })).mutation(async ({ input }) => {
      const db = await getDb(); if (!db) throw new Error("Database is unavailable");
      const identifier = input.identifier.trim().toLowerCase();
      const user = (await db.select().from(users)).find(item => item.email?.toLowerCase() === identifier || item.phoneNumber?.toLowerCase() === identifier);
      if (!user || !user.email) return { accepted: true, sandboxMode: true, resetCode: String(Math.floor(100000 + Math.random() * 900000)) }; // no account enumeration: same shape, dummy code never stored
      const resetCode = String(Math.floor(100000 + Math.random() * 900000));
      await db.insert(otpVerifications).values({ identifier: `pwdreset:${user.id}`, otpCode: resetCode, expiresAt: new Date(Date.now() + 15 * 60 * 1000) });
      const delivery = await sendSecurityEmail(user.email, "Dream Telco password reset", `Your password reset code is ${resetCode}. It expires in 15 minutes. If you didn't request this, ignore this email.`);
      await addAuditLog({ action: "Password Reset Requested", userId: user.id, reason: "Forgot-password flow" });
      return { accepted: true, sandboxMode: delivery.sandbox, resetCode: delivery.sandbox ? resetCode : "" };
    }),
    resetPassword: publicProcedure.input(z.object({ identifier: z.string().min(3).max(320), resetCode: z.string().length(6), newPassword: z.string().min(8).max(128) })).mutation(async ({ input }) => {
      const db = await getDb(); if (!db) throw new Error("Database is unavailable");
      const identifier = input.identifier.trim().toLowerCase();
      const user = (await db.select().from(users)).find(item => item.email?.toLowerCase() === identifier || item.phoneNumber?.toLowerCase() === identifier);
      if (!user) throw new Error("Invalid or expired reset code");
      const match = (await db.select().from(otpVerifications)).reverse().find(item => item.identifier === `pwdreset:${user.id}` && item.otpCode === input.resetCode && item.isUsed === 0 && item.expiresAt > new Date());
      if (!match) throw new Error("Invalid or expired reset code");
      await db.update(otpVerifications).set({ isUsed: 1 }).where(eq(otpVerifications.id, match.id));
      await db.update(users).set({ passwordHash: hashPassword(input.newPassword) }).where(eq(users.id, user.id));
      await addAuditLog({ action: "Password Reset", userId: user.id, reason: "Forgot-password flow completed" });
      return { success: true };
    }),
    requestOtp: publicProcedure.input(z.object({ identifier: z.string().min(3).max(150) })).mutation(async ({ input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); const otpCode = String(Math.floor(100000 + Math.random() * 900000)); await db.insert(otpVerifications).values({ identifier: input.identifier.trim().toLowerCase(), otpCode, expiresAt: new Date(Date.now() + 10 * 60 * 1000) }); return { accepted: true, deliveryConfigured: false, message: "Verification record created. Configure an email/SMS provider before using this for production delivery." }; }),
    requestDualOtp: protectedProcedure.mutation(async ({ ctx }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); if (!ctx.user.email || !ctx.user.phoneNumber) throw new Error("Both an email address and phone number are required before requesting dual verification."); const emailOtp = String(Math.floor(100000 + Math.random() * 900000)); const phoneOtp = String(Math.floor(100000 + Math.random() * 900000)); await db.insert(authChallenges).values({ userId: ctx.user.id, emailOtp, phoneOtp, expiresAt: new Date(Date.now() + 10 * 60 * 1000) }); return { accepted: true, deliveryConfigured: false, message: "Dual challenge created. Connect approved email and SMS delivery before using this in production." }; }),
    verifyDualOtp: protectedProcedure.input(z.object({ emailOtp: z.string().length(6), phoneOtp: z.string().length(6) })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); const match = (await db.select().from(authChallenges)).reverse().find(item => item.userId === ctx.user.id && item.emailOtp === input.emailOtp && item.phoneOtp === input.phoneOtp && item.isCompleted === 0 && item.expiresAt > new Date()); if (!match) throw new Error("Both OTP codes must be correct and unexpired."); await db.update(authChallenges).set({ isCompleted: 1 }).where(eq(authChallenges.id, match.id)); await db.update(users).set({ emailVerified: 1, phoneVerified: 1, isVerified: 1, accountStatus: "active" }).where(eq(users.id, ctx.user.id)); await addAuditLog({ action: "Dual OTP Verified", userId: ctx.user.id, reason: "Email and phone challenge completed" }); return { success: true }; }),
    verifyOtp: protectedProcedure.input(z.object({ identifier: z.string().min(3).max(150), otpCode: z.string().length(6) })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); const match = (await db.select().from(otpVerifications)).reverse().find(item => item.identifier === input.identifier.trim().toLowerCase() && item.otpCode === input.otpCode && item.isUsed === 0 && item.expiresAt > new Date()); if (!match) throw new Error("Invalid or expired OTP"); await db.update(otpVerifications).set({ isUsed: 1 }).where(eq(otpVerifications.id, match.id)); const emailVerified = input.identifier.includes("@"); await db.update(users).set(emailVerified ? { emailVerified: 1 } : { phoneVerified: 1 }).where(eq(users.id, ctx.user.id)); return { success: true, requiresSecondChannel: true }; }),
  }),
  userManagement: router({
    directory: adminProcedure.query(async () => { const db = await getDb(); if (!db) return []; const [rows, leaders, sessions] = await Promise.all([db.select().from(users).orderBy(desc(users.createdAt)), db.select().from(teamLeaders), db.select().from(userSessions)]); return rows.map(user => { const { passwordHash: _passwordHash, ...safeUser } = user; return { ...safeUser, teamLeader: leaders.find(leader => leader.id === user.teamLeaderId)?.name ?? null, session: sessions.find(session => session.userId === user.id) ?? null }; }); }),
    updateStatus: adminProcedure.input(z.object({ userId: z.number(), status: z.enum(["active", "pending", "blocked"]), isVerified: z.number().int().min(0).max(1).optional() })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); if (input.userId === ctx.user.id && input.status === "blocked") throw new Error("You cannot block the current admin session"); await db.update(users).set({ accountStatus: input.status, isVerified: input.isVerified ?? (input.status === "active" ? 1 : 0) }).where(eq(users.id, input.userId)); await addAuditLog({ action: "User Status Updated", userId: ctx.user.id, newValue: input, reason: "Admin moderation" }); return { success: true }; }),
    updateRole: adminProcedure.input(z.object({ userId: z.number(), accountRole: z.enum(["admin", "team_leader", "tester"]), teamLeaderId: z.number().nullable().optional() })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); if (input.userId === ctx.user.id && input.accountRole !== "admin") throw new Error("The owner admin role cannot be removed from the current session"); await db.update(users).set({ accountRole: input.accountRole, teamLeaderId: input.accountRole === "tester" ? input.teamLeaderId ?? null : null }).where(eq(users.id, input.userId)); await addAuditLog({ action: "User Role Updated", userId: ctx.user.id, newValue: input, reason: "Admin role assignment" }); return { success: true }; }),
    delete: adminProcedure.input(z.object({ userId: z.number() })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); if (input.userId === ctx.user.id) throw new Error("You cannot delete the current admin session"); const old = (await db.select().from(users).where(eq(users.id, input.userId)).limit(1))[0]; if (!old) throw new Error("User not found"); await db.delete(users).where(eq(users.id, input.userId)); await addAuditLog({ action: "User Deleted", userId: ctx.user.id, oldValue: old, reason: "Admin moderation" }); return { success: true }; }),
  }),
  adminDashboard: router({
    reportDelivery: adminProcedure.query(() => reportDeliveryConfig()),
    sendTestReport: adminProcedure.mutation(async () => { const report = await compileDailyReport(); const delivery = await deliverDailyReport(report.date, report.workbook, `${report.summary}\n\nThis was a manual test dispatch from the Admin Dashboard.`); return { success: true, date: report.date, rows: report.rows.length, grandTotal: report.grandTotal, delivery }; }),
    exportReport: adminProcedure.mutation(async () => { const report = await compileDailyReport(); return { fileName: `Daily_Operations_Report_${report.date}.xlsx`, contentBase64: report.workbook.toString("base64"), date: report.date, rows: report.rows.length, grandTotal: report.grandTotal }; }),
    summary: adminProcedure.query(async () => { const db = await getDb(); if (!db) return { users: [], payouts: [], metrics: { totalUsers: 0, pendingUsers: 0, activeUsers: 0, blockedUsers: 0, pendingPayouts: 0, approvedPayouts: 0, paidPayouts: 0, payoutValue: 0 } }; const [userRows, payoutRows] = await Promise.all([db.select().from(users).orderBy(desc(users.createdAt)), db.select().from(payouts).orderBy(desc(payouts.createdAt)).limit(200)]); const safeUsers = userRows.map(user => { const { passwordHash: _passwordHash, ...safeUser } = user; return safeUser; }); const metrics = { totalUsers: safeUsers.length, pendingUsers: safeUsers.filter(user => user.accountStatus === "pending").length, activeUsers: safeUsers.filter(user => user.accountStatus === "active").length, blockedUsers: safeUsers.filter(user => user.accountStatus === "blocked").length, pendingPayouts: payoutRows.filter(row => row.reviewStatus === "PENDING").length, approvedPayouts: payoutRows.filter(row => row.reviewStatus === "APPROVED").length, paidPayouts: payoutRows.filter(row => row.reviewStatus === "PAID").length, payoutValue: payoutRows.filter(row => row.reviewStatus !== "REJECTED").reduce((sum, row) => sum + money(row.netPayout), 0) }; return { users: safeUsers, payouts: payoutRows, metrics }; }),
    approveUser: adminProcedure.input(z.object({ userId: z.number() })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); const target = (await db.select().from(users).where(eq(users.id, input.userId)).limit(1))[0]; if (!target) throw new Error("User not found"); await db.update(users).set({ accountStatus: "active", isVerified: 1 }).where(eq(users.id, input.userId)); await addAuditLog({ action: "User Approved", userId: ctx.user.id, newValue: { userId: input.userId, email: target.email }, reason: "Admin approval" }); return { success: true }; }),
    reviewPayout: adminProcedure.input(z.object({ payoutId: z.number(), reviewStatus: z.enum(["PENDING", "APPROVED", "REJECTED", "PAID"]) })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); const target = (await db.select().from(payouts).where(eq(payouts.id, input.payoutId)).limit(1))[0]; if (!target) throw new Error("Payout record not found"); if (input.reviewStatus === "APPROVED" && target.status !== "MATCHED") throw new Error("Only matched payout records can be approved"); await db.update(payouts).set({ reviewStatus: input.reviewStatus }).where(eq(payouts.id, input.payoutId)); await addAuditLog({ action: "Payout Review Updated", userId: ctx.user.id, oldValue: { reviewStatus: target.reviewStatus }, newValue: input, reason: "Admin payout control" }); return { success: true }; }),
  }),
  dashboard: router({
    overview: protectedProcedure.input(z.object({ date: dateInput })).query(async ({ ctx, input }) => {
      await ensureWorkspaceInitialized(ctx.user.id);
      let data = await getWorkspaceData(toDate(input.date));
      if (ctx.user.role !== "admin") {
        const ownName = cleanName(ctx.user.name ?? "");
        const ownLeaderIds = data.leaders.filter(leader => ctx.user.accountRole === "team_leader" && cleanName(leader.name) === ownName).map(leader => leader.id);
        const allowedTesterIds = data.testers.filter(tester => ctx.user.accountRole === "team_leader" ? ownLeaderIds.includes(tester.teamLeaderId) : cleanName(tester.name) === ownName).map(tester => tester.id);
        const allowedLeaderIds = data.testers.filter(tester => allowedTesterIds.includes(tester.id)).map(tester => tester.teamLeaderId);
        data = { ...data, leaders: data.leaders.filter(leader => allowedLeaderIds.includes(leader.id)), testers: data.testers.filter(tester => allowedTesterIds.includes(tester.id)), performance: data.performance.filter(row => allowedTesterIds.includes(row.testerId)), targets: data.targets.filter(row => (row.testerId != null && allowedTesterIds.includes(row.testerId)) || (row.teamLeaderId != null && allowedLeaderIds.includes(row.teamLeaderId))), payouts: data.payouts.filter(row => (row.testerId != null && allowedTesterIds.includes(row.testerId)) || (row.teamLeaderId != null && allowedLeaderIds.includes(row.teamLeaderId))) };
      }
      const projectMap = new Map(data.projects.map(project => [project.id, project]));
      const testerMap = new Map(data.testers.map(tester => [tester.id, tester]));
      const byLeader = new Map<number, { leaderId: number; leader: string; superX: number; sectionX: number; total: number; reporting: number; zero: number; activeTesters: number; testers: Record<string, number> }>();
      for (const leader of data.leaders.filter(item => item.status === "ACTIVE")) byLeader.set(leader.id, { leaderId: leader.id, leader: leader.name, superX: 0, sectionX: 0, total: 0, reporting: 0, zero: 0, activeTesters: data.testers.filter(t => t.teamLeaderId === leader.id && t.status === "ACTIVE").length, testers: {} });
      for (const row of data.performance) {
        const leader = byLeader.get(row.teamLeaderId); const project = projectMap.get(row.projectId); const tester = testerMap.get(row.testerId); const quantity = money(row.quantity);
        if (!leader) continue;
        leader.total += quantity; leader.testers[tester?.name ?? `Tester ${row.testerId}`] = (leader.testers[tester?.name ?? `Tester ${row.testerId}`] ?? 0) + quantity;
        if (project?.name === "Super X") leader.superX += quantity;
        else if (project?.name === "Section X") leader.sectionX += quantity;
      }
      Array.from(byLeader.values()).forEach(item => { item.reporting = Object.keys(item.testers).length; item.zero = Math.max(0, item.activeTesters - item.reporting); });
      const leaders = Array.from(byLeader.values()).map(item => ({ ...item, average: item.activeTesters ? item.total / item.activeTesters : 0, bestTester: Object.entries(item.testers).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—", lowestTester: Object.entries(item.testers).sort((a, b) => a[1] - b[1])[0]?.[0] ?? "—" }));
      const testerTotals: Array<[string, number]> = data.testers.map(t => [t.name, 0]);
      for (const row of data.performance) { const name = testerMap.get(row.testerId)?.name; if (!name) continue; const match = testerTotals.find(item => item[0] === name); if (match) match[1] += money(row.quantity); }
      const topTesters = testerTotals.sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, total]) => ({ name, total }));
      const payoutTotals = data.payouts.reduce((acc, item) => { acc.gross += money(item.grossPayout); acc.net += money(item.netPayout); if (item.status !== "MATCHED") acc.exceptions += 1; return acc; }, { gross: 0, net: 0, exceptions: 0 });
      return { date: toDate(input.date).toISOString(), leaders, projects: data.projects, testers: data.testers, performance: data.performance, targets: data.targets, payouts: data.payouts, imports: data.imports, topTesters, payoutTotals, totals: { superX: leaders.reduce((n, x) => n + x.superX, 0), sectionX: leaders.reduce((n, x) => n + x.sectionX, 0), total: leaders.reduce((n, x) => n + x.total, 0), activeTesters: data.testers.filter(t => t.status === "ACTIVE").length, reportingTesters: leaders.reduce((n, x) => n + x.reporting, 0), zeroTesters: leaders.reduce((n, x) => n + x.zero, 0) } };
    }),
  }),
  roster: router({
    list: protectedProcedure.query(async ({ ctx }) => { if (ctx.user.accountRole === "tester") return { leaders: [], testers: [] }; await ensureWorkspaceInitialized(ctx.user.id); const db = await getDb(); if (!db) return { leaders: [], testers: [] }; const leaderRows = await db.select().from(teamLeaders).orderBy(teamLeaders.name); const testerRows = await db.select().from(testers).orderBy(testers.name); if (ctx.user.accountRole === "team_leader") { const own = leaderRows.find(leader => cleanName(leader.name) === cleanName(ctx.user.name ?? "")); if (!own) return { leaders: [], testers: [] }; return { leaders: [own], testers: testerRows.filter(tester => tester.teamLeaderId === own.id) }; } return { leaders: leaderRows, testers: testerRows }; }),
    addLeader: adminProcedure.input(z.object({ name: z.string().min(2), notes: z.string().optional() })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); const inserted = await db.insert(teamLeaders).values({ name: input.name.trim(), notes: input.notes }).$returningId(); await addAuditLog({ action: "Team Leader Added", userId: ctx.user.id, newValue: input }); return inserted[0]; }),
    addTester: adminProcedure.input(z.object({ name: z.string().min(2), teamLeaderId: z.number(), notes: z.string().optional() })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); const name = input.name.trim(); const existing = (await db.select().from(testers)).find(item => cleanName(item.name) === cleanName(name)); if (existing) { await db.update(testers).set({ teamLeaderId: input.teamLeaderId, status: "ACTIVE", notes: input.notes }).where(eq(testers.id, existing.id)); await addAuditLog({ action: "Tester Reassigned", userId: ctx.user.id, oldValue: existing, newValue: input }); return { id: existing.id }; } const inserted = await db.insert(testers).values({ name, teamLeaderId: input.teamLeaderId, notes: input.notes }).$returningId(); await addAuditLog({ action: "Tester Added", userId: ctx.user.id, newValue: input }); return inserted[0]; }),
    moveTester: adminProcedure.input(z.object({ testerId: z.number(), teamLeaderId: z.number() })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); const old = await db.select().from(testers).where(eq(testers.id, input.testerId)).limit(1); await db.update(testers).set({ teamLeaderId: input.teamLeaderId }).where(eq(testers.id, input.testerId)); await addAuditLog({ action: "Tester Moved", userId: ctx.user.id, oldValue: old[0], newValue: input }); return { success: true }; }),
    toggleTester: adminProcedure.input(z.object({ testerId: z.number(), status: z.enum(["ACTIVE", "INACTIVE"]) })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); await db.update(testers).set({ status: input.status, dateInactive: input.status === "INACTIVE" ? new Date() : null }).where(eq(testers.id, input.testerId)); await addAuditLog({ action: input.status === "ACTIVE" ? "Tester Reactivated" : "Tester Deactivated", userId: ctx.user.id, newValue: input }); return { success: true }; }),
    deleteTester: adminProcedure.input(z.object({ testerId: z.number() })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); const old = (await db.select().from(testers).where(eq(testers.id, input.testerId)).limit(1))[0]; if (!old) throw new Error("Tester not found"); await db.delete(dailyPerformance).where(eq(dailyPerformance.testerId, input.testerId)); await db.delete(targets).where(eq(targets.testerId, input.testerId)); await db.delete(payouts).where(eq(payouts.testerId, input.testerId)); await db.delete(testers).where(eq(testers.id, input.testerId)); await addAuditLog({ action: "Tester Deleted", userId: ctx.user.id, oldValue: old, reason: "User requested roster cleanup" }); return { success: true }; }),
    deleteLeader: adminProcedure.input(z.object({ teamLeaderId: z.number() })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); const old = (await db.select().from(teamLeaders).where(eq(teamLeaders.id, input.teamLeaderId)).limit(1))[0]; if (!old) throw new Error("Team Leader not found"); const children = await db.select().from(testers).where(eq(testers.teamLeaderId, input.teamLeaderId)); for (const child of children) { await db.delete(dailyPerformance).where(eq(dailyPerformance.testerId, child.id)); await db.delete(targets).where(eq(targets.testerId, child.id)); await db.delete(payouts).where(eq(payouts.testerId, child.id)); } await db.delete(testers).where(eq(testers.teamLeaderId, input.teamLeaderId)); await db.delete(targets).where(eq(targets.teamLeaderId, input.teamLeaderId)); await db.delete(payouts).where(eq(payouts.teamLeaderId, input.teamLeaderId)); await db.delete(teamLeaders).where(eq(teamLeaders.id, input.teamLeaderId)); await addAuditLog({ action: "Team Leader Deleted", userId: ctx.user.id, oldValue: old, reason: "User requested roster cleanup" }); return { success: true }; }),
  }),
  projects: router({
    list: protectedProcedure.query(async () => { const db = await getDb(); if (!db) return []; return db.select().from(projects).orderBy(projects.id); }),
    add: adminProcedure.input(z.object({ name: z.string().min(1), notes: z.string().optional() })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); const inserted = await db.insert(projects).values({ name: input.name.trim(), notes: input.notes }).$returningId(); await addAuditLog({ action: "Project Added", userId: ctx.user.id, newValue: input }); return inserted[0]; }),
    rename: adminProcedure.input(z.object({ projectId: z.number(), name: z.string().min(1) })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); await db.update(projects).set({ name: input.name.trim() }).where(eq(projects.id, input.projectId)); await addAuditLog({ action: "Project Renamed", userId: ctx.user.id, newValue: input }); return { success: true }; }),
    delete: adminProcedure.input(z.object({ projectId: z.number() })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); const used = await db.select().from(dailyPerformance).where(eq(dailyPerformance.projectId, input.projectId)).limit(1); if (used.length) throw new Error("Project has report data and cannot be deleted; rename it instead."); await db.delete(projects).where(eq(projects.id, input.projectId)); await addAuditLog({ action: "Project Deleted", userId: ctx.user.id, newValue: input }); return { success: true }; }),
  }),
  payoutRules: router({
    list: protectedProcedure.query(async () => { const db = await getDb(); if (!db) return []; return db.select().from(payoutRules).where(eq(payoutRules.status, "ACTIVE")); }),
    upsert: adminProcedure.input(z.object({ projectId: z.number(), testerId: z.number().optional(), ratePerOtp: z.number().nonnegative().optional(), fixedAmount: z.number().nonnegative().optional(), notes: z.string().optional() })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); const existing = (await db.select().from(payoutRules)).find(rule => rule.projectId === input.projectId && rule.testerId === input.testerId && rule.status === "ACTIVE"); if (existing) await db.update(payoutRules).set({ ratePerOtp: input.ratePerOtp?.toString(), fixedAmount: input.fixedAmount?.toString(), notes: input.notes }).where(eq(payoutRules.id, existing.id)); else await db.insert(payoutRules).values({ projectId: input.projectId, testerId: input.testerId, ratePerOtp: input.ratePerOtp?.toString(), fixedAmount: input.fixedAmount?.toString(), notes: input.notes }); await addAuditLog({ action: "Payout Rule Updated", userId: ctx.user.id, newValue: input }); return { success: true }; }),
    calculate: protectedProcedure.input(z.object({ businessDate: z.string() })).query(async ({ ctx, input }) => { const db = await getDb(); if (!db) return { rows: [], totals: { payout: 0 } }; const [performance, rules, projectRows, roster, leaders] = await Promise.all([db.select().from(dailyPerformance).where(and(eq(dailyPerformance.businessDate, toDate(input.businessDate)))), db.select().from(payoutRules).where(eq(payoutRules.status, "ACTIVE")), db.select().from(projects), db.select().from(testers), db.select().from(teamLeaders)]); const visibleTesterIds = ctx.user.role === "admin" ? null : roster.filter(tester => ctx.user.accountRole === "team_leader" ? cleanName(leaders.find(leader => leader.id === tester.teamLeaderId)?.name ?? "") === cleanName(ctx.user.name ?? "") : cleanName(tester.name) === cleanName(ctx.user.name ?? "")).map(tester => tester.id); const rows = performance.filter(row => !visibleTesterIds || visibleTesterIds.includes(row.testerId)).map(row => { const rule = rules.find(item => item.projectId === row.projectId && item.testerId === row.testerId) ?? rules.find(item => item.projectId === row.projectId && !item.testerId); const otp = money(row.quantity); const payout = rule?.fixedAmount != null ? money(rule.fixedAmount) : otp * money(rule?.ratePerOtp); return { ...row, project: projectRows.find(item => item.id === row.projectId)?.name ?? "Unknown", tester: roster.find(item => item.id === row.testerId)?.name ?? "Unknown", leader: leaders.find(item => item.id === row.teamLeaderId)?.name ?? "Unassigned", otp, payout }; }); return { rows, totals: { payout: rows.reduce((sum, row) => sum + row.payout, 0) } }; }),
  }),
  performance: router({
    myHistory: protectedProcedure.query(async ({ ctx }) => { const db = await getDb(); if (!db) return []; const ownTester = ctx.user.accountRole === "tester" ? (await db.select().from(testers)).find(tester => cleanName(tester.name) === cleanName(ctx.user.name ?? "")) : undefined; const rows = ownTester ? await db.select().from(dailyPerformance).where(eq(dailyPerformance.testerId, ownTester.id)).orderBy(desc(dailyPerformance.businessDate)) : []; const projectRows = await db.select().from(projects); return rows.map(row => ({ ...row, project: projectRows.find(project => project.id === row.projectId)?.name ?? "Unknown" })).slice(0, 200); }),
    create: protectedProcedure.input(z.object({ businessDate: z.string(), testerId: z.number(), projectId: z.number(), quantity: z.union([z.number().nonnegative(), z.string().min(1).max(40)]), source: z.string().optional(), notes: z.string().optional() })).mutation(async ({ ctx, input }) => { const normalizedQuantity = parseQuantity(input.quantity); if (normalizedQuantity < 0) throw new Error("Quantity must be zero or greater"); const db = await getDb(); if (!db) throw new Error("Database is unavailable"); const tester = (await db.select().from(testers).where(eq(testers.id, input.testerId)).limit(1))[0]; if (!tester) throw new Error("Tester not found"); if (ctx.user.accountRole === "tester" && cleanName(tester.name) !== cleanName(ctx.user.name ?? "")) throw new Error("Testers can only submit their own numbers"); if (ctx.user.accountRole === "team_leader") { const assignedLeader = (await db.select().from(teamLeaders).where(eq(teamLeaders.id, tester.teamLeaderId)).limit(1))[0]; if (!assignedLeader || cleanName(assignedLeader.name) !== cleanName(ctx.user.name ?? "")) throw new Error("Team Leaders can only submit for their assigned team"); } const date = toDate(input.businessDate); const existing = (await db.select().from(dailyPerformance).where(and(eq(dailyPerformance.businessDate, date), eq(dailyPerformance.testerId, input.testerId), eq(dailyPerformance.projectId, input.projectId))).limit(1))[0]; if (existing) await db.update(dailyPerformance).set({ teamLeaderId: tester.teamLeaderId, quantity: (money(existing.quantity) + normalizedQuantity).toString(), source: input.source, notes: input.notes }).where(eq(dailyPerformance.id, existing.id)); else await db.insert(dailyPerformance).values({ businessDate: date, testerId: input.testerId, teamLeaderId: tester.teamLeaderId, projectId: input.projectId, quantity: normalizedQuantity.toString(), source: input.source, notes: input.notes }); await addAuditLog({ action: existing ? "Performance Accumulated" : "Performance Imported", userId: ctx.user.id, newValue: { ...input, quantity: normalizedQuantity }, oldValue: existing }); return { success: true, accumulated: Boolean(existing), total: existing ? money(existing.quantity) + normalizedQuantity : normalizedQuantity }; }),
  }),
  payouts: router({
    list: protectedProcedure.query(async ({ ctx }) => { const db = await getDb(); if (!db) return []; const rows = await db.select().from(payouts).orderBy(desc(payouts.createdAt)).limit(300); if (ctx.user.role === "admin") return rows; const [visible, leaders] = await Promise.all([db.select().from(testers), db.select().from(teamLeaders)]); const ids = visible.filter(tester => ctx.user.accountRole === "team_leader" ? cleanName(leaders.find(leader => leader.id === tester.teamLeaderId)?.name ?? "") === cleanName(ctx.user.name ?? "") : cleanName(tester.name) === cleanName(ctx.user.name ?? "")).map(tester => tester.id); return rows.filter(row => row.testerId != null && ids.includes(row.testerId)); }),
    update: adminProcedure.input(z.object({ payoutId: z.number(), netPayout: z.number().nonnegative(), grossPayout: z.number().nonnegative().optional(), deductions: z.number().nonnegative().optional(), notes: z.string().optional() })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); const old = (await db.select().from(payouts).where(eq(payouts.id, input.payoutId)).limit(1))[0]; if (!old) throw new Error("Payout record not found"); const gross = input.grossPayout ?? input.netPayout + (input.deductions ?? Number(old.deductions)); const deductions = input.deductions ?? Number(old.deductions); await db.update(payouts).set({ grossPayout: String(gross), deductions: String(deductions), netPayout: String(input.netPayout), notes: input.notes ?? old.notes }).where(eq(payouts.id, input.payoutId)); await addAuditLog({ action: "Payout Overridden", userId: ctx.user.id, oldValue: old, newValue: input, reason: "Root admin payout override" }); return { success: true }; }),
    delete: adminProcedure.input(z.object({ payoutId: z.number() })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); const old = (await db.select().from(payouts).where(eq(payouts.id, input.payoutId)).limit(1))[0]; if (!old) throw new Error("Payout record not found"); await db.delete(payouts).where(eq(payouts.id, input.payoutId)); await addAuditLog({ action: "Payout Deleted", userId: ctx.user.id, oldValue: old, reason: "Root admin payout override" }); return { success: true }; }),
    importText: protectedProcedure.input(z.object({ fileName: z.string(), rawText: z.string().min(1) })).mutation(async ({ ctx, input }) => {
      const db = await getDb(); if (!db) throw new Error("Database is unavailable");
      const roster = await db.select().from(testers); const leaders = await db.select().from(teamLeaders); const projectRows = await db.select().from(projects);
      const rows = input.rawText.split(/\r?\n/).map((line: string) => line.trim()).filter(Boolean); let matched = 0; let exceptions = 0; const created: unknown[] = [];
      const seenRows = new Set<string>();
      for (let index = 0; index < rows.length; index++) {
        const line = rows[index] ?? "";
        const parts = line.split(/[,\t|]+/).map((p: string) => p.trim()).filter(Boolean); const rawName = parts[0] ?? ""; const amountToken = parts.find((p: string) => /\d/.test(p) && !/^\d{4}-\d{2}-\d{2}$/.test(p)); const amount = amountToken ? Number(amountToken.replace(/[^0-9.-]/g, "")) : NaN; const exactMatches = roster.filter(item => item.name.toLowerCase() === rawName.toLowerCase()); const ambiguous = exactMatches.length > 1; const tester = exactMatches.length === 1 ? exactMatches[0] : undefined; const possible = !tester && !ambiguous ? roster.find(item => item.name.toLowerCase().startsWith(rawName.toLowerCase()) || rawName.toLowerCase().startsWith(item.name.toLowerCase())) : undefined; const duplicate = seenRows.has(line.toLowerCase()); seenRows.add(line.toLowerCase()); const leader = tester ? leaders.find(item => item.id === tester.teamLeaderId) : undefined; const status = !Number.isFinite(amount) ? "MISSING_AMOUNT" : duplicate ? "DUPLICATE" : ambiguous ? "CONFLICT" : tester ? "MATCHED" : possible ? "POSSIBLE_MATCH" : "UNMATCHED";
        if (status === "MATCHED") matched++; else exceptions++;
        const note = ambiguous ? `Ambiguous tester name matched ${exactMatches.length} roster records` : possible ? `Possible match: ${possible.name}` : duplicate ? "Repeated source row" : `Source row ${index + 1}`;
        const record = await db.insert(payouts).values({ payoutDate: new Date(), testerId: tester?.id, teamLeaderId: leader?.id, testerNameRaw: rawName || `Row ${index + 1}`, projectNameRaw: parts[1], projectId: projectRows.find(p => p.name.toLowerCase() === (parts[1] ?? "").toLowerCase())?.id, grossPayout: Number.isFinite(amount) ? amount.toString() : "0", deductions: "0", netPayout: Number.isFinite(amount) ? amount.toString() : "0", sourceFile: input.fileName, status: status as any, notes: note }).$returningId(); created.push(record[0]);
      }
      await db.insert(imports).values({ fileName: input.fileName, recordCount: rows.length, matchedCount: matched, exceptionCount: exceptions, status: exceptions ? "PARTIAL" : "PROCESSED", rawData: input.rawText });
      await addAuditLog({ action: "Payout Imported", userId: ctx.user.id, userCommand: input.fileName, newValue: { records: rows.length, matched, exceptions } });
      return { records: rows.length, matched, exceptions, created };
    }),
  }),
  targets: router({
    list: protectedProcedure.query(async () => { const db = await getDb(); if (!db) return []; return db.select().from(targets).where(eq(targets.status, "ACTIVE")); }),
    create: protectedProcedure.input(z.object({ target: z.number().nonnegative(), level: z.enum(["TESTER", "TEAM_LEADER", "PROJECT", "DAILY", "WEEKLY", "MONTHLY"]), testerId: z.number().optional(), teamLeaderId: z.number().optional(), projectId: z.number().optional(), effectiveDate: z.string(), endDate: z.string().optional() })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); const isAdmin = ctx.user.accountRole === "admin" || ctx.user.role === "admin"; if (ctx.user.accountRole === "tester") throw new Error("Only Team Leaders and Admins can set targets."); if (!isAdmin) { const leaders = await db.select().from(teamLeaders); const own = leaders.find(leader => cleanName(leader.name) === cleanName(ctx.user.name ?? "")); if (input.teamLeaderId && (!own || input.teamLeaderId !== own.id)) throw new Error("You can only set targets for your own team."); if (input.testerId) { const tester = (await db.select().from(testers).where(eq(testers.id, input.testerId)).limit(1))[0]; if (!tester || !own || tester.teamLeaderId !== own.id) throw new Error("You can only set targets for testers on your own team."); } } const inserted = await db.insert(targets).values({ target: input.target.toString(), level: input.level, testerId: input.testerId, teamLeaderId: input.teamLeaderId, projectId: input.projectId, effectiveDate: toDate(input.effectiveDate), endDate: input.endDate ? toDate(input.endDate) : undefined }); await addAuditLog({ action: "Target Changed", userId: ctx.user.id, newValue: input }); return inserted; }),
  }),
  audit: router({ list: protectedProcedure.query(({ ctx }) => { if (ctx.user.accountRole !== "admin" && ctx.user.role !== "admin") throw new Error("Only Admins can view the audit log."); return listAuditLogs(); }) }),
  assistant: router({
    chat: protectedProcedure.input(z.object({ messages: z.array(z.object({ role: z.enum(["user", "assistant", "system"]), content: z.string() })).min(1), businessDate: z.string().optional() })).mutation(async ({ ctx, input }) => {
      const latest = input.messages[input.messages.length - 1]?.content ?? "";
      const db = await getDb();
      if (!db) throw new Error("Database is unavailable");
      await ensureWorkspaceInitialized(ctx.user.id);
      const reportDate = input.businessDate ?? new Date().toISOString().slice(0, 10);
      const [roster, leaderRows, projectRows] = await Promise.all([db.select().from(testers), db.select().from(teamLeaders), db.select().from(projects).where(eq(projects.status, "ACTIVE")).orderBy(projects.id)]);
      const activeProjectNames = projectRows.map(project => project.name);
      const isAdmin = ctx.user.accountRole === "admin" || ctx.user.role === "admin";
      const commandUser: CommandUser = { id: ctx.user.id, name: ctx.user.name, accountRole: ctx.user.accountRole, isAdmin };
      const ownLeader = commandUser.accountRole === "team_leader" ? leaderRows.find(item => cleanName(item.name) === cleanName(commandUser.name ?? "")) : undefined;
      const scopeTesters = isAdmin ? roster : commandUser.accountRole === "team_leader" ? roster.filter(item => ownLeader && item.teamLeaderId === ownLeader.id) : roster.filter(item => cleanName(item.name) === cleanName(commandUser.name ?? ""));
      const scopeLeaders = isAdmin ? leaderRows : ownLeader ? [ownLeader] : [];

      // Layer 1: deterministic commands (instant, no LLM). Handles report logging with
      // accumulation + roster auto-add, add/remove tester/team leader, and set_target.
      const command = parseAssistantCommand(latest, activeProjectNames);
      if (command.type !== "unknown") {
        const content = await executeAssistantCommand(db, commandUser, command, { roster, leaderRows, projectRows, reportDate, latest });
        return { content, ingestion: null };
      }

      // Layer 2: deterministic workspace questions over role-scoped rows.
      const directAnswer = answerWorkspaceQuestion(latest, await buildWorkspaceSnapshot(db, scopeTesters, scopeLeaders, projectRows, reportDate));
      if (directAnswer) return { content: directAnswer, ingestion: null };

      // Layer 3: LLM fallback for multi-row reports, payout rules, and free-form chat.
      const answer = await invokeLLM({
        messages: [{ role: "system", content: `You are a daily operations, reporting, and payout engine. Return JSON only. Active project order is: ${activeProjectNames.join(" / ")}. Commands include addLeader, addTester, deleteLeader, deleteTester, addProject, renameProject, deleteProject, setPayoutRule. A setPayoutRule action stores either rate per OTP or a fixed tester/project amount; parse 2k, 3.5k, and 5k as 2000, 3500, and 5000. If the user asks for payout, set payoutRequested true. Only create roster/project/rule records for explicit database commands. For reports, parse named project values and slash notation X/Y or X/Y/Z strictly in active project order. Return one row per tester with a values array containing project names and quantities. Leave leader empty when omitted so the server can infer it. Fuzzy-match abbreviations and typos, but never invent counts. ` }, ...input.messages.map(message => ({ role: message.role as "user" | "assistant" | "system", content: message.content }))],
        response_format: { type: "json_schema", json_schema: { name: "assistant_command", strict: true, schema: { type: "object", properties: { answer: { type: "string" }, date: { type: "string" }, payoutRequested: { type: "boolean" }, actions: { type: "array", items: { type: "object", properties: { type: { type: "string", enum: ["addLeader", "addTester", "deleteLeader", "deleteTester", "addProject", "renameProject", "deleteProject", "setPayoutRule"] }, name: { type: "string" }, leader: { type: "string" }, projectId: { type: "number" }, project: { type: "string" }, tester: { type: "string" }, rate: { type: "number" }, fixed: { type: "number" } }, required: ["type", "name", "leader", "projectId", "project", "tester", "rate", "fixed"], additionalProperties: false } }, rows: { type: "array", items: { type: "object", properties: { leader: { type: "string" }, tester: { type: "string" }, values: { type: "array", items: { type: "object", properties: { project: { type: "string" }, quantity: { type: "number" } }, required: ["project", "quantity"], additionalProperties: false } } }, required: ["leader", "tester", "values"], additionalProperties: false } }, notes: { type: "array", items: { type: "string" } } }, required: ["answer", "date", "payoutRequested", "actions", "rows", "notes"], additionalProperties: false } } },
        max_tokens: 4000,
      });
      const responseContent = answer.choices?.[0]?.message?.content;
      let extraction: { answer?: string; date?: string; payoutRequested?: boolean; actions?: Array<{ type: string; name: string; leader: string; projectId: number; project: string; tester: string; rate: number; fixed: number }>; rows: Array<{ leader: string; tester: string; values: Array<{ project: string; quantity: number }> }>; notes?: string[] } = { rows: [] };
      try { extraction = JSON.parse(textFromLLM(responseContent ?? "{}")); } catch { /* fall through to normal chat response */ }
      const llmReportDate = extraction.date && /^\d{4}-\d{2}-\d{2}$/.test(extraction.date) ? extraction.date : reportDate;
      let stored = 0; const exceptions: string[] = [...(extraction.notes ?? [])];
      const reportRows: Array<{ leader: string; tester: string; superX: number; sectionX: number; total: number; superXPayout: number; sectionXPayout: number; totalPayout: number }> = [];
      if (db) {
        for (const action of extraction.actions ?? []) {
          const name = action.name.trim(); const leaderName = action.leader.trim();
          if (!isAdmin) { exceptions.push(`Admin approval is required for the ${action.type} command.`); continue; }
          if (action.type === "addLeader" && name) await db.insert(teamLeaders).values({ name }).onDuplicateKeyUpdate({ set: { status: "ACTIVE" } });
          if (action.type === "addProject" && action.project.trim()) await db.insert(projects).values({ name: action.project.trim() }).onDuplicateKeyUpdate({ set: { status: "ACTIVE" } });
          if (action.type === "renameProject" && action.projectId && action.project.trim()) await db.update(projects).set({ name: action.project.trim() }).where(eq(projects.id, action.projectId));
          if (action.type === "deleteProject" && action.projectId) { const used = await db.select().from(dailyPerformance).where(eq(dailyPerformance.projectId, action.projectId)).limit(1); if (!used.length) await db.delete(projects).where(eq(projects.id, action.projectId)); else exceptions.push(`Project ${action.project} has data and was not deleted`); }
          if (action.type === "setPayoutRule" && action.project.trim()) { const project = (await db.select().from(projects)).find(item => cleanName(item.name) === cleanName(action.project)); const tester = action.tester.trim() ? (await db.select().from(testers)).find(item => cleanName(item.name) === cleanName(action.tester)) : undefined; if (!project) exceptions.push(`Project ${action.project} was not found for payout rule`); else { const existing = (await db.select().from(payoutRules)).find(item => item.projectId === project.id && item.testerId === tester?.id && item.status === "ACTIVE"); const payload = { projectId: project.id, testerId: tester?.id, ratePerOtp: action.rate > 0 ? String(action.rate) : undefined, fixedAmount: action.fixed > 0 ? String(action.fixed) : undefined, notes: latest.slice(0, 1000) }; if (existing) await db.update(payoutRules).set(payload).where(eq(payoutRules.id, existing.id)); else await db.insert(payoutRules).values(payload); } }
          if (action.type === "addTester" && name && leaderName) { let leader = (await db.select().from(teamLeaders).where(eq(teamLeaders.name, leaderName)).limit(1))[0]; if (!leader) { const id = await db.insert(teamLeaders).values({ name: leaderName }).$returningId(); leader = { id: id[0]!.id, name: leaderName } as typeof leader; } await db.insert(testers).values({ name, teamLeaderId: leader.id }).onDuplicateKeyUpdate({ set: { status: "ACTIVE", teamLeaderId: leader.id } }); }
          if (action.type === "deleteLeader") { const leader = (await db.select().from(teamLeaders)).find(item => cleanName(item.name) === cleanName(name)); if (!leader) exceptions.push(`Team Leader ${name} was not found`); else { const activeChildren = (await db.select().from(testers)).filter(item => item.teamLeaderId === leader.id && item.status === "ACTIVE"); if (activeChildren.length) exceptions.push(`Cannot remove ${leader.name}: ${activeChildren.length} active tester(s) remain on the team`); else { await db.update(teamLeaders).set({ status: "INACTIVE" }).where(eq(teamLeaders.id, leader.id)); await addAuditLog({ action: "Team Leader Deactivated", userId: ctx.user.id, oldValue: leader, userCommand: latest, reason: "AI deletion command (history preserved)" }); } } }
          if (action.type === "deleteTester") { const matches = (await db.select().from(testers)).filter(item => cleanName(item.name) === cleanName(name)); if (!matches.length) exceptions.push(`Tester ${name} was not found`); for (const tester of matches) { await db.update(testers).set({ status: "INACTIVE", dateInactive: new Date() }).where(eq(testers.id, tester.id)); await addAuditLog({ action: "Tester Deactivated", userId: ctx.user.id, oldValue: tester, userCommand: latest, reason: "AI deletion command (history preserved)" }); } }
        }
        const [freshRoster, freshLeaders, freshProjects, rules] = await Promise.all([db.select().from(testers), db.select().from(teamLeaders), db.select().from(projects), db.select().from(payoutRules).where(eq(payoutRules.status, "ACTIVE"))]);
        const projectByName = new Map(freshProjects.map(project => [cleanName(project.name), project]));
        const grouped = new Map<string, { leaderName: string; testerName: string; values: Map<string, number>; tester?: typeof freshRoster[number]; leader?: typeof freshLeaders[number] }>();
        for (const row of extraction.rows) {
          const candidates = freshRoster.filter(item => cleanName(item.name) === cleanName(row.tester));
          const tester = candidates.length === 1 ? candidates[0] : undefined;
          const explicitLeader = row.leader.trim() ? freshLeaders.find(item => cleanName(item.name) === cleanName(row.leader)) : undefined;
          const inferredLeader = tester ? freshLeaders.find(item => item.id === tester.teamLeaderId) : undefined;
          const leader = explicitLeader ?? inferredLeader;
          const leaderName = leader?.name ?? (row.leader.trim() || "Unassigned");
          const key = `${cleanName(leaderName)}|${cleanName(row.tester)}`;
          const item = grouped.get(key) ?? { leaderName, testerName: row.tester.trim(), values: new Map<string, number>(), tester, leader };
          for (const value of row.values) item.values.set(cleanName(value.project), (item.values.get(cleanName(value.project)) ?? 0) + Number(value.quantity));
          item.tester = tester ?? item.tester; item.leader = leader ?? item.leader; grouped.set(key, item);
        }
        for (const tester of freshRoster.filter(item => item.status === "ACTIVE")) {
          const leader = freshLeaders.find(item => item.id === tester.teamLeaderId); if (!leader) continue;
          const key = `${cleanName(leader.name)}|${cleanName(tester.name)}`;
          if (!grouped.has(key)) grouped.set(key, { leaderName: leader.name, testerName: tester.name, values: new Map(), tester, leader });
        }
        for (const row of Array.from(grouped.values())) {
          const values = Array.from(projectByName.values()).map(project => ({ project, quantity: row.values.get(cleanName(project.name)) ?? 0 }));
          if (!row.tester || !row.leader) { exceptions.push(`Could not safely match ${row.testerName}; row kept in report only.`); reportRows.push({ leader: row.leaderName, tester: row.testerName, superX: row.values.get("super x") ?? 0, sectionX: row.values.get("section x") ?? 0, total: Array.from(row.values.values()).reduce((a, b) => a + b, 0), superXPayout: 0, sectionXPayout: 0, totalPayout: 0 }); continue; }
          for (const value of values.filter(item => row.values.has(cleanName(item.project.name)))) {
            const existing = await db.select().from(dailyPerformance).where(and(eq(dailyPerformance.businessDate, toDate(llmReportDate)), eq(dailyPerformance.testerId, row.tester.id), eq(dailyPerformance.projectId, value.project.id))).limit(1);
            const accumulated = (existing[0] ? money(existing[0].quantity) : 0) + value.quantity;
            if (existing[0]) await db.update(dailyPerformance).set({ quantity: String(accumulated), source: "AI assistant", notes: latest.slice(0, 1000) }).where(eq(dailyPerformance.id, existing[0].id));
            else await db.insert(dailyPerformance).values({ businessDate: toDate(llmReportDate), testerId: row.tester.id, teamLeaderId: row.leader.id, projectId: value.project.id, quantity: String(value.quantity), source: "AI assistant", notes: latest.slice(0, 1000) });
          }
          const saved = await db.select().from(dailyPerformance).where(and(eq(dailyPerformance.businessDate, toDate(llmReportDate)), eq(dailyPerformance.testerId, row.tester.id))).limit(50);
          const totals = new Map(freshProjects.map(project => [project.id, saved.filter(item => item.projectId === project.id).reduce((sum, item) => sum + Number(item.quantity), 0)]));
          const superX = totals.get(projectByName.get("super x")?.id ?? -1) ?? 0; const sectionX = totals.get(projectByName.get("section x")?.id ?? -1) ?? 0;
          const payoutsByProject = new Map(freshProjects.map(project => { const otp = totals.get(project.id) ?? 0; const rule = rules.find(item => item.projectId === project.id && item.testerId === row.tester?.id) ?? rules.find(item => item.projectId === project.id && !item.testerId); return [project.id, rule?.fixedAmount != null ? money(rule.fixedAmount) : otp * money(rule?.ratePerOtp)] as const; }));
          const superXPayout = payoutsByProject.get(projectByName.get("super x")?.id ?? -1) ?? 0; const sectionXPayout = payoutsByProject.get(projectByName.get("section x")?.id ?? -1) ?? 0;
          stored += 1; reportRows.push({ leader: row.leader.name, tester: row.tester.name, superX, sectionX, total: Array.from(totals.values()).reduce((a, b) => a + b, 0), superXPayout, sectionXPayout, totalPayout: Array.from(payoutsByProject.values()).reduce((a, b) => a + b, 0) });
        }
        await db.insert(imports).values({ fileName: `AI assistant ${llmReportDate}`, recordCount: extraction.rows.length, matchedCount: stored, exceptionCount: exceptions.length, status: exceptions.length ? "PARTIAL" : "PROCESSED", rawData: latest });
        await addAuditLog({ action: "AI Report Imported", userId: ctx.user.id, userCommand: latest, newValue: { date: llmReportDate, stored, exceptions: exceptions.length } });
      }
      const content = extraction.rows.length ? `Stored ${stored} tester rows for ${llmReportDate}. I separated the data by Team Leader and kept ${exceptions.length} validation note${exceptions.length === 1 ? "" : "s"}. You can download the formatted report below.` : extraction.answer || `I received: ${latest}. Include tester names with Section X and Super X values when you want me to store a report.`;
      return { content, ingestion: extraction.rows.length || extraction.payoutRequested ? { date: llmReportDate, stored, exceptions, rows: reportRows, payoutRequested: Boolean(extraction.payoutRequested) } : null };
    }),
    uploadDataset: protectedProcedure.input(z.object({ fileName: z.string().min(1).max(200), dataBase64: z.string().min(1) })).mutation(async ({ ctx, input }) => {
      const db = await getDb(); if (!db) throw new Error("Database is unavailable");
      if (input.dataBase64.length > 8 * 1024 * 1024) throw new Error("File is too large (max ~6 MB).");
      const sheets = parseWorkbook(Buffer.from(input.dataBase64, "base64"), input.fileName);
      const summary = summarizeDataset(sheets);
      const storable = sheets.map(sheet => ({ name: sheet.name, rows: sheet.rows.slice(0, 2000) }));
      const inserted = await db.insert(imports).values({ fileName: input.fileName, uploadedBy: ctx.user.id, recordCount: sheets.reduce((n, sheet) => n + sheet.rows.length, 0), matchedCount: 0, exceptionCount: 0, status: "PROCESSED", rawData: JSON.stringify(storable) }).$returningId();
      await addAuditLog({ action: "Dataset Uploaded", userId: ctx.user.id, newValue: { fileName: input.fileName, sheets: sheets.length } });
      return { importId: inserted[0]!.id, summary, sheets: sheets.length };
    }),
    askDataset: protectedProcedure.input(z.object({ importId: z.number().int().positive(), question: z.string().min(2).max(500) })).mutation(async ({ ctx, input }) => {
      const db = await getDb(); if (!db) throw new Error("Database is unavailable");
      const row = (await db.select().from(imports).where(eq(imports.id, input.importId)).limit(1))[0];
      if (!row) throw new Error("Dataset not found.");
      if (row.uploadedBy !== ctx.user.id && ctx.user.accountRole !== "admin") throw new Error("You can only ask about datasets you uploaded.");
      const answer = answerDatasetQuestion(input.question, JSON.parse(row.rawData ?? "[]"));
      return { answer: answer ?? "I couldn't answer that from this file. Try asking for a total by name, top performers, or a project comparison." };
    }),
  }),
});

export type AppRouter = typeof appRouter;
