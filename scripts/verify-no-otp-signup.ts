/**
 * Verify the no-OTP signup change live against the local dev server (which
 * shares production Firestore — test data only, cleaned up at the end).
 *
 * OFF path (default): register -> account created ACTIVE + verified, no OTP
 *   sent or required; login works immediately; roster entry is linked.
 * Guards: requestRegistrationOtp / requestPasswordReset -> friendly
 *   "turned off" errors instead of attempting email delivery.
 * ON path (toggle flipped via super-admin session, restored in finally):
 *   register -> pending account, verificationSkipped false; request OTP ->
 *   still attempts the send (friendly error while SMTP is broken).
 *
 * Usage (dev server up on :3000):
 *   ./node_modules/.bin/tsx scripts/verify-no-otp-signup.ts
 */
import "dotenv/config";
import { deleteTester, deleteUser, getAppSettings, getUserByEmail, listAuthChallenges, listTesters, updateAuthChallenge } from "../server/db";
import { createSessionToken } from "../server/_core/session";

const BASE = "http://localhost:3000/api/trpc";

async function trpc(path: string, input: unknown, cookie?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${BASE}/${path}`, { method: "POST", headers, body: JSON.stringify({ json: input }) });
  const body = (await res.json()) as any;
  return { ok: res.ok && !body?.error, body };
}

const cleanName = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");

async function cleanupUser(userId: number, name: string) {
  const testers = (await listTesters()).filter(t => cleanName(t.name) === cleanName(name) && t.teamLeaderId === 8);
  for (const t of testers) await deleteTester(t.id).catch(() => {});
  const challenges = (await listAuthChallenges()).filter(c => c.userId === userId);
  for (const c of challenges) await updateAuthChallenge(c.id, { isCompleted: 1 }).catch(() => {});
  await deleteUser(userId).catch(() => {});
}

async function main() {
  const inviteCode = "CTRL-A-FMS9TC";
  const settings = await getAppSettings();
  console.log(`settings emailVerificationEnabled=${settings.emailVerificationEnabled} (want 0)`);
  if (settings.emailVerificationEnabled !== 0) throw new Error("FAIL: verification is not off by default");

  // --- OFF path: fresh register creates an active account, no OTP. ---
  const off = await trpc("auth.register", { name: "ZZ NoOtp Test", email: "zz-nootp-test@gmail.com", phoneNumber: "+923009993333", password: "NoOtpPass123", role: "tester", teamLeaderId: 8, inviteCode });
  if (!off.ok) throw new Error(`OFF register failed: ${JSON.stringify(off.body)}`);
  const offResult = off.body.result.data.json;
  const offUserId = offResult.userId as number;
  console.log(`OFF register: verificationSkipped=${offResult.verificationSkipped} (want true), userId=${offUserId}`);
  if (offResult.verificationSkipped !== true) throw new Error("FAIL: OFF register did not skip verification");

  try {
    const user = await getUserByEmail("zz-nootp-test@gmail.com");
    console.log(`OFF user: status=${user?.accountStatus} isVerified=${user?.isVerified} emailVerified=${user?.emailVerified} (want active/1/1)`);
    if (user?.accountStatus !== "active" || user?.isVerified !== 1 || user?.emailVerified !== 1) throw new Error("FAIL: OFF user is not active+verified");

    const roster = (await listTesters()).find(t => cleanName(t.name) === cleanName("ZZ NoOtp Test") && t.teamLeaderId === 8);
    console.log(`OFF roster entry: ${roster ? `id=${roster.id} status=${roster.status}` : "MISSING"} (want ACTIVE)`);
    if (!roster || roster.status !== "ACTIVE") throw new Error("FAIL: roster entry missing/inactive");

    const login = await trpc("auth.login", { identifier: "zz-nootp-test@gmail.com", password: "NoOtpPass123" });
    console.log(`OFF login: ok=${login.ok} (want true)`);
    if (!login.ok) throw new Error(`FAIL: login failed: ${JSON.stringify(login.body)}`);

    const otpGuard = await trpc("auth.requestRegistrationOtp", { userId: offUserId });
    const otpMsg = JSON.stringify(otpGuard.body?.error?.json?.message ?? otpGuard.body);
    console.log(`OFF requestRegistrationOtp blocked: ${!otpGuard.ok && otpMsg.includes("turned off")} (want true)`);
    if (otpGuard.ok || !otpMsg.includes("turned off")) throw new Error(`FAIL: OTP guard did not block: ${otpMsg}`);

    const pwdGuard = await trpc("auth.requestPasswordReset", { email: "zz-nootp-test@gmail.com" });
    const pwdMsg = JSON.stringify(pwdGuard.body?.error?.json?.message ?? pwdGuard.body);
    console.log(`OFF requestPasswordReset blocked: ${!pwdGuard.ok && pwdMsg.includes("turned off")} (want true)`);
    if (pwdGuard.ok || !pwdMsg.includes("turned off")) throw new Error(`FAIL: password-reset guard did not block: ${pwdMsg}`);

    // --- ON path: flip the toggle on as super admin, verify OTP flow returns. ---
    const superAdmin = await getUserByEmail("ffahadmustafaa@gmail.com");
    if (!superAdmin) throw new Error("super admin account not found");
    const token = await createSessionToken(superAdmin.openId, { name: superAdmin.name ?? "Fahad Mustafa" });
    const cookie = `app_session_id=${token}`;
    const flipOn = await trpc("settings.update", { emailVerificationEnabled: true }, cookie);
    if (!flipOn.ok) throw new Error(`settings flip ON failed: ${JSON.stringify(flipOn.body)}`);
    console.log(`ON toggle: flipped on (server says ${flipOn.body.result.data.json.emailVerificationEnabled})`);

    try {
      const on = await trpc("auth.register", { name: "ZZ NoOtp On", email: "zz-nootp-on@gmail.com", phoneNumber: "+923009994444", password: "NoOtpPass123", role: "tester", teamLeaderId: 8, inviteCode });
      if (!on.ok) throw new Error(`ON register failed: ${JSON.stringify(on.body)}`);
      const onResult = on.body.result.data.json;
      const onUserId = onResult.userId as number;
      console.log(`ON register: verificationSkipped=${onResult.verificationSkipped} (want false), userId=${onUserId}`);
      if (onResult.verificationSkipped !== false) throw new Error("FAIL: ON register skipped verification");
      try {
        const onUser = await getUserByEmail("zz-nootp-on@gmail.com");
        console.log(`ON user: status=${onUser?.accountStatus} (want pending)`);
        if (onUser?.accountStatus !== "pending") throw new Error("FAIL: ON user is not pending");
        const otp = await trpc("auth.requestRegistrationOtp", { userId: onUserId });
        const otpOnMsg = JSON.stringify(otp.body?.error?.json?.message ?? otp.body);
        console.log(`ON requestOtp: attempted send, friendly error: ${!otp.ok && otpOnMsg.includes("couldn't send") && !otpOnMsg.includes("535")} (want true)`);
        if (otp.ok || !otpOnMsg.includes("couldn't send") || otpOnMsg.includes("535")) throw new Error(`FAIL: ON requestOtp did not attempt send: ${otpOnMsg}`);
      } finally {
        await cleanupUser(onUserId, "ZZ NoOtp On");
      }
    } finally {
      const flipOff = await trpc("settings.update", { emailVerificationEnabled: false }, cookie);
      console.log(`ON toggle: restored off: ${flipOff.ok} (want true)`);
      if (!flipOff.ok) throw new Error(`FAIL: could not restore toggle: ${JSON.stringify(flipOff.body)}`);
      const restored = await getAppSettings();
      if (restored.emailVerificationEnabled !== 0) throw new Error("FAIL: setting not restored to off");
    }

    console.log("PASS: no-OTP signup works end to end (OFF + ON paths)");
  } finally {
    await cleanupUser(offUserId, "ZZ NoOtp Test");
    console.log("cleanup done");
  }
}

main().catch(err => { console.error(err); process.exit(1); });
