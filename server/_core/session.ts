/**
 * First-party session handling.
 *
 * Previously this lived in the Manus platform SDK (sdk.ts), which coupled
 * authentication to the Manus OAuth service. This module keeps the same
 * cookie/session semantics — HS256 JWTs in a secure cookie — but signs and
 * verifies them locally with JWT_SECRET, so the app runs on any host
 * (Vercel, Render, local) without Manus infrastructure.
 */
import { SignJWT, jwtVerify } from "jose";
import { parse as parseCookieHeader } from "cookie";
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { getUserByOpenId, type User } from "../db";
import { ENV } from "./env";

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = "Forbidden") {
    super(403, message);
    this.name = "ForbiddenError";
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = "Unauthorized") {
    super(401, message);
    this.name = "UnauthorizedError";
  }
}

export type SessionPayload = { openId: string; appId: string; name: string };

function getCookieSecret(): string {
  if (!ENV.cookieSecret) throw new Error("JWT_SECRET is not configured");
  return ENV.cookieSecret;
}

export async function createSessionToken(openId: string, options: { name: string }): Promise<string> {
  return new SignJWT({ openId, appId: ENV.appId, name: options.name })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(Math.floor(Date.now() / 1000) + Math.floor(ONE_YEAR_MS / 1000))
    .sign(new TextEncoder().encode(getCookieSecret()));
}

export async function verifySession(cookieValue: string | undefined | null): Promise<SessionPayload | null> {
  if (!cookieValue) return null;
  try {
    const { payload } = await jwtVerify(cookieValue, new TextEncoder().encode(getCookieSecret()));
    const { openId, appId, name } = payload as Record<string, unknown>;
    if (typeof openId !== "string" || typeof name !== "string") return null;
    return { openId, appId: typeof appId === "string" ? appId : "", name };
  } catch {
    return null;
  }
}

/** Extract the raw session token from a Cookie header or an Authorization: Bearer header. */
export function extractSessionToken(req: { headers: Record<string, string | string[] | undefined> }): string | null {
  const cookieHeader = req.headers.cookie;
  if (typeof cookieHeader === "string") {
    const cookies = parseCookieHeader(cookieHeader);
    if (cookies[COOKIE_NAME]) return cookies[COOKIE_NAME];
  }
  const authorization = req.headers.authorization;
  if (typeof authorization === "string") {
    const [scheme, token] = authorization.split(" ");
    if (scheme?.toLowerCase() === "bearer" && token) return token;
  }
  return null;
}

/**
 * Resolve the request's session to a database user, creating/updating the
 * local user row on each authenticated request (same as before).
 */
export async function authenticateRequest(req: {
  headers: Record<string, string | string[] | undefined>;
}): Promise<User> {
  const token = extractSessionToken(req);
  if (!token) throw new UnauthorizedError("Missing session");
  const session = await verifySession(token);
  if (!session) throw new UnauthorizedError("Invalid or expired session");
  const user = await getUserByOpenId(session.openId);
  if (!user) throw new ForbiddenError("User not found");
  return user;
}
