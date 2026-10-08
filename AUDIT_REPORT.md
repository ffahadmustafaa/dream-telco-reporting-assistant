# Dream Telco Reporting Assistant — Full Module Audit

**Date:** 2026-10-08
**Codebase:** `~/workspace/dream-telco-manus` (branch `feature/dream-telco-consolidation`)
**Requested by:** Fahad Mustafa (owner)
**Scope:** Every page/module, analyzed for every role (tester, team_leader, manager, hq_admin, super_admin)

---

## Role Model (verified in `server/_core/trpc.ts` and `client/src/lib/roles.ts`)

| Role | Scope | Whitenoise | Automation |
|---|---|---|---|
| `super_admin` (Fahad) | Global, all regions | ✅ | ✅ |
| `hq_admin` | Global, all regions | ❌ | ❌ |
| `manager` | One assigned region only | ❌ | ❌ |
| `team_leader` | Own team only | ❌ | ❌ |
| `tester` | Own data only | ❌ | ❌ |

Backend procedure types: `protectedProcedure` (any logged-in user) → `managerProcedure` (super/hq/manager) → `hqAdminProcedure` (super/hq) → `superAdminProcedure` (super only). Legacy `admin` role still exists and counts as HQ-level in most checks.

Regions: Central A (id 1), Central B (id 2), Central C (id 3). New testers/team leaders register with a per-region invite code.

---

## EXECUTIVE SUMMARY — Critical Findings

### 🔴 HIGH severity (fix first)

1. **hq_admin can demote/block/delete the super_admin.** `userManagement.updateRole/updateStatus/delete` impose zero target-role checks when the caller is HQ-level. An hq_admin can demote Fahad to tester, block his account (locking the owner out — login rejects blocked accounts), or delete his account entirely. Only self-targeting is blocked. (User Directory)
2. **AI assistant ignores region scoping for managers.** A manager can read all-region data ("top performers this month" returns every region), log reports for other regions' testers, and `remove_tester "Ali"` deactivates every name match company-wide. The LLM ingestion layer (Layer 3) has no role scoping at all — a tester calling the endpoint directly can write OTP numbers for other testers. (AI Assistant)
3. **Payout import is open to any authenticated user.** `payouts.importText` is `protectedProcedure` — a tester with a direct API call can inject fabricated payout rows with arbitrary amounts into the ledger, polluting review queues and reports. Client-side redirect is the only barrier. (Payout Control)
4. **Imported payouts can never be approved.** `importText` doesn't set `reviewStatus`, so imported rows show "UNKNOWN", never appear in the pending queue, and show zero action buttons in the review table — the entire payout review workflow is broken for imported data. (Payout Control)
5. **Testers can see their own payout amounts.** `payouts.list` and `dashboard.overview` return full `netPayout`/`grossPayout` figures to testers, violating the "testers never see earnings" policy. The page also flashes with real data before the client redirect fires. (Payout Control)
6. **Hardcoded owner-email privilege path.** `auth.register` grants `super_admin` to anyone registering with `ffahadmustafaa@gmail.com`. Only the real inbox owner can complete email OTP today, but it's an email-string privilege grant in a public endpoint. (Regions/Admin)

### 🟠 MEDIUM severity (fix soon)

7. **Testers can switch to a team leader in another region** via Profile settings — the dropdown lists all regions' leaders and there's no server-side region check, desyncing the account's regionId from its roster row. (Profile)
8. **Profile validation contradicts Fahad's account rules** — registration enforces Gmail-only, Pakistani mobile, 3–20 char names; profile update allows any email, any phone format, 2–100 char names. (Profile)
9. **Every profile save silently grants a 1-year session** (`setLocalSession(..., true)`), even without "remember me". (Profile)
10. **"Selected Team Leader is not active" still fires from Profile** — the account-only leader fallback added to registration was never added to the profile endpoint. (Profile)
11. **Cron endpoint lets hq_admin trigger the full email blast.** `/api/scheduled/dailyReport`'s session fallback allows hq_admin (not just super_admin), bypassing the "Automation is super-admin-only" restriction for the send path. (Automation)
12. **Whitenoise + SMTP passwords stored plaintext in Firestore** (`whitenoise_config/1`, `appSettings/1`) instead of env vars/Secret Manager. (Whitenoise/Automation — known issue, confirmed)
13. **Managers can't see unmatched payout exceptions** — rows with `testerId: null` fall through every region filter, so only HQ+ can resolve them, contradicting the manager mandate. (Payout Control)
14. **Payout amount misparsing** — first token containing any digit is taken as the amount, so phone numbers/CNICs become absurd amounts. (Payout Control)
15. **Targets list has zero region filtering** — a Central B manager sees Central A's targets. Team leaders can also create company-wide targets the UI can't scope. (Targets)
16. **HQ cannot create team leaders outside Central A** — `addLeader` silently falls back to Central A with no region picker in the UI. (Roster)
17. **Name-based user→roster linkage breaks silently** — team leaders/testers who rename their account get empty Overview/History/Roster views with no error. Systemic across Overview, Daily, History, Team History, Roster. (Multiple)
18. **Daily report "120/120" shorthand is broken** — the form sends `Number(quantity)` so the advertised shorthand becomes NaN and fails validation. (Daily Reporting)
19. **Export report button errors for team leaders/testers** — visible to all but backend is manager-only. (Daily Reporting)
20. **Audit trail hides most region activity from managers** — filter keys on roster IDs that most audit payloads don't carry. Team leaders see a misleading "No changes logged" (actually access-denied). (Audit Trail)

### 🟡 Lower-priority issues

