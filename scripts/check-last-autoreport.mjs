// One-off check: did tonight's 10:30 PM (22:30 PKT) Dream Telco auto-report cron fire?
// Reads Firestore app_settings/1.lastAutoReport and verdicts it against the current
// Asia/Karachi date. Must be run from an environment with firestore.googleapis.com egress
// (the restricted research sandbox blocks it; the main agent's environment allows it).
//
// Usage: node check-last-autoreport.mjs [--expect-date YYYY-MM-DD]
// Exit 0 + verdict JSON on stdout. Verdicts:
//   OK      - lastAutoReport is dated today (Karachi) and falls within 22:00-23:59 PKT
//   STALE   - lastAutoReport is older than today -> cron did not run / skipped / threw
//   SKIPPED - timestamp exists but outside the expected window (check drift logic)
//   UNCONFIGURED - doc missing or field absent
//
// What the timestamp proves: scheduledDailyReport() only updates lastAutoReport AFTER
// deliverDailyReport() resolved without throwing, i.e. the cron ran, the fixed
// buildReportWorkbook() code path produced the Excel, and SMTP sendMail() accepted
// the message. It does NOT prove inbox delivery. If STALE, likely causes in order:
//  1) Vercel cron misfired or was paused (check Vercel dashboard -> Cron Jobs)
//  2) driftMinutes > 90 skip (configured reportTime far from 22:30 PKT)
//  3) deliverDailyReport threw (SMTP auth/network; see Vercel runtime logs)

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const FA = '/home/hatch/workspace/dream-telco-manus/node_modules/.pnpm/firebase-admin@14.5.0/node_modules/firebase-admin';
const appMod = require(FA);
const fsMod = require(FA + '/lib/firestore/index.js');
const sa = require('/home/hatch/.config/dream-telco/service-account.json');

const argDate = (process.argv.find(a => a.startsWith('--expect-date=')) || '').split('=')[1];
const karachiToday = argDate || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const app = appMod.initializeApp({ credential: appMod.cert(sa), projectId: 'dream-telco-reporting' });
const db = fsMod.initializeFirestore(app, { preferRest: true });

db.collection('app_settings').doc('1').get().then(snap => {
  const d = snap.data() || {};
  const ts = d.lastAutoReport || null;
  let verdict = 'UNCONFIGURED', detail = 'app_settings/1 has no lastAutoReport field';
  if (ts) {
    const asDate = new Date(ts);
    const kDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(asDate);
    const kTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(asDate);
    if (kDate === karachiToday && kTime >= '22:00' && kTime <= '23:59') {
      verdict = 'OK';
      detail = `cron ran and delivered for ${kDate} at ${kTime} PKT`;
    } else if (kDate === karachiToday) {
      verdict = 'SKIPPED';
      detail = `timestamp is today but at ${kTime} PKT (outside 22:00-23:59); check drift/skip logic`;
    } else {
      verdict = 'STALE';
      detail = `last successful run was ${kDate} ${kTime} PKT; tonight's run did not complete`;
    }
  }
  console.log(JSON.stringify({
    verdict, detail,
    lastAutoReport: ts,
    reportTime: d.reportTime || null,
    timezone: d.timezone || null,
    recipient: d.adminEmail || null,
    smtpHost: d.smtpHost || null,
    smtpConfigured: Boolean(d.smtpPass || d.smtpPassword),
    karachiToday,
  }, null, 2));
  process.exit(verdict === 'OK' ? 0 : 2);
}).catch(e => { console.error('ERR', e.message); process.exit(3); });
