import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

const baseContext = { req: {} as TrpcContext["req"], res: {} as TrpcContext["res"], user: null } as TrpcContext;

const adminUser = { id: 1, openId: "admin-1", name: "Fahad", email: "ffahadmustafaa@gmail.com", role: "admin" as const, accountRole: "admin" as const, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() };
const testerUser = { id: 2, openId: "tester-1", name: "Bisma", email: "bisma@example.com", role: "user" as const, accountRole: "tester" as const, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() };

const caller = (user: typeof adminUser | typeof testerUser | null) => appRouter.createCaller({ ...baseContext, user });

describe("settings router role restrictions", () => {
  it("rejects unauthenticated callers before touching the database", async () => {
    await expect(caller(null).settings.get()).rejects.toThrow();
  });

  it("rejects non-root-admin users with FORBIDDEN", async () => {
    const err = await caller(testerUser).settings.get().catch(e => e);
    expect(err.code ?? err.shape?.data?.code).toBe("FORBIDDEN");
  });

  it("rejects settings.update for non-admins", async () => {
    const err = await caller(testerUser).settings.update({ reportTime: "21:00" }).catch(e => e);
    expect(err.code ?? err.shape?.data?.code).toBe("FORBIDDEN");
  });

  it("rejects runReportNow for non-admins", async () => {
    const err = await caller(testerUser).settings.runReportNow({ date: "2026-09-30" }).catch(e => e);
    expect(err.code ?? err.shape?.data?.code).toBe("FORBIDDEN");
  });

  it("rejects non-admins from targets update/remove before database access", async () => {
    const updateErr = await caller(testerUser).targets.update({ targetId: 1, target: 10, effectiveDate: "2026-09-30" }).catch(e => e);
    expect(String(updateErr.message)).toMatch(/admin/i);
    const removeErr = await caller(testerUser).targets.remove({ targetId: 1 }).catch(e => e);
    expect(String(removeErr.message)).toMatch(/admin/i);
  });

  it("rejects non-team-leaders from leader-scoped roster actions", async () => {
    const addErr = await caller(adminUser).roster.addOwnTester({ name: "New Tester" }).catch(e => e);
    expect(String(addErr.message)).toMatch(/team leader/i);
    const updateErr = await caller(testerUser).roster.updateOwnTester({ testerId: 1, status: "INACTIVE" }).catch(e => e);
    expect(String(updateErr.message)).toMatch(/team leader/i);
  });

  it("validates settings input shapes without a database", async () => {
    const err = await caller(adminUser).settings.update({ reportTime: "not-a-time" }).catch(e => e);
    expect(String(err.message)).toMatch(/invalid/i);
  });
});