- Automation page: React hooks-after-early-return bug; `runReportNow` conflates "Last auto-report" timestamp; compile runs before the pause check (wasted compute).
- Whitenoise: per-number queries don't paginate (silent undercount); no client-side role guard (confusing FORBIDDEN toasts); no retry/backoff.
- Roster: delete buttons have no confirmation despite cascading deletes; `moveTester` has no UI; silent cross-region move for HQ on name-match reassign.
- Admin Dashboard: Export/Send-test buttons visible to HQ/managers but fail; payout review allows any status transition (PAID→PENDING).
- Targets: write-only module — nothing consumes targets (no achievement column anywhere despite the subtitle's formula).
- My/Team History: 200-record cap with no notice; card totals computed from capped data.
- Regions: HQ "can create managers" has no UI; duplicate managers per region possible; no region-deactivate UI.

---

# PART 1 — Reporting & History

## 1.1 Overview (`/`)

**Purpose:** Command-center landing page — greeting, 4 KPI metric cards, per-team-leader performance bar chart, top-6 performers list, quick-action shortcuts.

**How it works:** Takes a date (defaults to today, editable). Calls `dashboard.overview({date})` (`server/routers.ts:764`, `protectedProcedure`), returning per-leader superX/sectionX/total/reporting/activeTesters/zero counts, `topTesters`, payout exception counts, and aggregate totals. Backend scoping (routers.ts:767–777): manager → region filter via `getRegionScope`; team_leader → name-matched own roster row; tester → name-matched own row + its leader; super/hq → global.

**Role differences:**
- **super_admin / hq_admin:** global — all teams, top performers, payout-exception counts.
- **manager:** same dashboard, region-scoped (own region's leaders, testers, totals, exceptions).
- **team_leader:** own team only (single bar in the chart; top performers are own testers).
- **tester:** own team's single leader card and team top performers; KPI cards reflect team only. Payout exceptions show a count, not amounts — consistent with "testers never see earnings".

**Issues:**
- **[Low]** Quick actions "Process payouts" and "Ask the assistant" render for testers (`Home.tsx:169–171`), but the layout force-redirects testers away from `/payouts` and `/assistant` — buttons silently bounce. Backend is role-gated, so UX-only; hide for testers.
- **[Medium]** All team_leader/tester scoping is by account *name* matching (`cleanName(ctx.user.name)` vs roster names, routers.ts:772–775). Renaming in /profile silently empties the overview — no error, no hint. A stable user→roster link is missing.

## 1.2 Daily Reporting (`/daily`)

**Purpose:** Enter daily OTP counts per tester/project, view the day's ledger table, download the styled daily Excel report.

**How it works:** Form = business date, tester dropdown, project dropdown, quantity → `performance.create` (`server/routers.ts:1006`, `protectedProcedure`). Entries **accumulate** (same tester+project+date adds to the existing record). Ledger table lists the day's records. "Export report" → `adminDashboard.exportDailyReport` (`managerProcedure`, routers.ts:723) → `compileDailyReport(date, regionId?)` builds the workbook server-side; managers get a `_Region{n}` file, HQ/super get the global file.

**Role differences:**
- **team_leader:** dropdown limited to own team ("Submit for any tester on your team — use this when someone is absent"); backend enforces tester belongs to their team (routers.ts:997–1000).
- **tester:** dropdown contains only own roster row; backend rejects any other testerId (routers.ts:996).
- **manager:** can submit for any tester in own region (`scope.testerIds`, routers.ts:1001–1004); export is region-scoped.
- **hq_admin / super_admin:** global — any tester, global export.

**Issues:**
- **[Medium]** The page advertises shorthand entry ("such as 120/120", `Home.tsx:174`) and backend `parseQuantity` supports it — but the form sends `quantity: Number(quantity)` (`Home.tsx:181`), so `"120/120"` → `NaN` → zod fails → cryptic error toast. Fix: send the raw string.
- **[Low-Medium]** "Export report" is shown to all roles but the endpoint is `managerProcedure` — team leaders/testers get a FORBIDDEN toast. Hide/disable for non-manager-level roles.
- **[Low-Medium]** No date-range validation on `businessDate` — backdating/future-dating is unrestricted. Consider today ± N days.
- **[Low]** Static hint "Add a target in the Targets section…" is shown to testers, who are redirected away from `/targets` — dead advice.

## 1.3 My History (`/history`)

**Purpose:** A tester's own verified submission history (date, project, quantity, source), newest first.

**How it works:** `performance.myHistory` (`server/routers.ts:964`, `protectedProcedure`) finds the roster tester row matching the user's account name and returns that tester's records (capped at 200), annotated with project names. Non-testers get `[]`. Sidebar-visible only for testers.

**Role differences:** tester-only. team_leader/manager/hq/super get `[]` (they use Team history / reports instead).

**Issues:**
- **[Medium]** Name-matching brittleness (routers.ts:966): registration typo or /profile rename → empty history with misleading "No personal submissions yet." No diagnostic.
- **[Low]** 200-row cap has no pagination and no "showing latest 200" indicator.

## 1.4 Team History (`/team-history`)

**Purpose:** One card per tester on the team with that tester's complete submission history, status badge, and lifetime total.

**How it works:** `performance.teamHistory` (`server/routers.ts:971`, `protectedProcedure`) role-gates explicitly: only team_leader, manager, HQ-level. Team leaders scoped to own roster leader (name-matched); managers to their region's leaders; HQ/super all leaders. Each tester's records capped at 200.

**Role differences:**
- **team_leader:** own team's testers only.
- **manager:** all teams in own region only.
- **hq_admin / super_admin:** all regions, all teams.
- **tester:** blocked at backend ("Only team leaders and managers can view team history"); sidebar hides the page.

**Issues:**
- **[Low-Medium]** Card "Total" is computed from the capped 200 records with no truncation notice — understated lifetime totals for long-serving testers.
- **[Medium]** Team-leader identity is name-matched (routers.ts:979); rename or missing roster row → `[]` and misleading "No testers on your team yet."
- **[Low]** No date-range filter or search; manager view does N+1 `listPerformanceByTester` calls — fine now, paginate if regions grow.

---

# PART 2 — Payouts, Roster, Targets

## 2.1 Payout Control (`/payouts`)

**Purpose:** Import raw payout data (pasted text or XLSX/CSV/TXT upload), auto-match each row against the master roster by tester name, flag exceptions (unmatched/ambiguous/duplicate/missing amount), review (approve/reject/mark-paid), override individual records, and export a payout workbook.

**How it works:**
- **Frontend** (`Home.tsx:230`, `function Payouts()`): left card — file picker (XLSX parsed client-side), source-file name, raw-text textarea, "Process source" → `payouts.importText`; shows import counts (records/matched/exceptions). Right card — recent payout records table (tester, project, **net payout PKR**, match status, source file), first 12 rows only, "Generate workbook" export. "Admin actions" column (Edit via `window.prompt`, Delete via `window.confirm`) renders when `isStaff()` (manager+).
- **Backend** (`routers.ts:1029–1082`):
  - `payouts.list` (`protectedProcedure`): HQ → all; manager → region-linked rows; team_leader → own team (name-matched); tester → own rows (name-matched).
  - `payouts.importText` (`protectedProcedure`): per-line parsing — first token containing a digit (excluding dates) = amount; exact-name → `MATCHED`; startsWith fuzzy → `POSSIBLE_MATCH`; duplicate line → `DUPLICATE`; multiple exact matches → `CONFLICT`; no amount → `MISSING_AMOUNT`; else `UNMATCHED`. Inserts one row per line + import record + audit log.
  - `payouts.update` / `payouts.delete` (`managerProcedure`): region-checked for managers.
  - `adminDashboard.reviewPayout` (`managerProcedure`, routers.ts:751): PENDING→APPROVED→REJECTED/PAID lifecycle, region-checked, only `MATCHED` rows can be approved. Surfaced in `/admin` "Payout management".

**Role differences:**
| Role | Sidebar | Import | Sees amounts | Edit/Delete | Review |
|---|---|---|---|---|---|
| tester | hidden + redirected | Backend allows (protectedProcedure!) — only client redirect stops UI | Own rows WITH full amounts (violation) | No | No |
| team_leader | visible | Allowed | Own team's rows with amounts | No | No |
| manager | visible | Allowed | Region-scoped rows (unmatched invisible — see P4) | Own region | Own region |
| hq_admin / super_admin | visible | Allowed | All rows | Global | Global |

**Issues:**
- **P1 [HIGH]** Imported payouts never get `reviewStatus` — `importText` doesn't set it (nor `createdAt`). Consequences: invisible in pending badge/counts; `/admin` review table shows zero action buttons for imported rows (buttons render only for PENDING/APPROVED); `StatusBadge` shows "UNKNOWN". Fix: set `reviewStatus: "PENDING"` + `createdAt` in `importText`.
- **P2 [HIGH — security]** `payouts.importText` is `protectedProcedure` — any authenticated user including testers can inject arbitrary payout rows via direct tRPC call, polluting review queues, metrics, and per-region Excel reports. Should be `managerProcedure` minimum.
- **P3 [MEDIUM-HIGH]** `payouts.list` returns testers' own rows with full amounts; `dashboard.overview` also ships payout rows + `payoutTotals.net` to testers. Page flashes with real data before the client redirect. Backend should return `[]`/strip amounts for testers (contrast `roster.list`, which returns empty for testers).
- **P4 [MEDIUM]** Unmatched rows (`testerId: null`) are invisible to region managers in `payouts.list`, `dashboard.overview`, and `adminDashboard.summary` — only HQ+ can resolve them. Needs a region-attribution rule or HQ triage queue.
- **P5 [MEDIUM]** Amount parsing takes the first digit-containing token — `03001234567, Ahmed, 5000` parses the phone number as the amount. No sanity checks. Fix: prefer last numeric token, skip phone-like tokens.
- **P6 [LOW-MEDIUM]** No input size cap — each line = 1 Firestore write; `insertImport` stores full `rawData` (1 MB doc limit). Write-amplification/quota risk.
- **P7 [LOW]** Duplicate detection is exact-line only — trivial whitespace differences double-insert.
- **P8 [LOW]** `reviewPayout` allows any transition (PAID→PENDING); no state machine.
- **P9 [LOW — UX]** Table shows 12 rows, no pagination/search; empty-state `colSpan` mismatch on the 6-column staff table.

## 2.2 Roster & Teams (`/roster`)

**Purpose:** Master-data management of the Team Leader → Tester hierarchy: add leaders/testers, activate/deactivate, delete (with cascade), team leaders managing their own team.

**How it works:**
- **Frontend** (`Home.tsx:255`, `function Roster()`): team_leader → `MyTeamRoster()` (add tester to own team, rename, activate/deactivate via `addOwnTester`/`updateOwnTester`); everyone else → admin view: "Add to roster" card (`addLeader`, `addTester` with leader dropdown) + "Active hierarchy" grouped by leader with Deactivate/Reactivate and one-click Delete (`toggleTester`, `deleteTester`, `deleteLeader`). Note: `moveTester` exists in backend but has **no UI**.
- **Backend** (`routers.ts:799–917`):
  - `roster.list` (`protectedProcedure`): tester → empty; team_leader → own leader + testers (name-matched); manager → region scope; HQ → all.
  - `addLeader` (`managerProcedure`): creates leader in manager's region; **for HQ/super (scope null) silently falls back to Central A**.
  - `addTester` (`managerProcedure`): rejects out-of-region leaders; name-match → reassign existing (region-checked); else create with `regionId = leader.regionId ?? scope.regionId`.
  - `moveTester`/`toggleTester`/`deleteTester`/`deleteLeader` (`managerProcedure`): region-checked; deletes cascade to performance + targets + payouts.
  - `addOwnTester`/`updateOwnTester` (`protectedProcedure` + manual team_leader check): own-team only.

**Role differences:**
| Role | View | Add leader/tester | Deactivate | Delete |
|---|---|---|---|---|
| tester | (empty admin UI if navigated directly; mutations blocked) | No | No | No |
| team_leader | `MyTeamRoster`: own team | Own testers only | Own testers | No |
| manager | Region hierarchy | Own region | Own region | Own region |
| hq_admin / super_admin | Global hierarchy | Yes (leaders → Central A fallback) | Yes | Yes |

**Issues:**
- **R1 [MEDIUM]** HQ/super cannot create a Team Leader in Central B or C — `addLeader` uses Central A fallback and the UI has no region picker. Only region managers can populate their own region. Needs a region selector for HQ-level users.
- **R2 [LOW]** `addOwnTester` never sets `regionId` — team-leader-added testers get `regionId: null`. Visibility still works via leader fallback, but future strict-`regionId` queries would drop them.
- **R3 [MEDIUM-LOW]** Delete buttons fire immediately with no `window.confirm`, despite cascade-deleting performance history, targets, and payouts — contradicting the page's own "Deactivate instead of deleting" guidance. Targets' delete does confirm — inconsistent.
- **R4 [LOW-MEDIUM]** `addTester`'s name-match reassign path skips region checks when scope is null (HQ) — an HQ admin can silently move a tester (and history linkage) to another region. Should warn/confirm.
- **R5 [LOW]** `Roster()` renders the full admin "Add to roster" UI to testers (only team_leader is branched out). Backend rejects, so confusing dead UI rather than a hole.
- **R6 [LOW]** `moveTester` has no frontend UI — dead surface or missing feature.
- **R7 [LOW]** Name-identity fragility (`cleanName` matching) — a team leader whose account name differs from the roster name silently gets an empty team.

## 2.3 Targets (`/targets`)

**Purpose:** Explicit numeric targets (daily/weekly/monthly/tester/team-leader/project levels) so reports can show achievement vs. target.

**How it works:**
- **Frontend** (`Home.tsx:264`, `function Targets()`): identical page for all roles — "Create a target" card (level dropdown + quantity → `targets.create` with `effectiveDate: today`) and "Active targets" table with inline edit/delete (Actions column gated by `isStaff()`). Subtitle claims "Achievement = Actual ÷ Target × 100" but **no achievement column exists**.
- **Backend** (`routers.ts:1083–1138`):
  - `targets.list` (`protectedProcedure`): `listActiveTargets()` — **no role or region filtering whatsoever**.
  - `targets.create` (`protectedProcedure`): testers blocked; managers region-checked only when `testerId`/`teamLeaderId` supplied; team_leaders restricted to own team when IDs supplied; HQ unrestricted.
  - `targets.update`/`targets.remove` (`protectedProcedure` + manual `isManagerLevel` check): managers region-checked via linkage; targets with both IDs null are uneditable by managers (HQ-only).

**Role differences:**
| Role | Create | Edit/Delete | Sees |
|---|---|---|---|
| tester | Backend blocks (but form renders) | No | All targets (unfiltered) |
| team_leader | Yes — including company-wide targets (T2) | No | All targets |
| manager | Yes; scoped only if entity IDs passed | Yes, except global targets | All targets incl. other regions' |
| hq_admin / super_admin | Yes, global | Yes | All targets |

**Issues:**
- **T1 [MEDIUM]** `targets.list` has no region filtering — Central B manager sees Central A's targets; inconsistent with `dashboard.overview` which filters targets.
- **T2 [MEDIUM-LOW]** Team leaders can create company-wide targets — own-team checks only trigger when `testerId`/`teamLeaderId` are provided, and the UI never sends them. The team leader's own manager can't even correct it (T3's HQ-only rule).
- **T3 [LOW-MEDIUM]** Write-only data — targets are never consumed: no achievement column, `DailyReport` shows static "Target: Not provided", assistant doesn't reference targets.
- **T4 [LOW]** Level dropdown offers TESTER/TEAM_LEADER/PROJECT but the form sends no entity IDs — dangling rows that scoped views filter out while `/targets` still lists them. Views disagree.
- **T5 [LOW]** `update`/`remove` do the DB read before the `isDbConfigured()` guard; use manual role check instead of `managerProcedure` — inconsistent.
- **T6 [LOW]** Create card renders for testers (backend rejects); no inline hint.

---

# PART 3 — Audit, Assistant, Profile

## 3.1 Audit Trail (`/audit`)

**Purpose:** Read-only governance log — every meaningful change listed newest-first with action name, reason/command, and timestamp.

**How it works:** Frontend `Audit()` (`Home.tsx:273`) calls `trpc.audit.list` with no input/pagination/error handling; renders action + `reason || userCommand` + timestamp. Backend `audit.list` (`server/routers.ts:1139`, `protectedProcedure` + manual `isManagerLevel` check): HQ gets all logs (capped at 100); managers get region-filtered logs (log shown only if `newValue`/`oldValue` contains in-region `testerId`/`teamLeaderId`, or `log.userId === ctx.user.id`).

**Role differences:**
| Role | Sidebar | Backend result |
|---|---|---|
| tester | Hidden + hard redirect to `/daily` | Throws "Only staff can view the audit log." |
| team_leader | Visible (no flag) | Throws — page misleadingly shows "No changes have been logged yet." |
| manager | Visible | Region-filtered entries |
| hq_admin / super_admin | Visible | All entries |

**Issues:**
- **[Medium]** Managers can't see most region activity — the filter keys on `testerId`/`teamLeaderId` in old/new values, but many region-relevant actions (`AI Report Imported`, `Dataset Uploaded`, `Target Changed`) don't carry roster IDs. Fix: include `testerId`/`teamLeaderId`/`regionId` in audit payloads.
- **[Low-Medium]** Misleading empty state for team leaders — sidebar advertises the page but backend denies; component has zero error handling.
- **[Low]** Manager filter runs in memory *after* the 100-log global cap — region entries can be pushed out of the window.
- **[Low]** UI claims "action, old value, new value, and reason" but renders only action + reason + timestamp — actor and old/new values never shown.

## 3.2 AI Assistant (`/assistant`)

**Purpose:** Chat-based reporting co-pilot: log OTP reports in plain language, manage roster, ask deterministic questions, upload spreadsheets for Q&A, generate downloadable Excel/PNG reports.

**How it works:** Frontend `Assistant()` (`Home.tsx:304`) — chat box → `trpc.assistant.chat` with full message history; dataset upload → `assistant.uploadDataset`/`askDataset`; report table + downloads from the returned `ingestion` object. **No role-based UI differences, no scope indicator.** Backend `assistant.chat` (`routers.ts:1213`, `protectedProcedure`) has three layers: (1) deterministic regex commands (`parseAssistantCommand`, `server/aiAssistant.ts:70`) with team/name scoping for testers and team leaders; (2) deterministic Q&A over a role-scoped snapshot; (3) LLM fallback via `invokeLLM` (`server/_core/llm.ts`) — system prompt demands JSON-only output; parsed JSON drives roster/performance/payout-rule writes. AI provider: generic OpenAI-compatible endpoint, default `https://forge.manus.im/v1/models`; the `chat` call passes no `model`, so the `LLM_MODEL` env default is dead config on this path.

**Role differences (as coded — this is where it breaks):** The router computes `isAdmin = ctx.user.accountRole === "admin" || ctx.user.role === "admin"` — a **legacy check**. Because staff accounts are created with `role: "admin"`, **hq_admin and managers are treated as global admins** in the assistant: `scopeTesters`/`scopeLeaders` = entire unfiltered roster; `getRegionScope` never consulted.

**Issues:**
- **[HIGH]** Managers' assistant is not region-scoped at all — cross-region read ("top performers this month" returns all regions) and write (`log_report` for any region's tester, `add_tester` under any leader, `remove_tester "Ali"` deactivates every name match company-wide, `set_target` takes `matches[0]` across regions). Directly contradicts the hierarchy.
- **[HIGH]** Layer 3 (LLM ingestion) has no role scoping for any role — the write loop inserts/updates performance for every tester name the LLM extracts with zero accountRole checks (unlike Layer 1). A tester calling the endpoint directly can log/overwrite other testers' OTP (e.g. number-words dodge the digit regex); `reportRows` is built from all ACTIVE testers company-wide, leaking names/totals to team leaders and (via API) testers.
- **[MEDIUM]** Prompt-injection surface with DB-write consequences — input schema allows `role: "system"` in messages; server forwards user-supplied history verbatim after its own system prompt. A crafted client can override the "JSON only / never invent counts" instructions; parsed JSON drives `upsertTeamLeader`, `upsertTesterByName`, deactivations, `setPayoutRule`, performance writes. Fix: strip `role: "system"` from client history.
- **[MEDIUM]** Junk-tester auto-creation — "Unknown tester? I'll add them automatically" with a loose name regex ("yesterday Ali completed 500…" → tester "Yesterday Ali"). Roster pollution is one message away; names are the join key for all reporting.
- **[LOW-MEDIUM]** Arbitrary report dates — `businessDate`/LLM `extraction.date` validated only as `YYYY-MM-DD`; history can be silently rewritten via API.
- **[LOW]** Fragile super-admin detection — relies on Fahad's legacy `role: "admin"` field surviving; `askDataset` uses `accountRole !== "admin"`, so hq_admins/managers can only query their own uploads.
- **[LOW]** `ENV.llmModel` default is never passed to `invokeLLM` here — setting `LLM_MODEL` silently has no effect.

## 3.3 Profile Settings (`/profile`)

**Purpose:** "My profile" — view/edit name, email, mobile, team leader (testers), change password, sign out, permanently delete own account. Every save requires current-password confirmation.

**How it works:** Frontend `TesterProfile()` + `ProfileAccountActions()` (`Home.tsx:220`, `:200`). Loads `auth.myProfile`; testers get a team-leader dropdown fed by `auth.registrationTeamLeaders` (no invite code → **all ACTIVE leaders globally**); submit → `auth.updateProfile` (verifies current password via scrypt, enforces email/phone uniqueness, optionally changes password and/or team leader with roster sync via `upsertTesterByName`). Delete: two-click confirm → `auth.deleteMyAccount` (`server/db.ts:414` deletes sessions + user record only — roster/performance kept).

**Role differences:** Sidebar shows "Profile settings" only to testers (`testerOnly`), but `/profile` is unguarded — managers/hq/super can open it directly and use every action including delete. Team-leader dropdown/change is tester-only. `deleteMyAccount` blocks `accountRole === "admin" || role === "admin"` — hq_admins/managers blocked via legacy `role: "admin"`; Fahad blocked the same way today, but **only because his legacy `role` field is still `"admin"`**.

**Issues:**
- **[MEDIUM-HIGH]** Testers can change to a team leader in another region — dropdown lists all regions' leaders, no server-side region check. `upsertTesterByName` moves the roster row but the user's `regionId` is never updated → account and roster row disagree on region, breaking region-scoped views.
- **[MEDIUM]** "Selected Team Leader is not active" still fires from Profile — the dropdown mixes roster leaders (roster id) with account-only leaders (user id); `updateProfile` looks up only roster leaders. The registration fallback was never added here.
- **[MEDIUM]** Changing name + team leader together desyncs the roster — `upsertTesterByName(ctx.user.name, …)` uses the **old** session name, not the newly submitted name. Roster keeps old name under new leader; new name has no roster row.
- **[MEDIUM]** Every save silently grants a 1-year session — `setLocalSession(ctx, {...}, true)` sets `maxAge: 365 days` even without "remember me".
- **[MEDIUM]** Validation contradicts Fahad's standing rules — registration enforces Gmail-only/Pakistani-mobile/3–20 chars; profile allows any email, any international phone, 2–100 char names.
- **[MEDIUM]** No pending-payout guard on self-delete — a tester with unpaid payouts can delete their account; roster/performance rows orphan from any login identity.
- **[LOW-MEDIUM]** OAuth/migrated (password-less) users can never update their profile — `updateProfile` requires `passwordHash`; they always fail "Current password is incorrect" with no alternative path.
- **[LOW]** A tester cannot clear/unset their team leader — null selection throws; UI offers no empty option.

---

# PART 4 — Administration

## 4.1 Admin Dashboard (`/admin`)

**Purpose:** Staff operations console: approve new registrations, block/unblock accounts, review the payout lifecycle (PENDING → APPROVED/REJECTED → PAID), trigger Excel exports / test email dispatches.

**How it works:**
- **Frontend** `AdminDashboard()` (`Home.tsx:275-289`): loads `adminDashboard.summary` (query enabled only if `isStaff()` client-side). Four metric cards (Total users / Pending approval / Payout value / Blocked accounts). "User directory" table with **Approve** (pending only) and **Block/Unblock** (Block hidden only for the first `accountRole === "admin"` row). "Payout management" table (first 25 payouts): Approve (only when `status === "MATCHED"`), Reject, Mark paid. Header: **Export to Excel** (`exportReport`) + **Send test email now** (`sendTestReport`) + "Root admin controls" badge.
- **Backend** (`server/routers.ts:719-760`):

| Endpoint | Procedure | Scoping |
|---|---|---|
| `summary` | `managerProcedure` | Managers: users filtered to TL/tester in own region; payouts region-filtered. HQ/super: global |
| `approveUser` | `managerProcedure` | Manager: target must be in own region (no staff-role check). Sets `accountStatus: "active", isVerified: 1` |
| `reviewPayout` | `managerProcedure` | Manager: payout's testerId/teamLeaderId in region scope. APPROVED requires `status === "MATCHED"` |
| `exportReport` | `superAdminProcedure` | Global, unscoped |
| `exportDailyReport` | `managerProcedure` | Region-scoped via `compileDailyReport(date, scope.regionId)` |
| `sendTestReport` | `superAdminProcedure` | Global report emailed via configured channel |

Note: `exportDailyReport` (region-scoped) is used on the **Daily reporting** page, not on the Admin Dashboard. The Dashboard's Export button calls the super-only `exportReport`.

**Role differences:**
| Role | Sees |
|---|---|
| super_admin | Everything, global; all buttons work |
| hq_admin | Same data as super (global); summary/approve/review work. **Export to Excel and Send test email buttons visible but fail server-side** |
| manager | Only TL/tester in own region (staff hidden); own-region payouts; approve/review work in region. Export/Send-test visible but fail |
| team_leader | Sidebar hides `/admin`; direct URL renders the page (no client gate) → zeros and "No registered users yet". Backend rejects all calls |
| tester | Hard-redirected to `/daily` client-side; FORBIDDEN server-side |

**Issues:**
- **[MEDIUM — UX]** "Export to Excel" and "Send test email now" render for all staff but are super-only — HQ/managers get FORBIDDEN toasts. Fix: hide for non-super, or wire managers to the region-scoped `exportDailyReport`.
- **[LOW]** No client-side role gate (unlike UserDirectory/RegionsPage) — a team_leader visiting directly sees a plausible dashboard of zeros. No data leak (backend enforces).
- **[LOW]** `reviewPayout` allows any status transition (PENDING→PAID skipping APPROVED; APPROVED→PENDING reverting). Only guard: APPROVED requires MATCHED.
- **[LOW]** `approveUser` sets `isVerified: 1` unconditionally — staff approval overrides email OTP by design (manual review), worth stating explicitly.
- **[LOW]** `approveUser` has no staff-account check for managers (unlike updateStatus/updateRole/delete). Edge case: two managers in one region → Manager A could approve Manager B's pending account.

## 4.2 User Directory (`/users`)

**Purpose:** Full account moderation — review verification status, change roles, reassign a tester's team leader, block/unblock, delete accounts, live session presence ("Active now" / last seen).

**How it works:**
- **Frontend** `UserDirectory()` (`Home.tsx:291-302`): explicit client gate (non-staff see "Admin access required" — stale copy says "Category Leader admin account"). Table: User, Verified email/phone, **Role** dropdown ("Admin" shown only if `isHqLevel`; Team Leader/Tester for all), **Team parent** dropdown (region-scoped `roster.list`), Status badge, Active session, Actions (Block/Unblock, Remove — Remove disabled for own row). The frontend never offers `hq_admin`/`manager`/`super_admin` as choices — but the backend accepts them.
- **Backend** `userManagement` (`server/routers.ts:523-581`), all `managerProcedure`:

| Endpoint | Manager scoping |
|---|---|
| `directory` | Only TL/tester rows with `regionId === own region` (staff hidden). HQ/super see everyone. `passwordHash` stripped |
| `updateStatus` | In-region + non-staff only ("You cannot change staff accounts"). Cannot block own session. HQ/super: no target checks |
| `updateRole` | In-region, non-staff, new role must be `team_leader`/`tester`. Cannot remove "admin" from own session. HQ/super: **no restrictions** |
| `delete` | In-region, non-staff, cannot delete self. HQ/super: cannot delete self, **no other restrictions** |

**Role differences:**
| Role | Sees / can do |
|---|---|
| super_admin | All accounts, all regions; full powers except self-delete |
| hq_admin | All accounts, all regions; same powers as super here (backend imposes no target-role checks when scope is null) |
| manager | Only TL/tester in own region; block/unblock, role change **team_leader ⇄ tester only**, reassign team parent, delete. Cannot see/touch staff |
| team_leader | Sidebar hidden; direct URL shows the gate. Backend rejects |
| tester | Hard-redirected client-side; FORBIDDEN server-side |

**Issues:**
- **[HIGH]** hq_admin can demote/block/delete the super_admin — `updateRole`/`updateStatus`/`delete` have zero target-role checks for HQ-level callers. hq_admin can: demote Fahad to tester; block his account (login rejects blocked accounts → owner locked out); delete his account. The frontend "Block" guard (`Home.tsx:284`) only hides for legacy `"admin"` rows, not `"super_admin"`; UserDirectory has no such guard at all. Fix: non-super callers may not touch `super_admin` accounts or assign roles ≥ their own.
- **[MEDIUM]** Self-demote quirk — super_admin cannot set their own role to `super_admin` (only legacy `"admin"`), while hq_admin can demote themselves to legacy `"admin"` and keep HQ access. Guard intent is inverted for the new hierarchy; rewrite as "cannot change own role".
- **[LOW]** "No parent" in Team-parent dropdown does nothing for testers — no way to unassign a team leader from UI.
- **[LOW]** Stale copy: "restricted to the Category Leader admin account".
- **[INFO]** `directory` exposes session `lastSeenAt`/active-now to all staff viewers — acceptable for moderation, flagged for awareness.

## 4.3 Regions & Staff (`/regions`)

**Purpose:** Super-admin-only control plane: list regions with live counts (leaders, testers, assigned manager), view/regenerate invite codes, create regions, create HQ admins, create region managers.

**How it works:**
- **Frontend** `RegionsPage()` (`client/src/pages/Regions.tsx`, 100 lines): client gate `accountRole === "super_admin"` (strict — no legacy owner-email fallback the server honors). Regions table: name, invite code (copy button), leader/tester counts, assigned manager, **"New code"** (confirm → `regions.regenerateInviteCode`). Three creation cards: New region (name + code; code auto-generated), New HQ admin (name/email/mobile/password), New manager (same + region dropdown of ACTIVE regions). Staff table (super/hq/manager) via `staff.list`.
- **Backend** — `regions` router (`routers.ts:581-616`), `staff` router (`routers.ts:617-669`):

| Endpoint | Procedure | Notes |
|---|---|---|
| `regions.list` | `superAdminProcedure` | Counts from roster tables; manager = first `manager` user with matching `regionId` |
| `regions.create` | `superAdminProcedure` | Code uniqueness checked case-insensitively; **name uniqueness not checked**. Code ≈ 30 bits entropy |
| `regions.regenerateInviteCode` | `superAdminProcedure` | New random code; old code stops immediately (no grace period); audit-logged |
| `regions.toggleStatus` | `superAdminProcedure` | **No UI anywhere** — regions can't be deactivated from frontend |
| `staff.list` | `hqAdminProcedure` | Returns super/hq/manager accounts, passwordHash stripped |
| `staff.createHqAdmin` | `superAdminProcedure` | Active, verified `hq_admin`, `regionId: null`; duplicate email/phone rejected; password min 8, scrypt-hashed |
| `staff.createManager` | `hqAdminProcedure` | Active, verified `manager` bound to an ACTIVE region. **Doesn't check whether the region already has a manager** |

**Role differences:**
| Role | Access |
|---|---|
| super_admin | Full page: regions, codes, create HQ admins/managers, staff table |
| hq_admin | **No UI at all** — sidebar hides `/regions`, page gates on strict `super_admin`. Yet backend allows HQ to call `staff.createManager` and `staff.list` (form copy says "HQ admins can also create managers"). Via API only, and they can't list regions to discover `regionId`s |
| manager | No access (client + server) |
| team_leader / tester | No access; sidebar hidden, page gate, FORBIDDEN / hard redirect |

**Issues:**
- **[MEDIUM]** "HQ admins can also create managers" is not true in the UI — the only form is on the super-only page. Give HQ a UI (e.g. on `/users`) or fix the copy.
- **[LOW]** Duplicate managers per region possible — `regions.list` shows only the first; both would have full region powers.
- **[LOW]** Region name duplicates possible (code uniqueness only).
- **[LOW]** No deactivate UI (`toggleStatus` exists server-side only); a leaked invite code can only be mitigated by regenerating (disrupts in-flight registrations).
- **[LOW]** Client/server role-check mismatch — page uses strict `super_admin`, server honors legacy owner-email fallback too.
- **[INFO]** Invite codes: 30-bit random suffix + ACTIVE-region check + mandatory Gmail OTP make brute force impractical. Regeneration invalidates immediately — mid-registration users with the old code must restart.

---

# PART 5 — Automation & Whitenoise (super-admin only)

## 5.1 Automation (`/automation`)

**Purpose:** Super-admin control panel for the daily automated Excel report: schedule display, SMTP email configuration, pause/resume toggle, manual "run now", delivery status.

**How it works:**
- **Daily report schedule card:** "Daily auto-report emails" checkbox → `settings.update({ autoReportEnabled })` (instant). Report time + timezone + admin email → `settings.update` on submit. The card warns that changing the time requires a `vercel.json` cron edit + redeploy.
- **SMTP card:** host, port, username, password, from-address, SSL → `settings.update`. Password never pre-filled (backend strips `smtpPass` from `settings.get`, routers.ts:1162); client clears the field after save and only sends `smtpPass` when non-empty.
- **Run report now:** date picker → `settings.runReportNow({ date })` — compiles workbook server-side, emails it, returns base64 for immediate download, updates "Last auto-report".
- **Delivery status:** `settings.deliveryStatus` → recipient, SMTP/Resend badges, last-run time. Never exposes the password.
- **Backend** (`routers.ts:1157-1207`): `settings.get` / `settings.update` (zod-validated: HH:MM regex, port 1–65535, smtpPass max 500) / `settings.deliveryStatus` / `settings.runReportNow` — all `superAdminProcedure`. Update audit log masks password as `"***"`.
- **22:30 PKT cron flow (verified):** `vercel.json` cron `30 17 * * *` (17:30 UTC) → `/api/scheduled/dailyReport` → `scheduledDailyReport` (bearer `REPORT_CRON_SECRET`/`CRON_SECRET`, else authenticated-session fallback) → if `autoReportEnabled === 0` returns `{ ok: true, skipped: true }` (pause works, cron stays alive) → **drift guard** (skips if >90 min from configured time) → `deliverDailyReport` — channel priority: SMTP → Resend → owner in-app notification → `unconfigured` → **per-region fan-out**: each ACTIVE region's manager gets a region-scoped Excel; every active super/hq admin with email gets the global Excel (primary recipient skipped to avoid dupes) → `lastAutoReport` updated.

**Role differences:** Sidebar hidden unless super_admin (`superOnly`, DashboardLayout.tsx:71). Route map has no guard, but the component shows an amber "Super admin access required" card for non-super (Home.tsx:312). All 4 backend endpoints are `superAdminProcedure` — hq_admin/manager/team_leader get FORBIDDEN. Testers are force-redirected to `/daily` before ever seeing it.

**Issues:**
- **[MEDIUM]** The cron endpoint's session fallback (`scheduledReports.ts:121-128`) allows **hq_admin** to trigger the full report generation and email blast to all region managers, while the equivalent `runReportNow` is strictly super-only. An hq_admin who knows the URL bypasses the restriction. Fix: restrict fallback to super_admin.
- **[LOW-MEDIUM]** React hooks-after-early-return (`Home.tsx:310-318`): `deliveryStatus` query, `useUtils`, `useState`s, `useEffect` all come after `if (!isSuperAdmin(...)) return`. Violates rules of hooks — a session race/role change throws "Rendered more hooks than during the previous render." Move the guard below all hooks.
- **[Minor]** `compileDailyReport()` runs before the `autoReportEnabled` check — wasted compute on every paused cron tick.
- **[Minor]** `runReportNow` updates `lastAutoReport`, conflating manual runs with the scheduled 22:30 run.
- **[Minor]** Client `isSuperAdmin` is strictly `role === "super_admin"` but server has a legacy owner-email fallback — a legacy-`admin` owner would be denied the page while the API allows.

## 5.2 Whitenoise OTP (`/whitenoise/otp`), App Usage (`/whitenoise/apps`), Tester Totals (`/whitenoise/totals`)

**Purpose:** Verify tester OTP output against the third-party `whitenoise.one` SMS gateway: per-number OTP counts with app breakdown, aggregate app usage, per-tester totals — each downloadable as Excel.

**How it works (all three pages share `useWhitenoiseCheck`):**
- `CredentialsCard` (all 3 pages): saves whitenoise.one email+password via `whitenoise.saveCredentials`; badge shows configured email or "Not configured" via `whitenoise.getConfig`.
- `CheckControls`: (a) **Tester roster** — upload Excel with `Tester | Team Leader | Number` columns (header-matched, positional fallback), optionally "Save for reuse" via `whitenoise.saveRoster` (max 2000 rows); (b) **date range**; (c) **SMS source** — "Auto-fetch from Whitenoise" or manual SMS-log Excel upload (fallback parsed by `parseManualSmsLog`).
- Run → `whitenoise.check({ dateFrom, dateTo, roster?, manualSmsRows?, useAutoFetch })` (max 20000 SMS rows).
- Results: `/otp` → per-number table (Tester, Team Leader, Number, Total OTP, Applications) + 2-sheet Excel; `/apps` → Application × OTP count + 1-sheet Excel; `/totals` → Tester × Team Leader × Total OTP + 1-sheet Excel. Excel generation is client-side.
- **Backend** (`routers.ts:670-717`): `getConfig`, `saveCredentials`, `getRoster`, `saveRoster`, `check` — all `superAdminProcedure`. `check` requires a roster, prefers uploaded `manualSmsRows`, else auto-fetches with saved credentials.
- **Scraping** (`server/whitenoise.ts`): no API exists, so the server does form-login over HTTP (primes `APPSID` cookie, POSTs credentials, verifies via `/sms` + `/user/logout` check). Date ranges map to `YYYY-MM-DD.00.00` / `.23.59`. Per-number queries run with 5 concurrent workers; whole-range mode paginates (cap 200 pages). Records deduped by `destination|timeReceived|text`. `analyzeOtp` matches SMS to roster by digits-only normalized number.

**Role differences:** Sidebar group hidden unless super_admin (DashboardLayout.tsx:74-80). **Route map has no guard and the components have no role guard** — hq_admin/manager/team_leader visiting `/whitenoise/*` directly see the full UI (credentials form, upload, buttons); every tRPC call returns FORBIDDEN → toast errors, misleading "Not configured" badge, empty tables. No data leaks, but confusing UX; the `CredentialsCard` copy ("only admins can see this page") is factually wrong. Testers are force-redirected to `/daily`.

**Issues:**
- **[Security — Medium-High, confirms known issue]** Credentials stored **plaintext in Firestore `whitenoise_config/1`** (`server/whitenoise.ts:52-60`); `getWhitenoiseConfig` reads back the plaintext password (needed for login). Same pattern for SMTP `smtpPass` in `appSettings/1` (`server/db.ts:1017-1028`). Mitigations: `firestore.rules` is deny-all direct client; endpoints strip passwords. But anyone with Firebase console/service-account access can read both. Belongs in Secret Manager / env vars.
- **[Access control — Medium]** No client-side role guard on Whitenoise pages (unlike Automation's denial card). Add the same `isSuperAdmin` early-return.
- **[Data correctness — Medium]** Per-number queries don't paginate — `fetchWhitenoiseSms` (whitenoise.ts:220-231) fetches only page 1 per number; pagination exists only in the whole-range branch. A number with >1 page of SMS in range is **silently undercounted**.
- **[Known flakiness]** No retry/backoff on login or page fetches; transient failure fails the whole `check`. Manual SMS-log upload is the reliability backstop.
- **[Caveat]** `appUsage` aggregates all fetched SMS, not just roster-matched — fine in practice (per-number `sms_to` queries), but partial-match filters could inflate totals.

**No whitenoise data leaks across roles found:** all 5 endpoints are `superAdminProcedure`; roster is a single global doc (no per-region scoping needed — only super admin can reach it); frontend Excel exports are built from authorized query results.

---

# APPENDIX — Consolidated Issue Tracker

| # | Severity | Module | Issue | Location |
|---|---|---|---|---|
| 1 | HIGH | User Directory | hq_admin can demote/block/delete super_admin | routers.ts:533-581 |
| 2 | HIGH | AI Assistant | Manager assistant not region-scoped (cross-region read+write) | routers.ts:1213+ |
| 3 | HIGH | AI Assistant | LLM layer has zero role scoping; tester can write others' OTP via API | routers.ts:~1290-1315 |
| 4 | HIGH | Payouts | `importText` open to any authenticated user (incl. testers) | routers.ts:1065 |
| 5 | HIGH | Payouts | Imported payouts never get `reviewStatus` — review workflow broken | routers.ts:1065-1081 |
| 6 | HIGH | Payouts | Testers receive full payout amounts (`payouts.list`, `overview`) | routers.ts:1030-1041, 776 |
| 7 | HIGH | Auth | Owner-email string grants super_admin in public register endpoint | routers.ts:405 |
| 8 | MEDIUM | Profile | Cross-region team-leader change; regionId desync | routers.ts:~322 |
| 9 | MEDIUM | Profile | Validation contradicts registration rules (email/phone/name) | routers.ts:~309 |
| 10 | MEDIUM | Profile | Every save grants 1-year session | routers.ts:~334 |
| 11 | MEDIUM | Profile | Account-only leader bug persists on profile path | routers.ts:~322 |
| 12 | MEDIUM | Automation | Cron session fallback allows hq_admin to trigger email blast | scheduledReports.ts:121-128 |
| 13 | MEDIUM | Whitenoise | Plaintext credentials in Firestore (`whitenoise_config/1`); SMTP same | whitenoise.ts:52-60, db.ts:1017 |
| 14 | MEDIUM | Payouts | Unmatched exceptions invisible to region managers | routers.ts:1030, 770 |
| 15 | MEDIUM | Payouts | Amount misparsing (phone numbers as amounts) | routers.ts:1074 |
| 16 | MEDIUM | Targets | `targets.list` has no region filtering | routers.ts:1084 |
| 17 | MEDIUM | Roster | HQ cannot create leaders outside Central A (silent fallback) | routers.ts:809-815 |
| 18 | MEDIUM | Multiple | Name-based user→roster linkage breaks silently on rename | routers.ts:772-775 etc. |
| 19 | MEDIUM | Daily | "120/120" shorthand broken (`Number(quantity)`) | Home.tsx:181 |
| 20 | MEDIUM | Daily | Export button visible to TL/testers, backend manager-only | Home.tsx:181 |
| 21 | MEDIUM | Audit | Managers can't see most region activity; TLs see misleading empty state | routers.ts:1139 |
| 22 | MEDIUM | Assistant | Prompt injection via `role: "system"` in client history | routers.ts:~1240 |
| 23 | MEDIUM | Assistant | Junk-tester auto-creation from loose name regex | aiAssistant.ts |
| 24 | MEDIUM | Profile | No pending-payout guard on self-delete | db.ts:414 |
| 25 | MEDIUM | Roster | Delete buttons lack confirmation despite cascade deletes | Home.tsx:258 |
| 26 | MEDIUM | Admin | Export/Send-test buttons visible to HQ/managers but fail | Home.tsx:278 |
| 27 | MEDIUM | Regions | HQ "can create managers" has no UI | Regions.tsx:66 |
| 28 | LOW-MED | Automation | Hooks-after-early-return React bug | Home.tsx:310-318 |
| 29 | LOW-MED | Whitenoise | No client role guard (confusing FORBIDDEN toasts) | Whitenoise pages |
| 30 | LOW-MED | Whitenoise | Per-number queries don't paginate (silent undercount) | whitenoise.ts:220-231 |
| 31 | LOW-MED | Targets | Team leaders can create company-wide targets | routers.ts:1091-1098 |
| 32 | LOW-MED | Targets | Write-only module — nothing consumes targets | — |
| 33 | LOW | Multiple | 200-record caps with no notice (history, team history) | db.ts:777 |
| 34 | LOW | Audit | In-memory filter after 100-log cap; UI omits actor/old/new values | routers.ts:1139 |
| 35 | LOW | Roster | `addOwnTester` never sets `regionId` | routers.ts:867-882 |
| 36 | LOW | Roster | Silent cross-region move for HQ on name-match reassign | routers.ts:820-828 |
| 37 | LOW | Roster | `moveTester` has no UI | — |
| 38 | LOW | Admin | `reviewPayout` allows any status transition | routers.ts:751 |
| 39 | LOW | Payouts | No input size cap on import; exact-line-only dedup | routers.ts:1065 |
| 40 | LOW | Regions | Duplicate managers/region names possible; no deactivate UI | routers.ts:592-646 |

## What's working well

- **Region filtering is genuinely enforced** on the backend for dashboard, roster, payouts (list/update/delete/review), team history, user directory, admin summary, daily export, and performance creation — verified endpoint by endpoint, not assumed.
- **Automation/Whitenoise backend lockdown is solid** — all 9 endpoints are `superAdminProcedure`; SMTP/whitenoise passwords are stripped from read responses; audit log masks secrets.
- **Testers can't reach staff pages via UI**, and every staff backend endpoint re-checks procedures — no endpoint was found relying on client checks alone (except the flagged assistant/profile/payout-import cases).
- **The 22:30 PKT cron flow is correct**: pause toggle, drift guard, per-region fan-out, channel priority (SMTP → Resend → in-app).
- **Registration hardening is consistent**: invite codes, Gmail-only, Pakistani mobile, 3–20 char names, email OTP — though Profile settings doesn't mirror these rules (issue #9).
