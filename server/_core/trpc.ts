import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const protectedProcedure = t.procedure.use(requireUser);

export const adminProcedure = t.procedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    const isRootAdmin = ctx.user?.role === "admin" && ctx.user.email?.toLowerCase() === "ffahadmustafaa@gmail.com";
    if (!ctx.user || !isRootAdmin) {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
);

/** Role hierarchy for the multi-region model. */
export type StaffRole = "super_admin" | "hq_admin" | "manager" | "admin" | "team_leader" | "tester";

export function getAccountRole(user: { accountRole?: string | null } | null | undefined): StaffRole | null {
  const r = user?.accountRole;
  return r === "super_admin" || r === "hq_admin" || r === "manager" || r === "admin" || r === "team_leader" || r === "tester" ? r : null;
}

export function isSuperAdmin(user: { accountRole?: string | null; role?: string | null; email?: string | null } | null | undefined): boolean {
  if (getAccountRole(user) === "super_admin") return true;
  // Legacy root-admin fallback: the owner's account is always super admin.
  return user?.role === "admin" && user?.email?.toLowerCase() === "ffahadmustafaa@gmail.com";
}

/** HQ-level access: super admin, HQ admin, and legacy admin accounts. */
export function isHqLevel(user: Parameters<typeof getAccountRole>[0]): boolean {
  const r = getAccountRole(user);
  return r === "super_admin" || r === "hq_admin" || r === "admin";
}

/** Manager-level access: super admin, HQ admin, region manager, and legacy admin accounts. */
export function isManagerLevel(user: Parameters<typeof getAccountRole>[0]): boolean {
  const r = getAccountRole(user);
  return r === "super_admin" || r === "hq_admin" || r === "manager" || r === "admin";
}

/**
 * Region scope for the current user.
 * Returns null for global access (super admin / HQ admin),
 * otherwise the manager's region id.
 */
export function staffRegionScope(user: { accountRole?: string | null; regionId?: number | null } | null | undefined): number | null {
  if (isHqLevel(user)) return null;
  if (getAccountRole(user) === "manager") return typeof user?.regionId === "number" ? user.regionId : -1;
  return -1;
}

const requireSuperAdmin = t.middleware(async opts => {
  const { ctx, next } = opts;
  if (!ctx.user || !isSuperAdmin(ctx.user)) {
    throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

const requireHqLevel = t.middleware(async opts => {
  const { ctx, next } = opts;
  if (!ctx.user || !isHqLevel(ctx.user)) {
    throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

const requireManagerLevel = t.middleware(async opts => {
  const { ctx, next } = opts;
  if (!ctx.user || !isManagerLevel(ctx.user)) {
    throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

/** Super admin only (whitenoise, region management, HQ admin creation). */
export const superAdminProcedure = t.procedure.use(requireSuperAdmin);
/** Super admin + HQ admin (all admin features except whitenoise). */
export const hqAdminProcedure = t.procedure.use(requireHqLevel);
/** Super admin + HQ admin + region managers (region-scoped data access). */
export const managerProcedure = t.procedure.use(requireManagerLevel);
