import { describe, expect, it } from "vitest";
import { appRouter, parseQuantity } from "./routers";
import type { TrpcContext } from "./_core/context";

const baseContext = { req: {} as TrpcContext["req"], res: {} as TrpcContext["res"], user: null } as TrpcContext;

describe("reporting workspace contracts", () => {
  it("normalizes slash shorthand into one daily quantity", () => {
    expect(parseQuantity("120/120")).toBe(240);
    expect(parseQuantity("1,200")).toBe(1200);
    expect(parseQuantity("not-a-number")).toBe(0);
  });

  it("exposes a healthy public system endpoint", async () => {
    await expect(appRouter.createCaller(baseContext).system.health()).resolves.toEqual({ ok: true });
  });

  it("returns the current user through the auth context", async () => {
    const user = { id: 7, openId: "reporting-user", name: "Category Lead", email: "lead@example.com", loginMethod: "manus", role: "admin" as const, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() };
    const context = { ...baseContext, user };
    await expect(appRouter.createCaller(context).auth.me()).resolves.toEqual(user);
  });
});
