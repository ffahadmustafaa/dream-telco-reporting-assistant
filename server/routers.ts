import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { invokeLLM } from "./_core/llm";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { addAuditLog, dailyPerformance, ensureWorkspaceInitialized, getDb, getWorkspaceData, imports, listAuditLogs, payouts, projects, targets, teamLeaders, testers } from "./db";
import { desc, eq } from "drizzle-orm";

const dateInput = z.string().optional();
const toDate = (value?: string) => value ? new Date(`${value}T00:00:00.000Z`) : new Date();
const money = (value: string | number | undefined) => Number(value ?? 0);

export const appRouter = router({
  system: router({ health: publicProcedure.query(() => ({ ok: true })) }),
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => { ctx.res.clearCookie(COOKIE_NAME, { ...getSessionCookieOptions(ctx.req), maxAge: -1 }); return { success: true } as const; }),
  }),
  dashboard: router({
    overview: protectedProcedure.input(z.object({ date: dateInput })).query(async ({ ctx, input }) => {
      await ensureWorkspaceInitialized(ctx.user.id);
      const data = await getWorkspaceData(toDate(input.date));
      const projectMap = new Map(data.projects.map(project => [project.id, project]));
      const testerMap = new Map(data.testers.map(tester => [tester.id, tester]));
      const byLeader = new Map<number, { leaderId: number; leader: string; superX: number; inception: number; total: number; reporting: number; zero: number; activeTesters: number; testers: Record<string, number> }>();
      for (const leader of data.leaders.filter(item => item.status === "ACTIVE")) byLeader.set(leader.id, { leaderId: leader.id, leader: leader.name, superX: 0, inception: 0, total: 0, reporting: 0, zero: 0, activeTesters: data.testers.filter(t => t.teamLeaderId === leader.id && t.status === "ACTIVE").length, testers: {} });
      for (const row of data.performance) {
        const leader = byLeader.get(row.teamLeaderId); const project = projectMap.get(row.projectId); const tester = testerMap.get(row.testerId); const quantity = money(row.quantity);
        if (!leader) continue;
        leader.total += quantity; leader.testers[tester?.name ?? `Tester ${row.testerId}`] = (leader.testers[tester?.name ?? `Tester ${row.testerId}`] ?? 0) + quantity;
        if (project?.name === "Super X") leader.superX += quantity;
        else if (project?.name === "Inception") leader.inception += quantity;
      }
      Array.from(byLeader.values()).forEach(item => { item.reporting = Object.keys(item.testers).length; item.zero = Math.max(0, item.activeTesters - item.reporting); });
      const leaders = Array.from(byLeader.values()).map(item => ({ ...item, average: item.activeTesters ? item.total / item.activeTesters : 0, bestTester: Object.entries(item.testers).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—", lowestTester: Object.entries(item.testers).sort((a, b) => a[1] - b[1])[0]?.[0] ?? "—" }));
      const testerTotals: Array<[string, number]> = data.testers.map(t => [t.name, 0]);
      for (const row of data.performance) { const name = testerMap.get(row.testerId)?.name; if (!name) continue; const match = testerTotals.find(item => item[0] === name); if (match) match[1] += money(row.quantity); }
      const topTesters = testerTotals.sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, total]) => ({ name, total }));
      const payoutTotals = data.payouts.reduce((acc, item) => { acc.gross += money(item.grossPayout); acc.net += money(item.netPayout); if (item.status !== "MATCHED") acc.exceptions += 1; return acc; }, { gross: 0, net: 0, exceptions: 0 });
      return { date: toDate(input.date).toISOString(), leaders, projects: data.projects, testers: data.testers, performance: data.performance, targets: data.targets, payouts: data.payouts, imports: data.imports, topTesters, payoutTotals, totals: { superX: leaders.reduce((n, x) => n + x.superX, 0), inception: leaders.reduce((n, x) => n + x.inception, 0), total: leaders.reduce((n, x) => n + x.total, 0), activeTesters: data.testers.filter(t => t.status === "ACTIVE").length, reportingTesters: leaders.reduce((n, x) => n + x.reporting, 0), zeroTesters: leaders.reduce((n, x) => n + x.zero, 0) } };
    }),
  }),
  roster: router({
    list: protectedProcedure.query(async ({ ctx }) => { await ensureWorkspaceInitialized(ctx.user.id); const db = await getDb(); if (!db) return { leaders: [], testers: [] }; return { leaders: await db.select().from(teamLeaders).orderBy(teamLeaders.name), testers: await db.select().from(testers).orderBy(testers.name) }; }),
    addLeader: protectedProcedure.input(z.object({ name: z.string().min(2), notes: z.string().optional() })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); const inserted = await db.insert(teamLeaders).values({ name: input.name.trim(), notes: input.notes }).$returningId(); await addAuditLog({ action: "Team Leader Added", userId: ctx.user.id, newValue: input }); return inserted[0]; }),
    addTester: protectedProcedure.input(z.object({ name: z.string().min(2), teamLeaderId: z.number(), notes: z.string().optional() })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); const inserted = await db.insert(testers).values({ name: input.name.trim(), teamLeaderId: input.teamLeaderId, notes: input.notes }).$returningId(); await addAuditLog({ action: "Tester Added", userId: ctx.user.id, newValue: input }); return inserted[0]; }),
    moveTester: protectedProcedure.input(z.object({ testerId: z.number(), teamLeaderId: z.number() })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); const old = await db.select().from(testers).where(eq(testers.id, input.testerId)).limit(1); await db.update(testers).set({ teamLeaderId: input.teamLeaderId }).where(eq(testers.id, input.testerId)); await addAuditLog({ action: "Tester Moved", userId: ctx.user.id, oldValue: old[0], newValue: input }); return { success: true }; }),
    toggleTester: protectedProcedure.input(z.object({ testerId: z.number(), status: z.enum(["ACTIVE", "INACTIVE"]) })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); await db.update(testers).set({ status: input.status, dateInactive: input.status === "INACTIVE" ? new Date() : null }).where(eq(testers.id, input.testerId)); await addAuditLog({ action: input.status === "ACTIVE" ? "Tester Reactivated" : "Tester Deactivated", userId: ctx.user.id, newValue: input }); return { success: true }; }),
  }),
  performance: router({
    create: protectedProcedure.input(z.object({ businessDate: z.string(), testerId: z.number(), projectId: z.number(), quantity: z.number().nonnegative(), source: z.string().optional(), notes: z.string().optional() })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); const tester = (await db.select().from(testers).where(eq(testers.id, input.testerId)).limit(1))[0]; if (!tester) throw new Error("Tester not found"); await db.insert(dailyPerformance).values({ businessDate: toDate(input.businessDate), testerId: input.testerId, teamLeaderId: tester.teamLeaderId, projectId: input.projectId, quantity: input.quantity.toString(), source: input.source, notes: input.notes }); await addAuditLog({ action: "Performance Imported", userId: ctx.user.id, newValue: input }); return { success: true }; }),
  }),
  payouts: router({
    list: protectedProcedure.query(async () => { const db = await getDb(); if (!db) return []; return db.select().from(payouts).orderBy(desc(payouts.createdAt)).limit(300); }),
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
    create: protectedProcedure.input(z.object({ target: z.number().nonnegative(), level: z.enum(["TESTER", "TEAM_LEADER", "PROJECT", "DAILY", "WEEKLY", "MONTHLY"]), testerId: z.number().optional(), teamLeaderId: z.number().optional(), projectId: z.number().optional(), effectiveDate: z.string(), endDate: z.string().optional() })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); const inserted = await db.insert(targets).values({ target: input.target.toString(), level: input.level, testerId: input.testerId, teamLeaderId: input.teamLeaderId, projectId: input.projectId, effectiveDate: toDate(input.effectiveDate), endDate: input.endDate ? toDate(input.endDate) : undefined }); await addAuditLog({ action: "Target Changed", userId: ctx.user.id, newValue: input }); return inserted; }),
  }),
  audit: router({ list: protectedProcedure.query(() => listAuditLogs()) }),
  assistant: router({
    chat: protectedProcedure.input(z.object({ messages: z.array(z.object({ role: z.enum(["user", "assistant", "system"]), content: z.string() })).min(1) })).mutation(async ({ input }) => {
      const latest = input.messages[input.messages.length - 1]?.content ?? "";
      const answer = await invokeLLM({ messages: [{ role: "system", content: "You are the Dream Telco Reporting Assistant. Be concise and operational. Never invent names, amounts, targets, or calculations. If data is missing say Not provided. If a change is requested, explain that the user should use the validated action in the app. Support daily performance, roster, targets, payout exceptions, and report interpretation." }, ...input.messages.map(message => ({ role: message.role as "user" | "assistant" | "system", content: message.content }))] });
      const responseContent = answer.choices?.[0]?.message?.content;
      const content = typeof responseContent === "string" ? responseContent : `I received: ${latest}. Add the relevant file or report date so I can validate it.`;
      return { content };
    }),
  }),
});

export type AppRouter = typeof appRouter;
