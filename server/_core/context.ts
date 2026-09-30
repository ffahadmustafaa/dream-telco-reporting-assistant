import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../db";
import { authenticateRequest } from "./session";
import { insertUserSession, listUserSessions, updateUserSessionByUserId } from "../db";

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
      const existing = (await listUserSessions()).find((session) => session.userId === currentUser.id);
      const values = {
        identifier: currentUser.email ?? null,
        role: currentUser.accountRole ?? currentUser.role,
        lastSeenAt: now,
        isActive: 1,
      };
      if (existing) {
        await updateUserSessionByUserId(currentUser.id, values);
      } else {
        await insertUserSession({ userId: currentUser.id, ...values, loginAt: now });
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
