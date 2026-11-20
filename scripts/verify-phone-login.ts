/**
 * Verify phone-identifier normalization on login (dev server, production
 * Firestore — test data only, cleaned up at the end).
 *
 * Register a probe with a +92 phone, then sign in with all three formats
 * people type: +923…, 923… and 03…. All three must find the account.
 *
 * Usage (dev server up on :3000):
 *   ./node_modules/.bin/tsx scripts/verify-phone-login.ts
 */
import "dotenv/config";
import { deleteTester, deleteUser, getUserByEmail, listTesters } from "../server/db";

const BASE = "http://localhost:3000/api/trpc";
const cleanName = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");

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
  const reg = await trpc("auth.register", { name: "ZZ Phone Probe", email: "zz-phone-probe@gmail.com", phoneNumber: "+923009996666", password: "PhonePass123", role: "tester", teamLeaderId: 8, inviteCode: "CTRL-A-FMS9TC" });
  if (!reg.ok) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
  const userId = reg.body.result.data.json.userId as number;
  console.log(`registered probe userId=${userId}`);

  try {
    for (const identifier of ["+923009996666", "923009996666", "03009996666"]) {
      const login = await trpc("auth.login", { identifier, password: "PhonePass123" });
      console.log(`login with "${identifier}": ok=${login.ok} (want true)`);
      if (!login.ok) throw new Error(`FAIL: login with ${identifier} failed: ${JSON.stringify(login.body)}`);
    }
    const wrong = await trpc("auth.login", { identifier: "923009996666", password: "WrongPass123" });
    console.log(`login with wrong password: ok=${wrong.ok} (want false)`);
    if (wrong.ok) throw new Error("FAIL: wrong password was accepted");
    console.log("PASS: all phone formats sign in");
  } finally {
    const testers = (await listTesters()).filter(t => cleanName(t.name) === cleanName("ZZ Phone Probe") && t.teamLeaderId === 8);
    for (const t of testers) await deleteTester(t.id).catch(() => {});
    await deleteUser(userId).catch(() => {});
    const left = await getUserByEmail("zz-phone-probe@gmail.com");
    console.log("cleanup done, user left:", !!left);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
