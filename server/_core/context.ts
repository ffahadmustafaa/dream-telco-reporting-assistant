import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../db";
import { authenticateRequest } from "./session";
import { getUserSessionByUserId, insertUserSession, updateUserSessionByUserId } from "../db";

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
    const sessionUser = await authenticateRequest(opts.req);
    if (sessionUser) {
      user = sessionUser;
      const currentUser = sessionUser;
      const now = new Date();
      // One targeted read; only write when the heartbeat is stale (>5 min)
      // so ordinary page loads don't pay for a Firestore write every time.
      const existing = await getUserSessionByUserId(currentUser.id).catch(() => undefined);
      const values = {
        identifier: currentUser.email ?? null,
        role: currentUser.accountRole ?? currentUser.role,
        lastSeenAt: now,
        isActive: 1,
      };
      if (existing) {
        const lastSeen = existing.lastSeenAt ? new Date(existing.lastSeenAt).getTime() : 0;
        if (now.getTime() - lastSeen > 5 * 60 * 1000) {
          await updateUserSessionByUserId(currentUser.id, values).catch(() => undefined);
        }
      } else {
        await insertUserSession({ userId: currentUser.id, ...values, loginAt: now }).catch(() => undefined);
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
