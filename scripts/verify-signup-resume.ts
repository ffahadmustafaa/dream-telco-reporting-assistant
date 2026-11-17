/**
 * Verify the signup-resume fix live against the local dev server (which
 * shares production Firestore — test data only, cleaned up at the end).
 *
 * 1. Register a fresh test user -> pending account created.
 * 2. Request OTP -> send fails (SMTP broken) -> friendly error, and the
 *    undelivered challenge is voided (completed) with createdAt stamped.
 * 2b. Simulate a delivered code (insert an uncompleted challenge), then
 *    request OTP -> alreadySent:true, no new send attempted.
 * 3. Register again with the same email -> must RESUME (same userId,
 *    resumed:true) instead of "That email is already registered".
 * 4. Register with an ACTIVE user's email -> still "already registered".
 *
 * Usage (dev server up on :3000):
 *   ./node_modules/.bin/tsx scripts/verify-signup-resume.ts
 */
import "dotenv/config";
import { deleteUser, getUserByEmail, insertAuthChallenge, listAuthChallenges, listUsers, updateAuthChallenge } from "../server/db";

const BASE = "http://localhost:3000/api/trpc";

async function trpc(path: string, input: unknown) {
  const res = await fetch(`${BASE}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ json: input }),
  });
  const body = (await res.json()) as any;
  return { ok: res.ok && !body?.error, body };
}

async function main() {
  const email = "zz-resume-test@gmail.com";
  const phone = "+923009991111";
  const inviteCode = "CTRL-A-FMS9TC";

  // 1. Fresh register.
  const first = await trpc("auth.register", { name: "ZZ Resume Test", email, phoneNumber: phone, password: "ResumePass123", role: "tester", teamLeaderId: 8, inviteCode });
  if (!first.ok) throw new Error(`step 1 register failed: ${JSON.stringify(first.body)}`);
  const userId = first.body.result.data.json.userId as number;
  console.log(`step 1: registered pending userId=${userId}`);

  try {
    // 2. Request OTP — send fails (SMTP broken) -> friendly error, challenge voided.
    const otp1 = await trpc("auth.requestRegistrationOtp", { userId });
    if (otp1.ok) throw new Error("step 2: expected the send to fail in this environment");
    const msg = JSON.stringify(otp1.body?.error?.json?.message ?? otp1.body);
    console.log(`step 2: requestOtp failed with friendly message: ${msg.includes("couldn't send") && !msg.includes("535")} (want true)`);
    if (!msg.includes("couldn't send") || msg.includes("535")) throw new Error(`FAIL: raw mail error shown: ${msg}`);
    const challenges = (await listAuthChallenges()).filter(c => c.userId === userId);
    const latest = challenges.sort((a, b) => new Date(b.expiresAt).getTime() - new Date(a.expiresAt).getTime())[0];
    console.log(`step 2: challenge createdAt stamped: ${Boolean(latest?.createdAt)} (want true), voided after failed send: ${latest?.isCompleted === 1} (want true)`);
    if (!latest?.createdAt || latest.isCompleted !== 1) throw new Error("FAIL: challenge not stamped/voided");

    // 2b. Simulate a delivered code, then request OTP -> alreadySent.
    await insertAuthChallenge({ userId, emailOtp: "123456", phoneOtp: "", expiresAt: new Date(Date.now() + 10 * 60 * 1000), isCompleted: 0, createdAt: new Date() });
    const otp2 = await trpc("auth.requestRegistrationOtp", { userId });
    if (!otp2.ok) throw new Error(`step 2b requestOtp failed: ${JSON.stringify(otp2.body)}`);
    console.log(`step 2b: second requestOtp alreadySent=${otp2.body.result.data.json.alreadySent} (want true)`);
    if (otp2.body.result.data.json.alreadySent !== true) throw new Error("FAIL: alreadySent not returned");

    // 3. Register again, same email (new name spelling) -> resume.
    const second = await trpc("auth.register", { name: "ZZ Resume Test 2", email, phoneNumber: phone, password: "ResumePass123", role: "tester", teamLeaderId: 8, inviteCode });
    if (!second.ok) throw new Error(`step 3 re-register failed: ${JSON.stringify(second.body)}`);
    const resumed = second.body.result.data.json;
    console.log(`step 3: re-register ok, userId=${resumed.userId} resumed=${resumed.resumed} (want same id ${userId}, resumed true)`);
    if (resumed.userId !== userId || resumed.resumed !== true) throw new Error("FAIL: re-register did not resume the pending account");
    const updated = await getUserByEmail(email);
    console.log(`step 3: name after resume: ${updated?.name} (want "ZZ Resume Test 2")`);

    // 4. Active user's email still blocked.
    const active = (await listUsers()).find(u => u.accountStatus === "active" && u.email && u.email !== email);
    const blocked = await trpc("auth.register", { name: "ZZ Blocked", email: active!.email!, phoneNumber: "+923009992222", password: "ResumePass123", role: "tester", teamLeaderId: 8, inviteCode });
    const blockedMsg = JSON.stringify(blocked.body);
    console.log(`step 4: active-email register rejected: ${!blocked.ok && blockedMsg.includes("already registered")} (want true)`);
    if (blocked.ok || !blockedMsg.includes("already registered")) throw new Error("FAIL: active email was not blocked");

    console.log("PASS: signup resume works end to end");
  } finally {
    const challenges = (await listAuthChallenges()).filter(c => c.userId === userId);
    for (const c of challenges) await updateAuthChallenge(c.id, { isCompleted: 1 }).catch(() => {});
    await deleteUser(userId).catch(() => {});
    console.log("cleanup done");
  }
}

main().catch(err => { console.error(err); process.exit(1); });
