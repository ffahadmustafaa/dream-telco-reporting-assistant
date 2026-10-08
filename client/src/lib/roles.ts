/** Shared role helpers for the multi-region model. */
export type StaffRole = "super_admin" | "hq_admin" | "manager" | "admin" | "team_leader" | "tester";

export function isSuperAdmin(role?: string | null): boolean {
  return role === "super_admin";
}

export function isHqLevel(role?: string | null): boolean {
  return role === "super_admin" || role === "hq_admin";
}

/** Super admin, HQ admin, or region manager. */
export function isManagerLevel(role?: string | null): boolean {
  return role === "super_admin" || role === "hq_admin" || role === "manager";
}

/** Legacy check kept for compatibility: any staff-level account. */
export function isStaff(role?: string | null, legacyRole?: string | null): boolean {
  return isManagerLevel(role) || role === "admin" || legacyRole === "admin";
}
