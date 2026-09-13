import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { invokeLLM } from "./_core/llm";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { addAuditLog, dailyPerformance, ensureWorkspaceInitialized, getDb, getWorkspaceData, imports, listAuditLogs, payouts, projects, targets, teamLeaders, testers } from "./db";
import { and, desc, eq } from "drizzle-orm";

const dateInput = z.string().optional();
const toDate = (value?: string) => value ? new Date(`${value}T00:00:00.000Z`) : new Date();
const money = (value: string | number | undefined) => Number(value ?? 0);
const cleanName = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
const textFromLLM = (value: string | Array<{ type: string; text?: string }>) => typeof value === "string" ? value : value.map(part => part.text ?? "").join("\n");

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
    addTester: protectedProcedure.input(z.object({ name: z.string().min(2), teamLeaderId: z.number(), notes: z.string().optional() })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); const name = input.name.trim(); const existing = (await db.select().from(testers)).find(item => cleanName(item.name) === cleanName(name)); if (existing) { await db.update(testers).set({ teamLeaderId: input.teamLeaderId, status: "ACTIVE", notes: input.notes }).where(eq(testers.id, existing.id)); await addAuditLog({ action: "Tester Reassigned", userId: ctx.user.id, oldValue: existing, newValue: input }); return { id: existing.id }; } const inserted = await db.insert(testers).values({ name, teamLeaderId: input.teamLeaderId, notes: input.notes }).$returningId(); await addAuditLog({ action: "Tester Added", userId: ctx.user.id, newValue: input }); return inserted[0]; }),
    moveTester: protectedProcedure.input(z.object({ testerId: z.number(), teamLeaderId: z.number() })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); const old = await db.select().from(testers).where(eq(testers.id, input.testerId)).limit(1); await db.update(testers).set({ teamLeaderId: input.teamLeaderId }).where(eq(testers.id, input.testerId)); await addAuditLog({ action: "Tester Moved", userId: ctx.user.id, oldValue: old[0], newValue: input }); return { success: true }; }),
    toggleTester: protectedProcedure.input(z.object({ testerId: z.number(), status: z.enum(["ACTIVE", "INACTIVE"]) })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); await db.update(testers).set({ status: input.status, dateInactive: input.status === "INACTIVE" ? new Date() : null }).where(eq(testers.id, input.testerId)); await addAuditLog({ action: input.status === "ACTIVE" ? "Tester Reactivated" : "Tester Deactivated", userId: ctx.user.id, newValue: input }); return { success: true }; }),
    deleteTester: protectedProcedure.input(z.object({ testerId: z.number() })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); const old = (await db.select().from(testers).where(eq(testers.id, input.testerId)).limit(1))[0]; if (!old) throw new Error("Tester not found"); await db.delete(dailyPerformance).where(eq(dailyPerformance.testerId, input.testerId)); await db.delete(targets).where(eq(targets.testerId, input.testerId)); await db.delete(payouts).where(eq(payouts.testerId, input.testerId)); await db.delete(testers).where(eq(testers.id, input.testerId)); await addAuditLog({ action: "Tester Deleted", userId: ctx.user.id, oldValue: old, reason: "User requested roster cleanup" }); return { success: true }; }),
    deleteLeader: protectedProcedure.input(z.object({ teamLeaderId: z.number() })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); const old = (await db.select().from(teamLeaders).where(eq(teamLeaders.id, input.teamLeaderId)).limit(1))[0]; if (!old) throw new Error("Team Leader not found"); const children = await db.select().from(testers).where(eq(testers.teamLeaderId, input.teamLeaderId)); for (const child of children) { await db.delete(dailyPerformance).where(eq(dailyPerformance.testerId, child.id)); await db.delete(targets).where(eq(targets.testerId, child.id)); await db.delete(payouts).where(eq(payouts.testerId, child.id)); } await db.delete(testers).where(eq(testers.teamLeaderId, input.teamLeaderId)); await db.delete(targets).where(eq(targets.teamLeaderId, input.teamLeaderId)); await db.delete(payouts).where(eq(payouts.teamLeaderId, input.teamLeaderId)); await db.delete(teamLeaders).where(eq(teamLeaders.id, input.teamLeaderId)); await addAuditLog({ action: "Team Leader Deleted", userId: ctx.user.id, oldValue: old, reason: "User requested roster cleanup" }); return { success: true }; }),
  }),
  projects: router({
    list: protectedProcedure.query(async () => { const db = await getDb(); if (!db) return []; return db.select().from(projects).orderBy(projects.id); }),
    add: protectedProcedure.input(z.object({ name: z.string().min(1), notes: z.string().optional() })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); const inserted = await db.insert(projects).values({ name: input.name.trim(), notes: input.notes }).$returningId(); await addAuditLog({ action: "Project Added", userId: ctx.user.id, newValue: input }); return inserted[0]; }),
    rename: protectedProcedure.input(z.object({ projectId: z.number(), name: z.string().min(1) })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); await db.update(projects).set({ name: input.name.trim() }).where(eq(projects.id, input.projectId)); await addAuditLog({ action: "Project Renamed", userId: ctx.user.id, newValue: input }); return { success: true }; }),
    delete: protectedProcedure.input(z.object({ projectId: z.number() })).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Database is unavailable"); const used = await db.select().from(dailyPerformance).where(eq(dailyPerformance.projectId, input.projectId)).limit(1); if (used.length) throw new Error("Project has report data and cannot be deleted; rename it instead."); await db.delete(projects).where(eq(projects.id, input.projectId)); await addAuditLog({ action: "Project Deleted", userId: ctx.user.id, newValue: input }); return { success: true }; }),
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
    chat: protectedProcedure.input(z.object({ messages: z.array(z.object({ role: z.enum(["user", "assistant", "system"]), content: z.string() })).min(1), businessDate: z.string().optional() })).mutation(async ({ ctx, input }) => {
      const latest = input.messages[input.messages.length - 1]?.content ?? "";
      const answer = await invokeLLM({
        messages: [{ role: "system", content: "You are a daily operations reporting engine. Return JSON only. Current active projects are supplied by the user context in the conversation and their order matters. Commands include addLeader, addTester, deleteLeader, deleteTester, addProject, renameProject, deleteProject. Only create roster/project records for explicit database commands. For reports, parse named project values and slash notation X/Y or X/Y/Z strictly in active project order. Return one row per tester with a values array containing project names and quantities. Leave leader empty when omitted so the server can infer it. Fuzzy-match abbreviations and typos, but never invent counts. " }, ...input.messages.map(message => ({ role: message.role as "user" | "assistant" | "system", content: message.content }))],
        response_format: { type: "json_schema", json_schema: { name: "assistant_command", strict: true, schema: { type: "object", properties: { answer: { type: "string" }, date: { type: "string" }, actions: { type: "array", items: { type: "object", properties: { type: { type: "string", enum: ["addLeader", "addTester", "deleteLeader", "deleteTester", "addProject", "renameProject", "deleteProject"] }, name: { type: "string" }, leader: { type: "string" }, projectId: { type: "number" }, project: { type: "string" } }, required: ["type", "name", "leader", "projectId", "project"], additionalProperties: false } }, rows: { type: "array", items: { type: "object", properties: { leader: { type: "string" }, tester: { type: "string" }, values: { type: "array", items: { type: "object", properties: { project: { type: "string" }, quantity: { type: "number" } }, required: ["project", "quantity"], additionalProperties: false } } }, required: ["leader", "tester", "values"], additionalProperties: false } }, notes: { type: "array", items: { type: "string" } } }, required: ["answer", "date", "actions", "rows", "notes"], additionalProperties: false } } },
        max_tokens: 4000,
      });
      const responseContent = answer.choices?.[0]?.message?.content;
      let extraction: { answer?: string; date?: string; actions?: Array<{ type: string; name: string; leader: string; projectId: number; project: string }>; rows: Array<{ leader: string; tester: string; values: Array<{ project: string; quantity: number }> }>; notes?: string[] } = { rows: [] };
      try { extraction = JSON.parse(textFromLLM(responseContent ?? "{}")); } catch { /* fall through to normal chat response */ }
      const reportDate = extraction.date && /^\d{4}-\d{2}-\d{2}$/.test(extraction.date) ? extraction.date : input.businessDate ?? new Date().toISOString().slice(0, 10);
      const db = await getDb();
      let stored = 0; const exceptions: string[] = [...(extraction.notes ?? [])];
      const reportRows: Array<{ leader: string; tester: string; superX: number; inception: number; total: number }> = [];
      if (db) {
        await ensureWorkspaceInitialized(ctx.user.id);
        for (const action of extraction.actions ?? []) {
          const name = action.name.trim(); const leaderName = action.leader.trim();
          if (action.type === "addLeader" && name) await db.insert(teamLeaders).values({ name }).onDuplicateKeyUpdate({ set: { status: "ACTIVE" } });
          if (action.type === "addProject" && action.project.trim()) await db.insert(projects).values({ name: action.project.trim() }).onDuplicateKeyUpdate({ set: { status: "ACTIVE" } });
          if (action.type === "renameProject" && action.projectId && action.project.trim()) await db.update(projects).set({ name: action.project.trim() }).where(eq(projects.id, action.projectId));
          if (action.type === "deleteProject" && action.projectId) { const used = await db.select().from(dailyPerformance).where(eq(dailyPerformance.projectId, action.projectId)).limit(1); if (!used.length) await db.delete(projects).where(eq(projects.id, action.projectId)); else exceptions.push(`Project ${action.project} has data and was not deleted`); }
          if (action.type === "addTester" && name && leaderName) { let leader = (await db.select().from(teamLeaders).where(eq(teamLeaders.name, leaderName)).limit(1))[0]; if (!leader) { const id = await db.insert(teamLeaders).values({ name: leaderName }).$returningId(); leader = { id: id[0]!.id, name: leaderName } as typeof leader; } await db.insert(testers).values({ name, teamLeaderId: leader.id }).onDuplicateKeyUpdate({ set: { status: "ACTIVE", teamLeaderId: leader.id } }); }
          if (action.type === "deleteLeader") { const leader = (await db.select().from(teamLeaders)).find(item => cleanName(item.name) === cleanName(name)); if (leader) { const children = await db.select().from(testers).where(eq(testers.teamLeaderId, leader.id)); for (const child of children) { await db.delete(dailyPerformance).where(eq(dailyPerformance.testerId, child.id)); await db.delete(targets).where(eq(targets.testerId, child.id)); await db.delete(payouts).where(eq(payouts.testerId, child.id)); } await db.delete(testers).where(eq(testers.teamLeaderId, leader.id)); await db.delete(targets).where(eq(targets.teamLeaderId, leader.id)); await db.delete(payouts).where(eq(payouts.teamLeaderId, leader.id)); await db.delete(teamLeaders).where(eq(teamLeaders.id, leader.id)); await addAuditLog({ action: "Team Leader Deleted", userId: ctx.user.id, oldValue: leader, userCommand: latest, reason: "AI deletion command" }); } else { exceptions.push(`Team Leader ${name} was not found`); } }
          if (action.type === "deleteTester") { const matches = (await db.select().from(testers)).filter(item => cleanName(item.name) === cleanName(name)); if (!matches.length) exceptions.push(`Tester ${name} was not found`); for (const tester of matches) { await db.delete(dailyPerformance).where(eq(dailyPerformance.testerId, tester.id)); await db.delete(targets).where(eq(targets.testerId, tester.id)); await db.delete(payouts).where(eq(payouts.testerId, tester.id)); await db.delete(testers).where(eq(testers.id, tester.id)); await addAuditLog({ action: "Tester Deleted", userId: ctx.user.id, oldValue: tester, userCommand: latest, reason: "AI deletion command" }); } }
        }
        const [roster, leaderRows, projectRows] = await Promise.all([db.select().from(testers), db.select().from(teamLeaders), db.select().from(projects)]);
        const projectByName = new Map(projectRows.map(project => [cleanName(project.name), project]));
        const grouped = new Map<string, { leaderName: string; testerName: string; values: Map<string, number>; tester?: typeof roster[number]; leader?: typeof leaderRows[number] }>();
        for (const row of extraction.rows) {
          const candidates = roster.filter(item => cleanName(item.name) === cleanName(row.tester));
          const tester = candidates.length === 1 ? candidates[0] : undefined;
          const explicitLeader = row.leader.trim() ? leaderRows.find(item => cleanName(item.name) === cleanName(row.leader)) : undefined;
          const inferredLeader = tester ? leaderRows.find(item => item.id === tester.teamLeaderId) : undefined;
          const leader = explicitLeader ?? inferredLeader;
          const leaderName = leader?.name ?? (row.leader.trim() || "Unassigned");
          const key = `${cleanName(leaderName)}|${cleanName(row.tester)}`;
          const item = grouped.get(key) ?? { leaderName, testerName: row.tester.trim(), values: new Map<string, number>(), tester, leader };
          for (const value of row.values) item.values.set(cleanName(value.project), (item.values.get(cleanName(value.project)) ?? 0) + Number(value.quantity));
          item.tester = tester ?? item.tester; item.leader = leader ?? item.leader; grouped.set(key, item);
        }
        for (const tester of roster.filter(item => item.status === "ACTIVE")) {
          const leader = leaderRows.find(item => item.id === tester.teamLeaderId); if (!leader) continue;
          const key = `${cleanName(leader.name)}|${cleanName(tester.name)}`;
          if (!grouped.has(key)) grouped.set(key, { leaderName: leader.name, testerName: tester.name, values: new Map(), tester, leader });
        }
        for (const row of Array.from(grouped.values())) {
          const values = Array.from(projectByName.values()).map(project => ({ project, quantity: row.values.get(cleanName(project.name)) ?? 0 }));
          if (!row.tester || !row.leader) { exceptions.push(`Could not safely match ${row.testerName}; row kept in report only.`); reportRows.push({ leader: row.leaderName, tester: row.testerName, superX: row.values.get("super x") ?? 0, inception: row.values.get("inception") ?? 0, total: Array.from(row.values.values()).reduce((a, b) => a + b, 0) }); continue; }
          for (const value of values.filter(item => row.values.has(cleanName(item.project.name)))) {
            const existing = await db.select().from(dailyPerformance).where(and(eq(dailyPerformance.businessDate, toDate(reportDate)), eq(dailyPerformance.testerId, row.tester.id), eq(dailyPerformance.projectId, value.project.id))).limit(1);
            if (existing[0]) await db.update(dailyPerformance).set({ quantity: value.quantity.toString(), source: "AI assistant", notes: latest.slice(0, 1000) }).where(eq(dailyPerformance.id, existing[0].id));
            else await db.insert(dailyPerformance).values({ businessDate: toDate(reportDate), testerId: row.tester.id, teamLeaderId: row.leader.id, projectId: value.project.id, quantity: value.quantity.toString(), source: "AI assistant", notes: latest.slice(0, 1000) });
          }
          const saved = await db.select().from(dailyPerformance).where(and(eq(dailyPerformance.businessDate, toDate(reportDate)), eq(dailyPerformance.testerId, row.tester.id))).limit(50);
          const totals = new Map(projectRows.map(project => [project.id, saved.filter(item => item.projectId === project.id).reduce((sum, item) => sum + Number(item.quantity), 0)]));
          const superX = totals.get(projectByName.get("super x")?.id ?? -1) ?? 0; const inception = totals.get(projectByName.get("inception")?.id ?? -1) ?? 0;
          stored += 1; reportRows.push({ leader: row.leader.name, tester: row.tester.name, superX, inception, total: Array.from(totals.values()).reduce((a, b) => a + b, 0) });
        }
        await db.insert(imports).values({ fileName: `AI assistant ${reportDate}`, recordCount: extraction.rows.length, matchedCount: stored, exceptionCount: exceptions.length, status: exceptions.length ? "PARTIAL" : "PROCESSED", rawData: latest });
        await addAuditLog({ action: "AI Report Imported", userId: ctx.user.id, userCommand: latest, newValue: { date: reportDate, stored, exceptions: exceptions.length } });
      }
      const content = extraction.rows.length ? `Stored ${stored} tester rows for ${reportDate}. I separated the data by Team Leader and kept ${exceptions.length} validation note${exceptions.length === 1 ? "" : "s"}. You can download the formatted report below.` : extraction.answer || `I received: ${latest}. Include tester names with Super X and Inception values when you want me to store a report.`;
      return { content, ingestion: extraction.rows.length ? { date: reportDate, stored, exceptions, rows: reportRows } : null };
    }),
  }),
});

export type AppRouter = typeof appRouter;
