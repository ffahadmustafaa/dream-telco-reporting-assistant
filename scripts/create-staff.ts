import { config } from "dotenv";
config();
import { randomBytes, scryptSync } from "node:crypto";
import { insertUser, getUserByEmail, listRegions, isDbConfigured } from "../server/db";

const hashPassword = (password: string) => { const salt = randomBytes(16).toString("hex"); return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`; };

async function main() {
  if (!isDbConfigured()) throw new Error("DB not configured");
  const regions = await listRegions();
  const regionByCode = new Map(regions.map(r => [r.code.toUpperCase(), r.id]));
  const staffJson = process.env.STAFF_JSON;
  if (!staffJson) throw new Error("STAFF_JSON env required");
  const staff = JSON.parse(staffJson) as Array<{ name: string; email: string; phone: string; password: string; role: string; regionCode?: string }>;
  for (const s of staff) {
    if (await getUserByEmail(s.email.toLowerCase())) { console.log(`Exists, skipping: ${s.email}`); continue; }
    const id = await insertUser({
      openId: `local_${randomBytes(16).toString("hex")}`,
      name: s.name, email: s.email.toLowerCase(), phoneNumber: s.phone,
      passwordHash: hashPassword(s.password), loginMethod: "local",
      role: "admin", accountRole: s.role as "hq_admin" | "manager",
      teamLeaderId: null, regionId: s.regionCode ? regionByCode.get(s.regionCode.toUpperCase()) ?? null : null,
      accountStatus: "active", isVerified: 1, emailVerified: 1, phoneVerified: 1,
    });
    console.log(`Created ${s.role} ${s.email} (id ${id})`);
  }
}
main().catch(e => { console.error(e.message); process.exit(1); });
