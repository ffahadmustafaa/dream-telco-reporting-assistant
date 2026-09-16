import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import { sdk } from "./sdk";
import { getDb, userSessions } from "../db";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
};

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  let user: User | null = null;

  try {
    user = await sdk.authenticateRequest(opts.req);
    if (user) {
      const db = await getDb();
      if (db) {
        await db.insert(userSessions).values({ userId: user.id, identifier: user.email ?? null, role: user.accountRole ?? user.role, isActive: 1 }).onDuplicateKeyUpdate({ set: { identifier: user.email ?? null, role: user.accountRole ?? user.role, lastSeenAt: new Date(), isActive: 1 } });
      }
    }
  } catch (error) {
    // Authentication is optional for public procedures.
    user = null;
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
  };
}
