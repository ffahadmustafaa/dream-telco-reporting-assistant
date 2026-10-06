import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { invokeLLM } from "./_core/llm";
import { adminProcedure, protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { createSessionToken } from "./_core/session";
import {
  addAuditLog,
  deletePayout,
  deletePayoutsByLeader,
  deletePayoutsByTester,
  deletePerformanceByTester,
  deleteProject,
  deleteTargetsByLeader,
  deleteTargetsByTester,
  deleteTeamLeader,
  deleteTester,
  deleteTestersByLeader,
  deleteMyAccount,
  deleteUser,
  ensureWorkspaceInitialized,
  findPerformance,
  getAppSettings,
  getImport,
  getPayout,
  getTeamLeader,
  getTester,
  getUser,
  getWorkspaceData,
  insertAuthChallenge,
  insertImport,
  insertOtpVerification,
  insertPayout,
  insertPayoutRule,
  insertPerformance,
  insertProject,
  insertTarget,
  insertTeamLeader,
  insertTester,
  insertUser,
  isDbConfigured,
  listActiveProjects,
  listActivePayoutRules,
  listActiveTargets,
  listAuditLogs,
  listAuthChallenges,
  listImports,
  listOtpVerifications,
  listPayoutRules,
  listPayouts,
  listPerformanceByDate,
  listPerformanceByDateRange,
  listPerformanceByProject,
  listPerformanceByTester,
  listProjects,
  listTeamLeaders,
  listTesters,
  listUserSessions,
  getUserByEmail,
  getUserByIdentifier,
  getUserByPhone,
  listUsers,
  updateAuthChallenge,
  updateOtpVerification,
  updatePayout,
  updatePayoutRule,
  updatePerformance,
  updateAppSettings,
  updateProject,
  updateTeamLeader,
  updateTester,
  updateUser,
  updateUserSessionByUserId,
  upsertProjectByName,
  upsertTeamLeader,
  upsertTesterByName,
  type Payout,
  type Project,
  type TeamLeader,
  type Tester,
  type Target,
  getTarget,
  updateTarget,
  deleteTarget,
} from "./db";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { isSandboxAuth, sendDualOtp, sendSecurityEmail } from "./_core/authDelivery";
import { compileDailyReport } from "./scheduledReports";
import { deliverDailyReport, reportAutomationStatus, reportDeliveryConfig } from "./reportDelivery";
import { analyzeOtp, fetchWhitenoiseSms, getWhitenoiseConfig, getWhitenoiseRoster, parseManualSmsLog, saveWhitenoiseCredentials, saveWhitenoiseRoster, wnRangeEnd, wnRangeStart, type WnSmsRecord } from "./whitenoise";
import { answerWorkspaceQuestion, parseAssistantCommand, parseQuestionDateRange, type AssistantCommand, type WorkspaceSnapshot } from "./aiAssistant";
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
const setLocalSession = async (ctx: { req: any; res: any }, user: { openId: string; name: string | null }, remember = false) => { const token = await createSessionToken(user.openId, { name: user.name ?? "Workspace user" }); ctx.res.cookie(COOKIE_NAME, token, { ...getSessionCookieOptions(ctx.req), ...(remember ? { maxAge: 365 * 24 * 60 * 60 * 1000 } : {}) }); };
const stripSecrets = (user: any) => { if (!user) return null; const { passwordHash: _passwordHash, ...safeUser } = user; return safeUser; };

type RosterTester = Tester;
type RosterLeader = TeamLeader;
type ProjectRecord = Project;
type CommandUser = { id: number; name: string | null; accountRole: "admin" | "team_leader" | "tester"; isAdmin: boolean };
type CommandData = { roster: RosterTester[]; leaderRows: RosterLeader[]; projectRows: ProjectRecord[]; reportDate: string; latest: string };

/** Role-scoped snapshot for deterministic assistant Q&A. */
async function buildWorkspaceSnapshot(scopeTesters: RosterTester[], scopeLeaders: RosterLeader[], projectRows: ProjectRecord[], fromDate: string, toDateStr: string, dateLabel: string): Promise<WorkspaceSnapshot> {
  const endExclusive = new Date(`${toDateStr}T00:00:00.000Z`);
  endExclusive.setDate(endExclusive.getDate() + 1);
  const perf = await listPerformanceByDateRange(toDate(fromDate), endExclusive);
  const testerIds = new Set(scopeTesters.map(item => item.id));
  return {
    testers: scopeTesters.map(item => ({ id: item.id, name: item.name, teamLeaderId: item.teamLeaderId, status: item.status })),
    leaders: scopeLeaders.map(item => ({ id: item.id, name: item.name, status: item.status })),
    projects: projectRows.map(item => ({ id: item.id, name: item.name })),
    performance: perf.filter(item => testerIds.has(item.testerId)).map(item => ({ testerId: item.testerId, projectId: item.projectId, quantity: money(item.quantity) })),
    dateLabel,
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
async function executeAssistantCommand(user: CommandUser, command: AssistantCommand, data: CommandData): Promise<string> {
  const { roster, leaderRows, projectRows, reportDate, latest } = data;
  const findLeader = (name: string) => leaderRows.find(item => cleanName(item.name) === cleanName(name));
  const findTesters = (name: string) => roster.filter(item => cleanName(item.name) === cleanName(name));
  const ownLeader = user.accountRole === "team_leader" ? findLeader(user.name ?? "") : undefined;

  const accumulate = async (testerId: number, teamLeaderId: number, projectId: number, quantity: number) => {
    const date = toDate(reportDate);
    const existing = await findPerformance(date, testerId, projectId);
    const total = (existing ? money(existing.quantity) : 0) + quantity;
    if (existing) await updatePerformance(existing.id, { teamLeaderId, quantity: total, source: "AI assistant", notes: latest.slice(0, 1000) });
    else await insertPerformance({ businessDate: date, testerId, teamLeaderId, projectId, quantity, source: "AI assistant", notes: latest.slice(0, 1000) });
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
            leader = await upsertTeamLeader(command.teamLeader);
            leaderRows.push(leader);
            createdNote = ` Created Team Leader ${command.teamLeader}.`;
          }
          if (!leader) {
            if (user.accountRole === "team_leader" && ownLeader) leader = ownLeader;
            else return `I don't know a tester named "${command.name}". Add "under <Team Leader>" to the message and I'll add them to the roster automatically.`;
          }
          if (user.accountRole === "team_leader" && (!ownLeader || leader.id !== ownLeader.id)) return "You can only add testers to your own team.";
          tester = await upsertTesterByName(command.name, leader.id);
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
        await updateTester(existing.id, { status: "ACTIVE", teamLeaderId: leader.id });
        return `${command.name} is back on the roster under ${leader.name}.`;
      }
      await insertTester({ name: command.name, teamLeaderId: leader.id });
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
        await updateTester(item.id, { status: "INACTIVE", dateInactive: new Date() });
        await addAuditLog({ action: "Tester Deactivated", userId: user.id, userCommand: latest, oldValue: item, reason: "AI removal command (history preserved)" });
        lines.push(`Deactivated ${item.name}. Their past reports are kept.`);
      }
      return lines.join(" ");
    }
    case "add_team_leader": {
      if (!user.isAdmin) return "Only an Admin can add a Team Leader.";
      const existing = findLeader(command.name);
      if (existing) {
        await updateTeamLeader(existing.id, { status: "ACTIVE" });
        return `${command.name} is already a Team Leader (reactivated).`;
      }
      await insertTeamLeader({ name: command.name });
      await addAuditLog({ action: "Team Leader Added", userId: user.id, userCommand: latest, newValue: { name: command.name } });
      return `Added Team Leader ${command.name}.`;
    }
    case "remove_team_leader": {
      if (!user.isAdmin) return "Only an Admin can remove a Team Leader.";
      const leader = findLeader(command.name);
      if (!leader) return `I couldn't find Team Leader "${command.name}".`;
      const activeChildren = roster.filter(item => item.teamLeaderId === leader.id && item.status === "ACTIVE");
      if (activeChildren.length) return `Can't remove ${leader.name}: ${activeChildren.length} active tester${activeChildren.length === 1 ? "" : "s"} (${activeChildren.map(item => item.name).join(", ")}) ${activeChildren.length === 1 ? "is" : "are"} still on the team. Move or deactivate them first.`;
      await updateTeamLeader(leader.id, { status: "INACTIVE" });
      await addAuditLog({ action: "Team Leader Deactivated", userId: user.id, userCommand: latest, oldValue: leader, reason: "AI removal command (history preserved)" });
      return `Deactivated Team Leader ${leader.name}. Their history is preserved.`;
    }
    case "set_target": {
      if (user.accountRole === "tester") return "Only Team Leaders and Admins can set targets.";
      const matches = findTesters(command.name).filter(item => item.status === "ACTIVE");
      const tester = user.accountRole === "team_leader" ? matches.find(item => ownLeader && item.teamLeaderId === ownLeader.id) : matches[0];
      if (!tester) return `I couldn't find an active tester named "${command.name}"${user.accountRole === "team_leader" ? " on your team" : ""}.`;
      await insertTarget({ target: command.quantity, level: "TESTER", testerId: tester.id, effectiveDate: toDate(reportDate) });
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
    registrationTeamLeaders: publicProcedure.query(async () => {
      if (!isDbConfigured()) return [];
      const [rosterLeaders, activeUsers] = await Promise.all([(await listTeamLeaders()).filter(leader => leader.status === "ACTIVE"), listUsers()]);
      const names = new Set(rosterLeaders.map(leader => cleanName(leader.name)));
      const userNames = activeUsers.filter(user => user.accountRole === "team_leader" && user.accountStatus === "active" && user.name && !names.has(cleanName(user.name))).map(user => ({ id: user.id, name: user.name!, status: "ACTIVE" as const }));
      return [...rosterLeaders.map(leader => ({ id: leader.id, name: leader.name, status: leader.status })), ...userNames].sort((a, b) => a.name.localeCompare(b.name));
    }),
    me: publicProcedure.query(opts => stripSecrets(opts.ctx.user)),
    myProfile: protectedProcedure.query(async ({ ctx }) => {
      if (!isDbConfigured()) return { user: stripSecrets(ctx.user), teamLeader: null };
      const leader = ctx.user.teamLeaderId ? await getTeamLeader(ctx.user.teamLeaderId) : undefined;
      return { user: stripSecrets(ctx.user), teamLeader: leader ? { id: leader.id, name: leader.name, status: leader.status } : null };
    }),
    updateProfile: protectedProcedure.input(z.object({ name: z.string().min(2).max(100), email: z.string().email().max(320), phoneNumber: z.string().regex(/^\+[1-9]\d{7,14}$/, "Use international phone format"), currentPassword: z.string().min(1), newPassword: z.string().min(8).max(128).optional() })).mutation(async ({ ctx, input }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      if (!ctx.user.passwordHash || !verifyPassword(input.currentPassword, ctx.user.passwordHash)) throw new Error("Current password is incorrect");
      const email = input.email.trim().toLowerCase(); const phone = input.phoneNumber.trim();
      const others = (await listUsers()).filter(user => user.id !== ctx.user.id);
      if (others.some(user => user.email?.toLowerCase() === email)) throw new Error("That email is already registered");
      if (others.some(user => user.phoneNumber === phone)) throw new Error("That phone number is already registered");
      const patch: Record<string, unknown> = { name: input.name.trim(), email, phoneNumber: phone };
      if (input.newPassword) {
        if (verifyPassword(input.newPassword, ctx.user.passwordHash)) throw new Error("New password must be different from the current password");
        patch.passwordHash = hashPassword(input.newPassword);
      }
      await updateUser(ctx.user.id, patch as Parameters<typeof updateUser>[1]);
      await setLocalSession(ctx, { openId: ctx.user.openId, name: input.name.trim() }, true);
      await addAuditLog({ action: input.newPassword ? "Profile & Password Updated" : "Profile Updated", userId: ctx.user.id, newValue: { name: input.name.trim(), email, phoneNumber: phone, passwordChanged: Boolean(input.newPassword) }, reason: "Password-confirmed self-service update" });
      return { success: true, passwordChanged: Boolean(input.newPassword), user: { name: input.name.trim(), email, phoneNumber: phone } };
    }),
    logout: publicProcedure.mutation(async ({ ctx }) => {
      if (ctx.user) {
        if (isDbConfigured()) await updateUserSessionByUserId(ctx.user.id, { isActive: 0, lastSeenAt: new Date() });
      }
      ctx.res.clearCookie(COOKIE_NAME, { ...getSessionCookieOptions(ctx.req), maxAge: -1 });
      return { success: true } as const;
    }),
    deleteMyAccount: protectedProcedure.mutation(async ({ ctx }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      if (ctx.user.accountRole === "admin" || ctx.user.role === "admin") throw new Error("Admin accounts cannot be deleted from the profile page");
      const old = { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email };
      await deleteMyAccount(ctx.user.id);
      await addAuditLog({ action: "Account Self-Deleted", userId: ctx.user.id, oldValue: old, reason: "Member deleted their own account from the profile page" });
      ctx.res.clearCookie(COOKIE_NAME, { ...getSessionCookieOptions(ctx.req), maxAge: -1 });
      return { success: true } as const;
    }),
    register: publicProcedure.input(z.object({ name: z.string().min(2).max(100), email: z.string().email().max(320), phoneNumber: z.string().regex(/^\+[1-9]\d{7,14}$/, "Use international format, e.g. +923001234567"), password: z.string().min(8), role: z.enum(["tester", "team_leader"]).default("tester"), teamLeaderId: z.number().int().positive().nullable().optional(), newTeamLeaderName: z.string().min(2).max(160).optional() })).mutation(async ({ input }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      const email = input.email.trim().toLowerCase(); const phoneNumber = input.phoneNumber.trim();
      if (await getUserByEmail(email)) throw new Error("That email is already registered");
      if (await getUserByPhone(phoneNumber)) throw new Error("That phone number is already registered");
      let teamLeaderId: number | undefined;
      if (input.role === "tester") {
        if (input.teamLeaderId) {
          const leader = await getTeamLeader(input.teamLeaderId);
          if (leader && leader.status === "ACTIVE") {
            teamLeaderId = leader.id;
          } else {
            // The signup dropdown also lists team-leader login accounts (users
            // collection). Fall back to validating the user account, then link
            // the tester through that leader's roster entry (created if missing).
            const userLeader = await getUser(input.teamLeaderId);
            if (!userLeader || userLeader.accountRole !== "team_leader" || userLeader.accountStatus !== "active") {
              throw new Error("Selected Team Leader is not active");
            }
            teamLeaderId = (await upsertTeamLeader(userLeader.name?.trim() || "Team Leader")).id;
          }
        } else if (input.newTeamLeaderName?.trim()) {
          const leaderName = input.newTeamLeaderName.trim();
          const duplicate = (await listTeamLeaders()).find(item => cleanName(item.name) === cleanName(leaderName));
          if (duplicate) {
            if (duplicate.status !== "ACTIVE") throw new Error("That Team Leader is not active");
            teamLeaderId = duplicate.id;
          } else {
            teamLeaderId = await insertTeamLeader({ name: leaderName, notes: `Added during registration by ${input.name.trim()}` });
          }
        } else throw new Error("Select an active Team Leader for this Tester account, or add a new one");
      }
      const userId = await insertUser({ openId: `local_${randomBytes(16).toString("hex")}`, name: input.name.trim(), email, phoneNumber, passwordHash: hashPassword(input.password), loginMethod: "local", role: "user", accountRole: email === "ffahadmustafaa@gmail.com" ? "admin" : input.role, teamLeaderId: teamLeaderId ?? null, accountStatus: "pending", isVerified: 0, emailVerified: 0, phoneVerified: 0 });
      return { userId, email, phoneNumber, sandboxMode: true };
    }),
    requestRegistrationOtp: publicProcedure.input(z.object({ userId: z.number() })).mutation(async ({ input }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      const user = await getUser(input.userId);
      if (!user) throw new Error("Registration account not found");
      const emailOtp = isSandboxAuth ? "123456" : String(Math.floor(100000 + Math.random() * 900000));
      const phoneOtp = isSandboxAuth ? "123456" : String(Math.floor(100000 + Math.random() * 900000));
      await insertAuthChallenge({ userId: user.id, emailOtp, phoneOtp, expiresAt: new Date(Date.now() + 10 * 60 * 1000), isCompleted: 0 });
      await sendDualOtp(user.email ?? "", user.phoneNumber ?? "", emailOtp, phoneOtp);
      return { sandboxMode: isSandboxAuth, emailOtp: isSandboxAuth ? emailOtp : "", phoneOtp: isSandboxAuth ? phoneOtp : "", expiresInMinutes: 10, message: isSandboxAuth ? "Sandbox mode: use the displayed test codes." : "Dual OTP sent to the registered email and phone." };
    }),
    verifyRegistrationOtp: publicProcedure.input(z.object({ userId: z.number(), emailOtp: z.string().length(6), phoneOtp: z.string().length(6), remember: z.boolean().optional().default(false) })).mutation(async ({ ctx, input }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      const user = await getUser(input.userId);
      if (!user) throw new Error("Registration account not found");
      const match = (await listAuthChallenges()).find(item => item.userId === input.userId && item.emailOtp === input.emailOtp && item.phoneOtp === input.phoneOtp && item.isCompleted === 0 && item.expiresAt > new Date());
      if (!match) throw new Error("Both OTP codes must be correct and unexpired.");
      const isRootAdmin = user.email?.toLowerCase() === "ffahadmustafaa@gmail.com";
      await updateAuthChallenge(match.id, { isCompleted: 1 });
      await updateUser(user.id, { emailVerified: 1, phoneVerified: 1, isVerified: 1, accountStatus: "active", role: isRootAdmin ? "admin" : "user", accountRole: isRootAdmin ? "admin" : user.accountRole, lastSignedIn: new Date() });
      if (user.accountRole === "team_leader") {
        const existingLeader = (await listTeamLeaders()).find(leader => cleanName(leader.name) === cleanName(user.name ?? ""));
        if (!existingLeader && user.name) await insertTeamLeader({ name: user.name, status: "ACTIVE" });
      }
      if (user.accountRole === "tester" && user.name && user.teamLeaderId) {
        await upsertTesterByName(user.name, user.teamLeaderId);
      }
      await setLocalSession(ctx, { openId: user.openId, name: user.name }, input.remember);
      return { success: true, redirect: isRootAdmin ? "/" : "/daily", role: isRootAdmin ? "admin" : user.accountRole };
    }),
    login: publicProcedure.input(z.object({ identifier: z.string().min(3), password: z.string().min(1), remember: z.boolean().optional().default(false) })).mutation(async ({ ctx, input }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      const identifier = input.identifier.trim().toLowerCase();
      const user = await getUserByIdentifier(identifier);
      if (!user || !user.passwordHash || !verifyPassword(input.password, user.passwordHash)) throw new Error("Invalid email/phone or password");
      if (user.accountStatus === "blocked") throw new Error("This account is blocked");
      if (!user.isVerified || !user.emailVerified || !user.phoneVerified) throw new Error("Verify both email and phone OTPs before signing in");
      await updateUser(user.id, { lastSignedIn: new Date() });
      if (user.accountRole === "team_leader") {
        const existingLeader = (await listTeamLeaders()).find(leader => cleanName(leader.name) === cleanName(user.name ?? ""));
        if (!existingLeader && user.name) await insertTeamLeader({ name: user.name, status: "ACTIVE" });
      }
      if (user.accountRole === "tester" && user.name && user.teamLeaderId) {
        await upsertTesterByName(user.name, user.teamLeaderId);
      }
      await setLocalSession(ctx, { openId: user.openId, name: user.name }, input.remember);
      return { success: true, redirect: user.role === "admin" ? "/" : "/daily", role: user.accountRole };
    }),
    requestPasswordReset: publicProcedure.input(z.object({ identifier: z.string().min(3).max(320) })).mutation(async ({ input }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      const identifier = input.identifier.trim().toLowerCase();
      const user = await getUserByIdentifier(identifier);
      if (!user || !user.email) return { accepted: true, sandboxMode: true, resetCode: String(Math.floor(100000 + Math.random() * 900000)) }; // no account enumeration: same shape, dummy code never stored
      const resetCode = String(Math.floor(100000 + Math.random() * 900000));
      await insertOtpVerification({ identifier: `pwdreset:${user.id}`, otpCode: resetCode, expiresAt: new Date(Date.now() + 15 * 60 * 1000), isUsed: 0 });
      const delivery = await sendSecurityEmail(user.email, "Dream Telco password reset", `Your password reset code is ${resetCode}. It expires in 15 minutes. If you didn't request this, ignore this email.`);
      await addAuditLog({ action: "Password Reset Requested", userId: user.id, reason: "Forgot-password flow" });
      return { accepted: true, sandboxMode: delivery.sandbox, resetCode: delivery.sandbox ? resetCode : "" };
    }),
    resetPassword: publicProcedure.input(z.object({ identifier: z.string().min(3).max(320), resetCode: z.string().length(6), newPassword: z.string().min(8).max(128) })).mutation(async ({ input }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      const identifier = input.identifier.trim().toLowerCase();
      const user = await getUserByIdentifier(identifier);
      if (!user) throw new Error("Invalid or expired reset code");
      const match = (await listOtpVerifications()).find(item => item.identifier === `pwdreset:${user.id}` && item.otpCode === input.resetCode && item.isUsed === 0 && item.expiresAt > new Date());
      if (!match) throw new Error("Invalid or expired reset code");
      await updateOtpVerification(match.id, { isUsed: 1 });
      await updateUser(user.id, { passwordHash: hashPassword(input.newPassword) });
      await addAuditLog({ action: "Password Reset", userId: user.id, reason: "Forgot-password flow completed" });
      return { success: true };
    }),
    requestOtp: publicProcedure.input(z.object({ identifier: z.string().min(3).max(150) })).mutation(async ({ input }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      const otpCode = String(Math.floor(100000 + Math.random() * 900000));
      await insertOtpVerification({ identifier: input.identifier.trim().toLowerCase(), otpCode, expiresAt: new Date(Date.now() + 10 * 60 * 1000), isUsed: 0 });
      return { accepted: true, deliveryConfigured: false, message: "Verification record created. Configure an email/SMS provider before using this for production delivery." };
    }),
    requestDualOtp: protectedProcedure.mutation(async ({ ctx }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      if (!ctx.user.email || !ctx.user.phoneNumber) throw new Error("Both an email address and phone number are required before requesting dual verification.");
      const emailOtp = String(Math.floor(100000 + Math.random() * 900000));
      const phoneOtp = String(Math.floor(100000 + Math.random() * 900000));
      await insertAuthChallenge({ userId: ctx.user.id, emailOtp, phoneOtp, expiresAt: new Date(Date.now() + 10 * 60 * 1000), isCompleted: 0 });
      return { accepted: true, deliveryConfigured: false, message: "Dual challenge created. Connect approved email and SMS delivery before using this in production." };
    }),
    verifyDualOtp: protectedProcedure.input(z.object({ emailOtp: z.string().length(6), phoneOtp: z.string().length(6) })).mutation(async ({ ctx, input }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      const match = (await listAuthChallenges()).find(item => item.userId === ctx.user.id && item.emailOtp === input.emailOtp && item.phoneOtp === input.phoneOtp && item.isCompleted === 0 && item.expiresAt > new Date());
      if (!match) throw new Error("Both OTP codes must be correct and unexpired.");
      await updateAuthChallenge(match.id, { isCompleted: 1 });
      await updateUser(ctx.user.id, { emailVerified: 1, phoneVerified: 1, isVerified: 1, accountStatus: "active" });
      await addAuditLog({ action: "Dual OTP Verified", userId: ctx.user.id, reason: "Email and phone challenge completed" });
      return { success: true };
    }),
    verifyOtp: protectedProcedure.input(z.object({ identifier: z.string().min(3).max(150), otpCode: z.string().length(6) })).mutation(async ({ ctx, input }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      const match = (await listOtpVerifications()).find(item => item.identifier === input.identifier.trim().toLowerCase() && item.otpCode === input.otpCode && item.isUsed === 0 && item.expiresAt > new Date());
      if (!match) throw new Error("Invalid or expired OTP");
      await updateOtpVerification(match.id, { isUsed: 1 });
      const emailVerified = input.identifier.includes("@");
      await updateUser(ctx.user.id, emailVerified ? { emailVerified: 1 } : { phoneVerified: 1 });
      return { success: true, requiresSecondChannel: true };
    }),
  }),
  userManagement: router({
    directory: adminProcedure.query(async () => {
      if (!isDbConfigured()) return [];
      const [rows, leaders, sessions] = await Promise.all([listUsers(), listTeamLeaders(), listUserSessions()]);
      return rows.map(user => { const { passwordHash: _passwordHash, ...safeUser } = user; return { ...safeUser, teamLeader: leaders.find(leader => leader.id === user.teamLeaderId)?.name ?? null, session: sessions.find(session => session.userId === user.id) ?? null }; });
    }),
    updateStatus: adminProcedure.input(z.object({ userId: z.number(), status: z.enum(["active", "pending", "blocked"]), isVerified: z.number().int().min(0).max(1).optional() })).mutation(async ({ ctx, input }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      if (input.userId === ctx.user.id && input.status === "blocked") throw new Error("You cannot block the current admin session");
      await updateUser(input.userId, { accountStatus: input.status, isVerified: input.isVerified ?? (input.status === "active" ? 1 : 0) });
      await addAuditLog({ action: "User Status Updated", userId: ctx.user.id, newValue: input, reason: "Admin moderation" });
      return { success: true };
    }),
    updateRole: adminProcedure.input(z.object({ userId: z.number(), accountRole: z.enum(["admin", "team_leader", "tester"]), teamLeaderId: z.number().nullable().optional() })).mutation(async ({ ctx, input }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      if (input.userId === ctx.user.id && input.accountRole !== "admin") throw new Error("The owner admin role cannot be removed from the current session");
      await updateUser(input.userId, { accountRole: input.accountRole, teamLeaderId: input.accountRole === "tester" ? input.teamLeaderId ?? null : null });
      await addAuditLog({ action: "User Role Updated", userId: ctx.user.id, newValue: input, reason: "Admin role assignment" });
      return { success: true };
    }),
    delete: adminProcedure.input(z.object({ userId: z.number() })).mutation(async ({ ctx, input }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      if (input.userId === ctx.user.id) throw new Error("You cannot delete the current admin session");
      const old = await getUser(input.userId);
      if (!old) throw new Error("User not found");
      await deleteUser(input.userId);
      await addAuditLog({ action: "User Deleted", userId: ctx.user.id, oldValue: old, reason: "Admin moderation" });
      return { success: true };
    }),
  }),
  whitenoise: router({
    getConfig: adminProcedure.query(async () => {
      const config = await getWhitenoiseConfig();
      const roster = await getWhitenoiseRoster();
      return { email: config.email, hasPassword: config.hasPassword, rosterCount: roster.length };
    }),
    saveCredentials: adminProcedure.input(z.object({ email: z.string().email().max(320), password: z.string().min(1).max(256) })).mutation(async ({ input }) => {
      await saveWhitenoiseCredentials(input.email, input.password);
      return { success: true } as const;
    }),
    getRoster: adminProcedure.query(async () => getWhitenoiseRoster()),
    saveRoster: adminProcedure.input(z.object({ rows: z.array(z.object({ tester: z.string().max(160), teamLeader: z.string().max(160), number: z.string().max(32) })).max(2000) })).mutation(async ({ input }) => {
      return saveWhitenoiseRoster(input.rows);
    }),
    /**
     * Run an OTP check. Uses saved credentials + roster unless overridden.
     * Set manualSmsRows to bypass whitenoise auto-fetch (fallback).
     */
    check: adminProcedure.input(z.object({
      dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      roster: z.array(z.object({ tester: z.string().max(160), teamLeader: z.string().max(160), number: z.string().max(32) })).max(2000).optional(),
      manualSmsRows: z.array(z.array(z.string().max(2000))).max(20000).optional(),
      useAutoFetch: z.boolean().default(true),
    })).mutation(async ({ input }) => {
      const roster = input.roster?.length ? input.roster : await getWhitenoiseRoster();
      if (!roster.length) throw new Error("No tester roster. Upload the tester Excel first.");
      let sms: WnSmsRecord[];
      let source: "whitenoise" | "manual";
      if (input.manualSmsRows?.length) {
        sms = parseManualSmsLog(input.manualSmsRows);
        source = "manual";
      } else if (input.useAutoFetch) {
        const config = await getWhitenoiseConfig();
        if (!config.email || !config.password) throw new Error("Whitenoise credentials are not configured. Save them first, or upload the SMS log manually.");
        const numbers = roster.map(r => r.number).filter(Boolean);
        sms = await fetchWhitenoiseSms(config.email, config.password, {
          dateFrom: wnRangeStart(input.dateFrom),
          dateTo: wnRangeEnd(input.dateTo),
          numbers,
        });
        source = "whitenoise";
      } else {
        throw new Error("No SMS data source. Enable auto-fetch or upload the SMS log.");
      }
      const analysis = analyzeOtp(roster, sms);
      return { ...analysis, smsCount: sms.length, source, dateFrom: input.dateFrom, dateTo: input.dateTo };
    }),
  }),
  adminDashboard: router({
    reportDelivery: adminProcedure.query(() => reportDeliveryConfig()),
    sendTestReport: adminProcedure.mutation(async () => { const report = await compileDailyReport(); const delivery = await deliverDailyReport(report.date, report.workbook, `${report.summary}\n\nThis was a manual test dispatch from the Admin Dashboard.`); return { success: true, date: report.date, rows: report.rows.length, grandTotal: report.grandTotal, delivery }; }),
    exportReport: adminProcedure.mutation(async () => { const report = await compileDailyReport(); return { fileName: `Daily_Operations_Report_${report.date}.xlsx`, contentBase64: report.workbook.toString("base64"), date: report.date, rows: report.rows.length, grandTotal: report.grandTotal }; }),
    summary: adminProcedure.query(async () => {
      if (!isDbConfigured()) return { users: [], payouts: [], metrics: { totalUsers: 0, pendingUsers: 0, activeUsers: 0, blockedUsers: 0, pendingPayouts: 0, approvedPayouts: 0, paidPayouts: 0, payoutValue: 0 } };
      const [userRows, payoutRows] = await Promise.all([listUsers(), listPayouts(200)]);
      const safeUsers = userRows.map(user => { const { passwordHash: _passwordHash, ...safeUser } = user; return safeUser; });
      const metrics = { totalUsers: safeUsers.length, pendingUsers: safeUsers.filter(user => user.accountStatus === "pending").length, activeUsers: safeUsers.filter(user => user.accountStatus === "active").length, blockedUsers: safeUsers.filter(user => user.accountStatus === "blocked").length, pendingPayouts: payoutRows.filter(row => row.reviewStatus === "PENDING").length, approvedPayouts: payoutRows.filter(row => row.reviewStatus === "APPROVED").length, paidPayouts: payoutRows.filter(row => row.reviewStatus === "PAID").length, payoutValue: payoutRows.filter(row => row.reviewStatus !== "REJECTED").reduce((sum, row) => sum + money(row.netPayout), 0) };
      return { users: safeUsers, payouts: payoutRows, metrics };
    }),
    approveUser: adminProcedure.input(z.object({ userId: z.number() })).mutation(async ({ ctx, input }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      const target = await getUser(input.userId);
      if (!target) throw new Error("User not found");
      await updateUser(input.userId, { accountStatus: "active", isVerified: 1 });
      await addAuditLog({ action: "User Approved", userId: ctx.user.id, newValue: { userId: input.userId, email: target.email }, reason: "Admin approval" });
      return { success: true };
    }),
    reviewPayout: adminProcedure.input(z.object({ payoutId: z.number(), reviewStatus: z.enum(["PENDING", "APPROVED", "REJECTED", "PAID"]) })).mutation(async ({ ctx, input }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      const target = await getPayout(input.payoutId);
      if (!target) throw new Error("Payout record not found");
      if (input.reviewStatus === "APPROVED" && target.status !== "MATCHED") throw new Error("Only matched payout records can be approved");
      await updatePayout(input.payoutId, { reviewStatus: input.reviewStatus });
      await addAuditLog({ action: "Payout Review Updated", userId: ctx.user.id, oldValue: { reviewStatus: target.reviewStatus }, newValue: input, reason: "Admin payout control" });
      return { success: true };
    }),
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
        const projectName = (project?.name ?? "").toLowerCase();
        if (projectName === "super x") leader.superX += quantity;
        else if (project) leader.sectionX += quantity;
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
    list: protectedProcedure.query(async ({ ctx }) => {
      if (ctx.user.accountRole === "tester") return { leaders: [], testers: [] };
      await ensureWorkspaceInitialized(ctx.user.id);
      if (!isDbConfigured()) return { leaders: [], testers: [] };
      const leaderRows = await listTeamLeaders(); const testerRows = await listTesters();
      if (ctx.user.accountRole === "team_leader") { const own = leaderRows.find(leader => cleanName(leader.name) === cleanName(ctx.user.name ?? "")); if (!own) return { leaders: [], testers: [] }; return { leaders: [own], testers: testerRows.filter(tester => tester.teamLeaderId === own.id) }; }
      return { leaders: leaderRows, testers: testerRows };
    }),
    addLeader: adminProcedure.input(z.object({ name: z.string().min(2), notes: z.string().optional() })).mutation(async ({ ctx, input }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      const id = await insertTeamLeader({ name: input.name.trim(), status: "ACTIVE", notes: input.notes ?? null });
      await addAuditLog({ action: "Team Leader Added", userId: ctx.user.id, newValue: input });
      return { id };
    }),
    addTester: adminProcedure.input(z.object({ name: z.string().min(2), teamLeaderId: z.number(), notes: z.string().optional() })).mutation(async ({ ctx, input }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      const name = input.name.trim();
      const existing = (await listTesters()).find(item => cleanName(item.name) === cleanName(name));
      if (existing) {
        await updateTester(existing.id, { teamLeaderId: input.teamLeaderId, status: "ACTIVE", notes: input.notes ?? null });
        await addAuditLog({ action: "Tester Reassigned", userId: ctx.user.id, oldValue: existing, newValue: input });
        return { id: existing.id };
      }
      const id = await insertTester({ name, teamLeaderId: input.teamLeaderId, status: "ACTIVE", notes: input.notes ?? null });
      await addAuditLog({ action: "Tester Added", userId: ctx.user.id, newValue: input });
      return { id };
    }),
    moveTester: adminProcedure.input(z.object({ testerId: z.number(), teamLeaderId: z.number() })).mutation(async ({ ctx, input }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      const old = await getTester(input.testerId);
      await updateTester(input.testerId, { teamLeaderId: input.teamLeaderId });
      await addAuditLog({ action: "Tester Moved", userId: ctx.user.id, oldValue: old, newValue: input });
      return { success: true };
    }),
    toggleTester: adminProcedure.input(z.object({ testerId: z.number(), status: z.enum(["ACTIVE", "INACTIVE"]) })).mutation(async ({ ctx, input }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      await updateTester(input.testerId, { status: input.status, dateInactive: input.status === "INACTIVE" ? new Date() : null });
      await addAuditLog({ action: input.status === "ACTIVE" ? "Tester Reactivated" : "Tester Deactivated", userId: ctx.user.id, newValue: input });
      return { success: true };
    }),
    deleteTester: adminProcedure.input(z.object({ testerId: z.number() })).mutation(async ({ ctx, input }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      const old = await getTester(input.testerId);
      if (!old) throw new Error("Tester not found");
      await deletePerformanceByTester(input.testerId);
      await deleteTargetsByTester(input.testerId);
      await deletePayoutsByTester(input.testerId);
      await deleteTester(input.testerId);
      await addAuditLog({ action: "Tester Deleted", userId: ctx.user.id, oldValue: old, reason: "User requested roster cleanup" });
      return { success: true };
    }),
    addOwnTester: protectedProcedure.input(z.object({ name: z.string().min(2), notes: z.string().optional() })).mutation(async ({ ctx, input }) => {
      if (ctx.user.accountRole !== "team_leader") throw new Error("Only Team Leaders can use this action");
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      const own = (await listTeamLeaders()).find(leader => cleanName(leader.name) === cleanName(ctx.user.name ?? ""));
      if (!own) throw new Error("No team is linked to your account");
      const name = input.name.trim();
      const existing = (await listTesters()).find(item => cleanName(item.name) === cleanName(name));
      if (existing) {
        if (existing.teamLeaderId !== own.id) throw new Error("A tester with this name already exists on another team");
        await updateTester(existing.id, { status: "ACTIVE", notes: input.notes ?? existing.notes });
        await addAuditLog({ action: "Tester Rejoined (Leader)", userId: ctx.user.id, oldValue: existing, newValue: input });
        return { id: existing.id };
      }
      const id = await insertTester({ name, teamLeaderId: own.id, status: "ACTIVE", notes: input.notes ?? null });
      await addAuditLog({ action: "Tester Added (Leader)", userId: ctx.user.id, newValue: { ...input, teamLeaderId: own.id } });
      return { id };
    }),
    updateOwnTester: protectedProcedure.input(z.object({ testerId: z.number(), name: z.string().min(2).optional(), status: z.enum(["ACTIVE", "INACTIVE"]).optional() })).mutation(async ({ ctx, input }) => {
      if (ctx.user.accountRole !== "team_leader") throw new Error("Only Team Leaders can use this action");
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      const own = (await listTeamLeaders()).find(leader => cleanName(leader.name) === cleanName(ctx.user.name ?? ""));
      const target = await getTester(input.testerId);
      if (!own || !target || target.teamLeaderId !== own.id) throw new Error("You can only manage testers on your own team");
      const patch: Record<string, unknown> = {};
      if (input.name) patch.name = input.name.trim();
      if (input.status) { patch.status = input.status; patch.dateInactive = input.status === "INACTIVE" ? new Date() : null; }
      await updateTester(input.testerId, patch as Partial<Tester>);
      await addAuditLog({ action: "Tester Updated (Leader)", userId: ctx.user.id, oldValue: { id: target.id, name: target.name, status: target.status }, newValue: input });
      return { success: true };
    }),
    deleteLeader: adminProcedure.input(z.object({ teamLeaderId: z.number() })).mutation(async ({ ctx, input }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      const old = await getTeamLeader(input.teamLeaderId);
      if (!old) throw new Error("Team Leader not found");
      const children = (await listTesters()).filter(tester => tester.teamLeaderId === input.teamLeaderId);
      for (const child of children) {
        await deletePerformanceByTester(child.id);
        await deleteTargetsByTester(child.id);
        await deletePayoutsByTester(child.id);
      }
      await deleteTestersByLeader(input.teamLeaderId);
      await deleteTargetsByLeader(input.teamLeaderId);
      await deletePayoutsByLeader(input.teamLeaderId);
      await deleteTeamLeader(input.teamLeaderId);
      await addAuditLog({ action: "Team Leader Deleted", userId: ctx.user.id, oldValue: old, reason: "User requested roster cleanup" });
      return { success: true };
    }),
  }),
  projects: router({
    list: protectedProcedure.query(async () => { if (!isDbConfigured()) return []; return listProjects(); }),
    add: adminProcedure.input(z.object({ name: z.string().min(1), notes: z.string().optional() })).mutation(async ({ ctx, input }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      const id = await insertProject({ name: input.name.trim(), notes: input.notes ?? null });
      await addAuditLog({ action: "Project Added", userId: ctx.user.id, newValue: input });
      return { id };
    }),
    rename: adminProcedure.input(z.object({ projectId: z.number(), name: z.string().min(1) })).mutation(async ({ ctx, input }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      await updateProject(input.projectId, { name: input.name.trim() });
      await addAuditLog({ action: "Project Renamed", userId: ctx.user.id, newValue: input });
      return { success: true };
    }),
    delete: adminProcedure.input(z.object({ projectId: z.number() })).mutation(async ({ ctx, input }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      const used = await listPerformanceByProject(input.projectId, 1);
      if (used.length) throw new Error("Project has report data and cannot be deleted; rename it instead.");
      await deleteProject(input.projectId);
      await addAuditLog({ action: "Project Deleted", userId: ctx.user.id, newValue: input });
      return { success: true };
    }),
  }),
  payoutRules: router({
    list: protectedProcedure.query(async () => { if (!isDbConfigured()) return []; return listActivePayoutRules(); }),
    upsert: adminProcedure.input(z.object({ projectId: z.number(), testerId: z.number().optional(), ratePerOtp: z.number().nonnegative().optional(), fixedAmount: z.number().nonnegative().optional(), notes: z.string().optional() })).mutation(async ({ ctx, input }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      const existing = (await listPayoutRules()).find(rule => rule.projectId === input.projectId && rule.testerId === input.testerId && rule.status === "ACTIVE");
      if (existing) await updatePayoutRule(existing.id, { ratePerOtp: input.ratePerOtp, fixedAmount: input.fixedAmount, notes: input.notes });
      else await insertPayoutRule({ projectId: input.projectId, testerId: input.testerId, ratePerOtp: input.ratePerOtp, fixedAmount: input.fixedAmount, notes: input.notes });
      await addAuditLog({ action: "Payout Rule Updated", userId: ctx.user.id, newValue: input });
      return { success: true };
    }),
    calculate: protectedProcedure.input(z.object({ businessDate: z.string() })).query(async ({ ctx, input }) => {
      if (!isDbConfigured()) return { rows: [], totals: { payout: 0 } };
      const [performance, rules, projectRows, roster, leaders] = await Promise.all([listPerformanceByDate(toDate(input.businessDate)), listActivePayoutRules(), listProjects(), listTesters(), listTeamLeaders()]);
      const visibleTesterIds = ctx.user.role === "admin" ? null : roster.filter(tester => ctx.user.accountRole === "team_leader" ? cleanName(leaders.find(leader => leader.id === tester.teamLeaderId)?.name ?? "") === cleanName(ctx.user.name ?? "") : cleanName(tester.name) === cleanName(ctx.user.name ?? "")).map(tester => tester.id);
      const rows = performance.filter(row => !visibleTesterIds || visibleTesterIds.includes(row.testerId)).map(row => {
        const rule = rules.find(item => item.projectId === row.projectId && item.testerId === row.testerId) ?? rules.find(item => item.projectId === row.projectId && !item.testerId);
        const otp = money(row.quantity);
        const payout = rule?.fixedAmount != null ? money(rule.fixedAmount) : otp * money(rule?.ratePerOtp);
        return { ...row, project: projectRows.find(item => item.id === row.projectId)?.name ?? "Unknown", tester: roster.find(item => item.id === row.testerId)?.name ?? "Unknown", leader: leaders.find(item => item.id === row.teamLeaderId)?.name ?? "Unassigned", otp, payout };
      });
      return { rows, totals: { payout: rows.reduce((sum, row) => sum + row.payout, 0) } };
    }),
  }),
  performance: router({
    myHistory: protectedProcedure.query(async ({ ctx }) => {
      if (!isDbConfigured()) return [];
      const ownTester = ctx.user.accountRole === "tester" ? (await listTesters()).find(tester => cleanName(tester.name) === cleanName(ctx.user.name ?? "")) : undefined;
      const rows = ownTester ? await listPerformanceByTester(ownTester.id) : [];
      const projectRows = await listProjects();
      return rows.map(row => ({ ...row, project: projectRows.find(project => project.id === row.projectId)?.name ?? "Unknown" })).slice(0, 200);
    }),
    teamHistory: protectedProcedure.query(async ({ ctx }) => {
      if (!isDbConfigured()) return [];
      if (ctx.user.accountRole !== "team_leader") throw new Error("Only team leaders can view team history");
      const leader = (await listTeamLeaders()).find(item => cleanName(item.name) === cleanName(ctx.user.name ?? ""));
      if (!leader) return [];
      const testers = (await listTesters()).filter(tester => tester.teamLeaderId === leader.id);
      const projectRows = await listProjects();
      const projectName = (id: number) => projectRows.find(project => project.id === id)?.name ?? "Unknown";
      const groups = [];
      for (const tester of testers) {
        const rows = await listPerformanceByTester(tester.id, 200);
        groups.push({
          testerId: tester.id,
          testerName: tester.name,
          status: tester.status,
          total: rows.reduce((sum, row) => sum + Number(row.quantity), 0),
          records: rows.map(row => ({ id: row.id, businessDate: row.businessDate, project: projectName(row.projectId), quantity: Number(row.quantity), source: row.source ?? null })),
        });
      }
      return groups;
    }),
    create: protectedProcedure.input(z.object({ businessDate: z.string(), testerId: z.number(), projectId: z.number(), quantity: z.union([z.number().nonnegative(), z.string().min(1).max(40)]), source: z.string().optional(), notes: z.string().optional() })).mutation(async ({ ctx, input }) => {
      const normalizedQuantity = parseQuantity(input.quantity);
      if (normalizedQuantity < 0) throw new Error("Quantity must be zero or greater");
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      const tester = await getTester(input.testerId);
      if (!tester) throw new Error("Tester not found");
      if (ctx.user.accountRole === "tester" && cleanName(tester.name) !== cleanName(ctx.user.name ?? "")) throw new Error("Testers can only submit their own numbers");
      if (ctx.user.accountRole === "team_leader") {
        const assignedLeader = await getTeamLeader(tester.teamLeaderId);
        if (!assignedLeader || cleanName(assignedLeader.name) !== cleanName(ctx.user.name ?? "")) throw new Error("Team Leaders can only submit for their assigned team");
      }
      const date = toDate(input.businessDate);
      const existing = await findPerformance(date, input.testerId, input.projectId);
      if (existing) await updatePerformance(existing.id, { teamLeaderId: tester.teamLeaderId, quantity: money(existing.quantity) + normalizedQuantity, source: input.source, notes: input.notes });
      else await insertPerformance({ businessDate: date, testerId: input.testerId, teamLeaderId: tester.teamLeaderId, projectId: input.projectId, quantity: normalizedQuantity, source: input.source, notes: input.notes });
      await addAuditLog({ action: existing ? "Performance Accumulated" : "Performance Imported", userId: ctx.user.id, newValue: { ...input, quantity: normalizedQuantity }, oldValue: existing });
      return { success: true, accumulated: Boolean(existing), total: existing ? money(existing.quantity) + normalizedQuantity : normalizedQuantity };
    }),
  }),
  payouts: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      if (!isDbConfigured()) return [];
      const rows = await listPayouts();
      if (ctx.user.role === "admin") return rows;
      const [visible, leaders] = await Promise.all([listTesters(), listTeamLeaders()]);
      const ids = visible.filter(tester => ctx.user.accountRole === "team_leader" ? cleanName(leaders.find(leader => leader.id === tester.teamLeaderId)?.name ?? "") === cleanName(ctx.user.name ?? "") : cleanName(tester.name) === cleanName(ctx.user.name ?? "")).map(tester => tester.id);
      return rows.filter(row => row.testerId != null && ids.includes(row.testerId));
    }),
    update: adminProcedure.input(z.object({ payoutId: z.number(), netPayout: z.number().nonnegative(), grossPayout: z.number().nonnegative().optional(), deductions: z.number().nonnegative().optional(), notes: z.string().optional() })).mutation(async ({ ctx, input }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      const old = await getPayout(input.payoutId);
      if (!old) throw new Error("Payout record not found");
      const gross = input.grossPayout ?? input.netPayout + (input.deductions ?? old.deductions);
      const deductions = input.deductions ?? old.deductions;
      await updatePayout(input.payoutId, { grossPayout: gross, deductions, netPayout: input.netPayout, notes: input.notes ?? old.notes });
      await addAuditLog({ action: "Payout Overridden", userId: ctx.user.id, oldValue: old, newValue: input, reason: "Root admin payout override" });
      return { success: true };
    }),
    delete: adminProcedure.input(z.object({ payoutId: z.number() })).mutation(async ({ ctx, input }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      const old = await getPayout(input.payoutId);
      if (!old) throw new Error("Payout record not found");
      await deletePayout(input.payoutId);
      await addAuditLog({ action: "Payout Deleted", userId: ctx.user.id, oldValue: old, reason: "Root admin payout override" });
      return { success: true };
    }),
    importText: protectedProcedure.input(z.object({ fileName: z.string(), rawText: z.string().min(1) })).mutation(async ({ ctx, input }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      const roster = await listTesters(); const leaders = await listTeamLeaders(); const projectRows = await listProjects();
      const rows = input.rawText.split(/\r?\n/).map((line: string) => line.trim()).filter(Boolean); let matched = 0; let exceptions = 0; const created: unknown[] = [];
      const seenRows = new Set<string>();
      for (let index = 0; index < rows.length; index++) {
        const line = rows[index] ?? "";
        const parts = line.split(/[,\t|]+/).map((p: string) => p.trim()).filter(Boolean); const rawName = parts[0] ?? ""; const amountToken = parts.find((p: string) => /\d/.test(p) && !/^\d{4}-\d{2}-\d{2}$/.test(p)); const amount = amountToken ? Number(amountToken.replace(/[^0-9.-]/g, "")) : NaN; const exactMatches = roster.filter(item => item.name.toLowerCase() === rawName.toLowerCase()); const ambiguous = exactMatches.length > 1; const tester = exactMatches.length === 1 ? exactMatches[0] : undefined; const possible = !tester && !ambiguous ? roster.find(item => item.name.toLowerCase().startsWith(rawName.toLowerCase()) || rawName.toLowerCase().startsWith(item.name.toLowerCase())) : undefined; const duplicate = seenRows.has(line.toLowerCase()); seenRows.add(line.toLowerCase()); const leader = tester ? leaders.find(item => item.id === tester.teamLeaderId) : undefined; const status = !Number.isFinite(amount) ? "MISSING_AMOUNT" : duplicate ? "DUPLICATE" : ambiguous ? "CONFLICT" : tester ? "MATCHED" : possible ? "POSSIBLE_MATCH" : "UNMATCHED";
        if (status === "MATCHED") matched++; else exceptions++;
        const note = ambiguous ? `Ambiguous tester name matched ${exactMatches.length} roster records` : possible ? `Possible match: ${possible.name}` : duplicate ? "Repeated source row" : `Source row ${index + 1}`;
        const id = await insertPayout({ payoutDate: new Date(), testerId: tester?.id ?? null, teamLeaderId: leader?.id ?? null, testerNameRaw: rawName || `Row ${index + 1}`, projectNameRaw: parts[1] ?? null, projectId: projectRows.find(p => p.name.toLowerCase() === (parts[1] ?? "").toLowerCase())?.id ?? null, grossPayout: Number.isFinite(amount) ? amount : 0, deductions: 0, netPayout: Number.isFinite(amount) ? amount : 0, sourceFile: input.fileName, status: status as Payout["status"], notes: note });
        created.push({ id });
      }
      await insertImport({ fileName: input.fileName, recordCount: rows.length, matchedCount: matched, exceptionCount: exceptions, status: exceptions ? "PARTIAL" : "PROCESSED", rawData: input.rawText });
      await addAuditLog({ action: "Payout Imported", userId: ctx.user.id, userCommand: input.fileName, newValue: { records: rows.length, matched, exceptions } });
      return { records: rows.length, matched, exceptions, created };
    }),
  }),
  targets: router({
    list: protectedProcedure.query(async () => { if (!isDbConfigured()) return []; return listActiveTargets(); }),
    create: protectedProcedure.input(z.object({ target: z.number().nonnegative(), level: z.enum(["TESTER", "TEAM_LEADER", "PROJECT", "DAILY", "WEEKLY", "MONTHLY"]), testerId: z.number().optional(), teamLeaderId: z.number().optional(), projectId: z.number().optional(), effectiveDate: z.string(), endDate: z.string().optional() })).mutation(async ({ ctx, input }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      const isAdmin = ctx.user.accountRole === "admin" || ctx.user.role === "admin";
      if (ctx.user.accountRole === "tester") throw new Error("Only Team Leaders and Admins can set targets.");
      if (!isAdmin) {
        const leaders = await listTeamLeaders();
        const own = leaders.find(leader => cleanName(leader.name) === cleanName(ctx.user.name ?? ""));
        if (input.teamLeaderId && (!own || input.teamLeaderId !== own.id)) throw new Error("You can only set targets for your own team.");
        if (input.testerId) { const tester = await getTester(input.testerId); if (!tester || !own || tester.teamLeaderId !== own.id) throw new Error("You can only set targets for testers on your own team."); }
      }
      const id = await insertTarget({ target: input.target, level: input.level, testerId: input.testerId, teamLeaderId: input.teamLeaderId, projectId: input.projectId, effectiveDate: toDate(input.effectiveDate), endDate: input.endDate ? toDate(input.endDate) : undefined });
      await addAuditLog({ action: "Target Changed", userId: ctx.user.id, newValue: input });
      return { id };
    }),
    update: protectedProcedure.input(z.object({ targetId: z.number().int().positive(), target: z.number().nonnegative(), effectiveDate: z.string(), endDate: z.string().optional() })).mutation(async ({ ctx, input }) => {
      const isAdmin = ctx.user.accountRole === "admin" || ctx.user.role === "admin";
      if (!isAdmin) throw new Error("Only admins can edit targets");
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      const existing = await getTarget(input.targetId);
      if (!existing) throw new Error("Target not found");
      const patch: Record<string, unknown> = { target: input.target, effectiveDate: toDate(input.effectiveDate) };
      if (input.endDate !== undefined) patch.endDate = input.endDate ? toDate(input.endDate) : null;
      await updateTarget(input.targetId, patch as Partial<Target>);
      await addAuditLog({ action: "Target Updated", userId: ctx.user.id, oldValue: { target: existing.target, effectiveDate: existing.effectiveDate, endDate: existing.endDate }, newValue: input, reason: "Admin target correction" });
      return { success: true };
    }),
    remove: protectedProcedure.input(z.object({ targetId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const isAdmin = ctx.user.accountRole === "admin" || ctx.user.role === "admin";
      if (!isAdmin) throw new Error("Only admins can delete targets");
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      const existing = await getTarget(input.targetId);
      if (!existing) throw new Error("Target not found");
      await deleteTarget(input.targetId);
      await addAuditLog({ action: "Target Deleted", userId: ctx.user.id, oldValue: { id: existing.id, level: existing.level, target: existing.target }, reason: "Admin target removal" });
      return { success: true };
    }),
  }),
  audit: router({ list: protectedProcedure.query(({ ctx }) => { if (ctx.user.accountRole !== "admin" && ctx.user.role !== "admin") throw new Error("Only Admins can view the audit log."); return listAuditLogs(); }) }),
  settings: router({
    get: adminProcedure.query(async () => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      const settings = await getAppSettings();
      const { smtpPass: _smtpPass, ...safe } = settings;
      return { ...safe, smtpConfigured: Boolean(settings.smtpHost && settings.smtpUser && settings.smtpPass) };
    }),
    update: adminProcedure.input(z.object({
      reportTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM, e.g. 22:30").optional(),
      timezone: z.string().min(1).max(60).optional(),
      adminEmail: z.string().email().max(320).nullable().optional(),
      smtpHost: z.string().max(200).nullable().optional(),
      smtpPort: z.number().int().min(1).max(65535).optional(),
      smtpSecure: z.boolean().optional(),
      smtpUser: z.string().max(200).nullable().optional(),
      smtpPass: z.string().max(500).optional(),
      smtpFrom: z.string().max(320).nullable().optional(),
    })).mutation(async ({ ctx, input }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      const patch: Record<string, unknown> = {};
      if (input.reportTime !== undefined) patch.reportTime = input.reportTime;
      if (input.timezone !== undefined) patch.timezone = input.timezone;
      if (input.adminEmail !== undefined) patch.adminEmail = input.adminEmail;
      if (input.smtpHost !== undefined) patch.smtpHost = input.smtpHost || null;
      if (input.smtpPort !== undefined) patch.smtpPort = input.smtpPort;
      if (input.smtpSecure !== undefined) patch.smtpSecure = input.smtpSecure ? 1 : 0;
      if (input.smtpUser !== undefined) patch.smtpUser = input.smtpUser || null;
      if (input.smtpPass) patch.smtpPass = input.smtpPass; // empty => keep existing
      if (input.smtpFrom !== undefined) patch.smtpFrom = input.smtpFrom || null;
      const updated = await updateAppSettings(patch as Parameters<typeof updateAppSettings>[0]);
      await addAuditLog({ action: "Automation Settings Updated", userId: ctx.user.id, newValue: { ...patch, smtpPass: patch.smtpPass ? "***" : undefined } });
      const { smtpPass: _smtpPass, ...safe } = updated;
      return { ...safe, smtpConfigured: Boolean(updated.smtpHost && updated.smtpUser && updated.smtpPass) };
    }),
    deliveryStatus: adminProcedure.query(async () => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      return reportAutomationStatus();
    }),
    runReportNow: adminProcedure.input(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })).mutation(async ({ ctx, input }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      const report = await compileDailyReport(input.date);
      const delivery = await deliverDailyReport(report.date, report.workbook, report.summary);
      await updateAppSettings({ lastAutoReport: new Date().toISOString() });
      await addAuditLog({ action: "Manual Report Run", userId: ctx.user.id, newValue: { date: report.date, grandTotal: report.grandTotal, delivery } });
      return {
        date: report.date,
        rows: report.rows.length,
        grandTotal: report.grandTotal,
        delivery,
        fileName: `Daily_Operations_Report_${report.date}.xlsx`,
        workbookBase64: report.workbook.toString("base64"),
      };
    }),
  }),
  assistant: router({
    chat: protectedProcedure.input(z.object({ messages: z.array(z.object({ role: z.enum(["user", "assistant", "system"]), content: z.string() })).min(1), businessDate: z.string().optional() })).mutation(async ({ ctx, input }) => {
      const latest = input.messages[input.messages.length - 1]?.content ?? "";
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      await ensureWorkspaceInitialized(ctx.user.id);
      const reportDate = input.businessDate ?? new Date().toISOString().slice(0, 10);
      const [roster, leaderRows, projectRows] = await Promise.all([listTesters(), listTeamLeaders(), listActiveProjects()]);
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
        const content = await executeAssistantCommand(commandUser, command, { roster, leaderRows, projectRows, reportDate, latest });
        return { content, ingestion: null };
      }

      // Layer 2: deterministic workspace questions over role-scoped rows.
      // Date-aware: "yesterday", "this week", "this month", or an explicit date widen the snapshot.
      const range = parseQuestionDateRange(latest, reportDate);
      const directAnswer = answerWorkspaceQuestion(latest, await buildWorkspaceSnapshot(scopeTesters, scopeLeaders, projectRows, range.from, range.to, range.label));
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
      for (const action of extraction.actions ?? []) {
        const name = action.name.trim(); const leaderName = action.leader.trim();
        if (!isAdmin) { exceptions.push(`Admin approval is required for the ${action.type} command.`); continue; }
        if (action.type === "addLeader" && name) await upsertTeamLeader(name);
        if (action.type === "addProject" && action.project.trim()) await upsertProjectByName(action.project.trim());
        if (action.type === "renameProject" && action.projectId && action.project.trim()) await updateProject(action.projectId, { name: action.project.trim() });
        if (action.type === "deleteProject" && action.projectId) { const used = await listPerformanceByProject(action.projectId, 1); if (!used.length) await deleteProject(action.projectId); else exceptions.push(`Project ${action.project} has data and was not deleted`); }
        if (action.type === "setPayoutRule" && action.project.trim()) { const project = (await listProjects()).find(item => cleanName(item.name) === cleanName(action.project)); const tester = action.tester.trim() ? (await listTesters()).find(item => cleanName(item.name) === cleanName(action.tester)) : undefined; if (!project) exceptions.push(`Project ${action.project} was not found for payout rule`); else { const existing = (await listPayoutRules()).find(item => item.projectId === project.id && item.testerId === tester?.id && item.status === "ACTIVE"); const payload = { projectId: project.id, testerId: tester?.id, ratePerOtp: action.rate > 0 ? action.rate : undefined, fixedAmount: action.fixed > 0 ? action.fixed : undefined, notes: latest.slice(0, 1000) }; if (existing) await updatePayoutRule(existing.id, payload); else await insertPayoutRule(payload); } }
        if (action.type === "addTester" && name && leaderName) { const leader = await upsertTeamLeader(leaderName); await upsertTesterByName(name, leader.id); }
        if (action.type === "deleteLeader") { const leader = (await listTeamLeaders()).find(item => cleanName(item.name) === cleanName(name)); if (!leader) exceptions.push(`Team Leader ${name} was not found`); else { const activeChildren = (await listTesters()).filter(item => item.teamLeaderId === leader.id && item.status === "ACTIVE"); if (activeChildren.length) exceptions.push(`Cannot remove ${leader.name}: ${activeChildren.length} active tester(s) remain on the team`); else { await updateTeamLeader(leader.id, { status: "INACTIVE" }); await addAuditLog({ action: "Team Leader Deactivated", userId: ctx.user.id, oldValue: leader, userCommand: latest, reason: "AI deletion command (history preserved)" }); } } }
        if (action.type === "deleteTester") { const matches = (await listTesters()).filter(item => cleanName(item.name) === cleanName(name)); if (!matches.length) exceptions.push(`Tester ${name} was not found`); for (const tester of matches) { await updateTester(tester.id, { status: "INACTIVE", dateInactive: new Date() }); await addAuditLog({ action: "Tester Deactivated", userId: ctx.user.id, oldValue: tester, userCommand: latest, reason: "AI deletion command (history preserved)" }); } }
      }
      const [freshRoster, freshLeaders, freshProjects, rules] = await Promise.all([listTesters(), listTeamLeaders(), listProjects(), listActivePayoutRules()]);
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
        if (!row.tester || !row.leader) { exceptions.push(`Could not safely match ${row.testerName}; row kept in report only.`); const sxProj = freshProjects.find(p => cleanName(p.name) === "super x"); const oxProj = freshProjects.find(p => p.id !== sxProj?.id); reportRows.push({ leader: row.leaderName, tester: row.testerName, superX: row.values.get("super x") ?? (sxProj ? row.values.get(cleanName(sxProj.name)) ?? 0 : 0), sectionX: oxProj ? row.values.get(cleanName(oxProj.name)) ?? 0 : 0, total: Array.from(row.values.values()).reduce((a, b) => a + b, 0), superXPayout: 0, sectionXPayout: 0, totalPayout: 0 }); continue; }
        for (const value of values.filter(item => row.values.has(cleanName(item.project.name)))) {
          const existing = await findPerformance(toDate(llmReportDate), row.tester.id, value.project.id);
          const accumulated = (existing ? money(existing.quantity) : 0) + value.quantity;
          if (existing) await updatePerformance(existing.id, { quantity: accumulated, source: "AI assistant", notes: latest.slice(0, 1000) });
          else await insertPerformance({ businessDate: toDate(llmReportDate), testerId: row.tester.id, teamLeaderId: row.leader.id, projectId: value.project.id, quantity: value.quantity, source: "AI assistant", notes: latest.slice(0, 1000) });
        }
        const saved = (await listPerformanceByDate(toDate(llmReportDate))).filter(item => item.testerId === row.tester!.id).slice(0, 50);
        const totals = new Map(freshProjects.map(project => [project.id, saved.filter(item => item.projectId === project.id).reduce((sum, item) => sum + Number(item.quantity), 0)]));
        const superXProject = freshProjects.find(p => cleanName(p.name) === "super x");
        const otherProject = freshProjects.find(p => p.id !== superXProject?.id);
        const superX = totals.get(superXProject?.id ?? -1) ?? 0; const sectionX = totals.get(otherProject?.id ?? -1) ?? 0;
        const payoutsByProject = new Map(freshProjects.map(project => { const otp = totals.get(project.id) ?? 0; const rule = rules.find(item => item.projectId === project.id && item.testerId === row.tester?.id) ?? rules.find(item => item.projectId === project.id && !item.testerId); return [project.id, rule?.fixedAmount != null ? money(rule.fixedAmount) : otp * money(rule?.ratePerOtp)] as const; }));
        const superXPayout = payoutsByProject.get(superXProject?.id ?? -1) ?? 0; const sectionXPayout = payoutsByProject.get(otherProject?.id ?? -1) ?? 0;
        stored += 1; reportRows.push({ leader: row.leader.name, tester: row.tester.name, superX, sectionX, total: Array.from(totals.values()).reduce((a, b) => a + b, 0), superXPayout, sectionXPayout, totalPayout: Array.from(payoutsByProject.values()).reduce((a, b) => a + b, 0) });
      }
      await insertImport({ fileName: `AI assistant ${llmReportDate}`, recordCount: extraction.rows.length, matchedCount: stored, exceptionCount: exceptions.length, status: exceptions.length ? "PARTIAL" : "PROCESSED", rawData: latest });
      await addAuditLog({ action: "AI Report Imported", userId: ctx.user.id, userCommand: latest, newValue: { date: llmReportDate, stored, exceptions: exceptions.length } });
      const content = extraction.rows.length ? `Stored ${stored} tester rows for ${llmReportDate}. I separated the data by Team Leader and kept ${exceptions.length} validation note${exceptions.length === 1 ? "" : "s"}. You can download the formatted report below.` : extraction.answer || `I received: ${latest}. Include tester names with Section X and Super X values when you want me to store a report.`;
      return { content, ingestion: extraction.rows.length || extraction.payoutRequested ? { date: llmReportDate, stored, exceptions, rows: reportRows, payoutRequested: Boolean(extraction.payoutRequested) } : null };
    }),
    uploadDataset: protectedProcedure.input(z.object({ fileName: z.string().min(1).max(200), dataBase64: z.string().min(1) })).mutation(async ({ ctx, input }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      if (input.dataBase64.length > 8 * 1024 * 1024) throw new Error("File is too large (max ~6 MB).");
      const sheets = parseWorkbook(Buffer.from(input.dataBase64, "base64"), input.fileName);
      const summary = summarizeDataset(sheets);
      const storable = sheets.map(sheet => ({ name: sheet.name, rows: sheet.rows.slice(0, 2000) }));
      const importId = await insertImport({ fileName: input.fileName, uploadedBy: ctx.user.id, recordCount: sheets.reduce((n, sheet) => n + sheet.rows.length, 0), matchedCount: 0, exceptionCount: 0, status: "PROCESSED", rawData: JSON.stringify(storable) });
      await addAuditLog({ action: "Dataset Uploaded", userId: ctx.user.id, newValue: { fileName: input.fileName, sheets: sheets.length } });
      return { importId, summary, sheets: sheets.length };
    }),
    askDataset: protectedProcedure.input(z.object({ importId: z.number().int().positive(), question: z.string().min(2).max(500) })).mutation(async ({ ctx, input }) => {
      if (!isDbConfigured()) throw new Error("Database is unavailable");
      const row = await getImport(input.importId);
      if (!row) throw new Error("Dataset not found.");
      if (row.uploadedBy !== ctx.user.id && ctx.user.accountRole !== "admin") throw new Error("You can only ask about datasets you uploaded.");
      const answer = answerDatasetQuestion(input.question, JSON.parse(row.rawData ?? "[]"));
      return { answer: answer ?? "I couldn't answer that from this file. Try asking for a total by name, top performers, or a project comparison." };
    }),
  }),
});

export type AppRouter = typeof appRouter;
