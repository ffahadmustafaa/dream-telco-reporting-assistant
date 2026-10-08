import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { loadXlsx } from "@/lib/xlsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Download, Loader2, Upload } from "lucide-react";

const today = new Date().toISOString().slice(0, 10);

type RosterRow = { tester: string; teamLeader: string; number: string };

function SectionHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <div className="mb-7"><p className="text-xs font-extrabold uppercase tracking-[.18em] text-[#13897f]">{eyebrow}</p><h1 className="mt-2 text-2xl font-extrabold tracking-[-.035em] text-[#10233f] sm:text-3xl">{title}</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">{description}</p></div>;
}

/** Parse pasted roster text: one entry per line.
 * Accepted formats per line:
 *   03001234567
 *   Ali, 03001234567
 *   Ali | 03001234567 | Rabia
 * Lines without a recognizable phone number are skipped. */
function parseRosterText(text: string): RosterRow[] {
  const rows: RosterRow[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/[,|\t]/).map(p => p.trim()).filter(Boolean);
    // Find the phone number: the part with the most digits
    let numberIdx = -1;
    let maxDigits = 0;
    parts.forEach((part, i) => {
      const digits = part.replace(/\D/g, "");
      if (digits.length >= 7 && digits.length > maxDigits) {
        maxDigits = digits.length;
        numberIdx = i;
      }
    });
    if (numberIdx < 0) continue;
    const number = parts[numberIdx] ?? "";
    const tester = parts.find((_, i) => i !== numberIdx && !/^\+?\d[\d\s-]*$/.test(parts[i] ?? "")) ?? number;
    const teamLeader = parts.filter((_, i) => i !== numberIdx && parts[i] !== tester).find(p => !/^\+?\d[\d\s-]*$/.test(p)) ?? "";
    rows.push({ tester, teamLeader, number });
  }
  return rows;
}

/** Parse an uploaded roster Excel: expects Tester | Team Leader | Number columns (any order, header matched). */
async function parseRosterFile(file: File): Promise<RosterRow[]> {
  const XLSX = await loadXlsx();
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0] ?? ""];
  if (!sheet) throw new Error("The file has no readable sheet");
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 }) as unknown[][];
  if (rows.length < 2) throw new Error("The file needs a header row plus at least one data row");
  const header = (rows[0] ?? []).map(c => String(c ?? "").toLowerCase());
  const findIdx = (...names: string[]) => header.findIndex(h => names.some(n => h.includes(n)));
  let testerIdx = findIdx("tester", "name");
  let leaderIdx = findIdx("team leader", "leader", "tl");
  let numberIdx = findIdx("number", "phone", "mobile", "contact");
  if (testerIdx < 0 || numberIdx < 0) {
    // Positional fallback: Tester | Team Leader | Number
    testerIdx = 0; leaderIdx = 1; numberIdx = 2;
  }
  if (leaderIdx < 0) leaderIdx = 1;
  return (rows.slice(1) as unknown[][])
    .filter(r => String(r[numberIdx] ?? "").trim() && String(r[testerIdx] ?? "").trim())
    .map(r => ({
      tester: String(r[testerIdx] ?? "").trim(),
      teamLeader: String(r[leaderIdx] ?? "").trim(),
      number: String(r[numberIdx] ?? "").trim(),
    }));
}

/** Parse a manually uploaded SMS log Excel into string rows. */
async function parseSmsFile(file: File): Promise<string[][]> {
  const XLSX = await loadXlsx();
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0] ?? ""];
  if (!sheet) throw new Error("The file has no readable sheet");
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 }) as unknown[][];
  return rows.map(r => (r as unknown[]).map(c => String(c ?? "")));
}

async function downloadExcel(sheets: Record<string, Array<Record<string, unknown>>>, fileName: string) {
  const XLSX = await loadXlsx();
  const workbook = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows.length ? rows : [{ Note: "No data" }]), name.slice(0, 31));
  }
  XLSX.writeFile(workbook, fileName, { cellStyles: true } as object);
}

function CredentialsCard() {
  const config = trpc.whitenoise.getConfig.useQuery();
  const save = trpc.whitenoise.saveCredentials.useMutation({
    onSuccess: () => { config.refetch(); toast.success("Whitenoise credentials saved"); },
    onError: error => toast.error(error.message),
  });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  return <Card className="border-slate-200 shadow-none"><CardHeader><CardTitle className="text-base">Whitenoise login</CardTitle><p className="text-xs text-slate-500">Used for automatic OTP fetching. Stored on the server — only admins can see this page.</p></CardHeader><CardContent className="space-y-4">
    <div className="flex items-center gap-2 text-xs">
      <Badge className={config.data?.hasPassword ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}>{config.data?.hasPassword ? `Configured (${config.data.email ?? ""})` : "Not configured"}</Badge>
    </div>
    <div className="grid gap-4 sm:grid-cols-2">
      <div><Label className="text-xs">Email</Label><Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="whitenoise account email" className="mt-1.5" /></div>
      <div><Label className="text-xs">Password</Label><Input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="whitenoise password" className="mt-1.5" /></div>
    </div>
    <Button disabled={!email.trim() || !password || save.isPending} onClick={() => save.mutate({ email: email.trim(), password })} className="bg-slate-950 hover:bg-slate-800">{save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save credentials"}</Button>
  </CardContent></Card>;
}

type CheckResult = {
  perNumber: Array<{ tester: string; teamLeader: string; number: string; total: number; byApp: Array<{ app: string; count: number }> }>;
  appUsage: Array<{ app: string; count: number }>;
  testerTotals: Array<{ tester: string; teamLeader: string; total: number }>;
  smsCount: number;
  source: "whitenoise" | "manual";
  dateFrom: string;
  dateTo: string;
};

function useWhitenoiseCheck() {
  const config = trpc.whitenoise.getConfig.useQuery();
  const saveRoster = trpc.whitenoise.saveRoster.useMutation();
  const check = trpc.whitenoise.check.useMutation();
  const [dateFrom, setDateFrom] = useState(today);
  const [dateTo, setDateTo] = useState(today);
  const [roster, setRoster] = useState<RosterRow[] | null>(null);
  const [useSavedRoster, setUseSavedRoster] = useState(true);
  const [pastedText, setPastedText] = useState("");
  const [manualSms, setManualSms] = useState<string[][] | null>(null);
  const [useAutoFetch, setUseAutoFetch] = useState(true);

  const handleRosterFile = async (file: File) => {
    try {
      const rows = await parseRosterFile(file);
      setRoster(rows);
      setPastedText("");
      setUseSavedRoster(false);
      toast.success(`${rows.length} tester numbers loaded from file`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not read the roster file");
    }
  };

  const handlePastedText = (text: string) => {
    setPastedText(text);
    const rows = parseRosterText(text);
    if (rows.length > 0) {
      setRoster(rows);
      setUseSavedRoster(false);
    } else if (!text.trim()) {
      setRoster(null);
    }
  };

  const handleSmsFile = async (file: File) => {
    try {
      const rows = await parseSmsFile(file);
      setManualSms(rows);
      setUseAutoFetch(false);
      toast.success(`${Math.max(0, rows.length - 1)} SMS rows loaded (manual mode)`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not read the SMS file");
    }
  };

  const persistRoster = async () => {
    if (!roster?.length) return;
    try {
      const result = await saveRoster.mutateAsync({ rows: roster });
      config.refetch();
      toast.success(`${result.saved} numbers saved for reuse`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the roster");
    }
  };

  const run = async (): Promise<CheckResult | null> => {
    try {
      const result = await check.mutateAsync({
        dateFrom,
        dateTo,
        roster: !useSavedRoster && roster ? roster : undefined,
        manualSmsRows: !useAutoFetch && manualSms ? manualSms : undefined,
        useAutoFetch,
      });
      toast.success(`Checked via ${result.source === "whitenoise" ? "Whitenoise" : "uploaded SMS log"} — ${result.smsCount} SMS records`);
      return result as CheckResult;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The check failed");
      return null;
    }
  };

  return {
    config, dateFrom, setDateFrom, dateTo, setDateTo,
    roster, useSavedRoster, setUseSavedRoster, handleRosterFile, persistRoster,
    pastedText, handlePastedText,
    manualSms, useAutoFetch, setUseAutoFetch, handleSmsFile,
    run, isPending: check.isPending,
  };
}

function CheckControls({ ctl }: { ctl: ReturnType<typeof useWhitenoiseCheck> }) {
  return <Card className="border-slate-200 shadow-none"><CardHeader><CardTitle className="text-base">Check setup</CardTitle></CardHeader><CardContent className="space-y-5">
    <div>
      <Label className="text-xs font-semibold">Tester roster</Label>
      <p className="mt-1 text-xs text-slate-500">Excel with Tester | Team Leader | Number columns. {ctl.config.data ? `${ctl.config.data.rosterCount} numbers saved.` : ""}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-2.5 text-xs font-medium text-slate-600 hover:border-emerald-300 hover:bg-emerald-50">
          <Upload className="h-4 w-4" />Upload roster Excel<input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) void ctl.handleRosterFile(f); }} />
        </label>
        {ctl.roster && !ctl.useSavedRoster && <>
          <Badge className="bg-emerald-50 text-emerald-700">{ctl.roster.length} from file</Badge>
          <Button size="sm" variant="outline" onClick={() => void ctl.persistRoster()}>Save for reuse</Button>
        </>}
        {(ctl.config.data?.rosterCount ?? 0) > 0 && <Button size="sm" variant={ctl.useSavedRoster ? "default" : "outline"} onClick={() => ctl.setUseSavedRoster(true)}>Use saved ({ctl.config.data?.rosterCount})</Button>}
      </div>
      <div className="mt-3">
        <Label className="text-xs text-slate-500">Or paste numbers directly (one per line)</Label>
        <textarea
          value={ctl.pastedText}
          onChange={e => ctl.handlePastedText(e.target.value)}
          placeholder={"03001234567\nAli, 03007654321\nSara | 03009876543 | Rabia"}
          rows={3}
          className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 placeholder:text-slate-400 focus:border-emerald-400 focus:outline-none"
        />
        {ctl.pastedText.trim() && ctl.roster && !ctl.useSavedRoster && (
          <p className="mt-1 text-xs text-emerald-700">{ctl.roster.length} numbers ready from pasted text.</p>
        )}
      </div>
    </div>
    <div className="grid gap-4 sm:grid-cols-2">
      <div><Label className="text-xs">From date</Label><Input type="date" value={ctl.dateFrom} onChange={e => ctl.setDateFrom(e.target.value)} className="mt-1.5" /></div>
      <div><Label className="text-xs">To date</Label><Input type="date" value={ctl.dateTo} onChange={e => ctl.setDateTo(e.target.value)} className="mt-1.5" /></div>
    </div>
    <div>
      <Label className="text-xs font-semibold">SMS data source</Label>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant={ctl.useAutoFetch ? "default" : "outline"} onClick={() => ctl.setUseAutoFetch(true)}>Auto-fetch from Whitenoise</Button>
        <label className={`flex cursor-pointer items-center gap-2 rounded-xl border px-4 py-2 text-xs font-medium ${!ctl.useAutoFetch ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 text-slate-600 hover:border-slate-400"}`}>
          <Upload className="h-3.5 w-3.5" />Upload SMS log instead<input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) void ctl.handleSmsFile(f); }} />
        </label>
      </div>
      {!ctl.useAutoFetch && ctl.manualSms && <p className="mt-2 text-xs text-slate-500">{Math.max(0, ctl.manualSms.length - 1)} SMS rows ready (manual mode).</p>}
      {ctl.useAutoFetch && !ctl.config.data?.hasPassword && <p className="mt-2 text-xs text-amber-700">Whitenoise credentials are not configured yet — save them above or upload the SMS log manually.</p>}
    </div>
  </CardContent></Card>;
}

export function WhitenoiseOtp() {
  const ctl = useWhitenoiseCheck();
  const [result, setResult] = useState<CheckResult | null>(null);
  const download = () => {
    if (!result) return;
    void downloadExcel({
      "OTP per number": result.perNumber.map(r => ({
        Tester: r.tester, "Team Leader": r.teamLeader, Number: r.number, "Total OTP": r.total,
        "App breakdown": r.byApp.map(a => `${a.app} x${a.count}`).join(", ") || "—",
      })),
      "App details": result.perNumber.flatMap(r => r.byApp.map(a => ({ Tester: r.tester, "Team Leader": r.teamLeader, Number: r.number, Application: a.app, Count: a.count }))),
    }, `Whitenoise_OTP_${result.dateFrom}_to_${result.dateTo}.xlsx`);
  };
  return <div className="space-y-6">
    <SectionHeading eyebrow="Whitenoise" title="OTP per number" description="Check OTP counts on each tester number with the application breakdown." />
    <CredentialsCard />
    <CheckControls ctl={ctl} />
    <div className="flex gap-3">
      <Button disabled={ctl.isPending} onClick={() => void ctl.run().then(setResult)} className="bg-emerald-600 hover:bg-emerald-700">{ctl.isPending ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Checking…</> : "Check OTP"}</Button>
      {result && <Button variant="outline" onClick={download} className="gap-2"><Download className="h-4 w-4" />Download Excel</Button>}
    </div>
    {result && <Card className="border-slate-200 shadow-none"><CardHeader className="flex-row items-center justify-between space-y-0"><div><CardTitle className="text-base">Results</CardTitle><p className="text-xs text-slate-500">{result.smsCount} SMS via {result.source} · {result.dateFrom} → {result.dateTo}</p></div></CardHeader><CardContent className="p-0"><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-y border-slate-100 bg-slate-50/70 text-[11px] uppercase tracking-wider text-slate-400"><tr><th className="px-6 py-3">Tester</th><th className="px-6 py-3">Team Leader</th><th className="px-6 py-3">Number</th><th className="px-6 py-3 text-right">Total OTP</th><th className="px-6 py-3">Applications</th></tr></thead><tbody className="divide-y divide-slate-100">{result.perNumber.map((r, i) => <tr key={i} className="hover:bg-slate-50/70"><td className="px-6 py-3.5 font-medium text-slate-800">{r.tester}</td><td className="px-6 py-3.5 text-slate-500">{r.teamLeader || "—"}</td><td className="px-6 py-3.5 text-slate-500">{r.number}</td><td className="px-6 py-3.5 text-right font-bold text-slate-900">{r.total}</td><td className="px-6 py-3.5 text-xs text-slate-500">{r.byApp.map(a => `${a.app} x${a.count}`).join(", ") || "—"}</td></tr>)}</tbody></table></div></CardContent></Card>}
  </div>;
}

export function WhitenoiseApps() {
  const ctl = useWhitenoiseCheck();
  const [result, setResult] = useState<CheckResult | null>(null);
  const download = () => {
    if (!result) return;
    void downloadExcel({
      "App usage": result.appUsage.map(a => ({ Application: a.app, "OTP count": a.count })),
    }, `Whitenoise_Apps_${result.dateFrom}_to_${result.dateTo}.xlsx`);
  };
  return <div className="space-y-6">
    <SectionHeading eyebrow="Whitenoise" title="Application usage" description="Total OTP counts grouped by application." />
    <CredentialsCard />
    <CheckControls ctl={ctl} />
    <div className="flex gap-3">
      <Button disabled={ctl.isPending} onClick={() => void ctl.run().then(setResult)} className="bg-emerald-600 hover:bg-emerald-700">{ctl.isPending ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Loading…</> : "Load app usage"}</Button>
      {result && <Button variant="outline" onClick={download} className="gap-2"><Download className="h-4 w-4" />Download Excel</Button>}
    </div>
    {result && <Card className="border-slate-200 shadow-none"><CardHeader><div><CardTitle className="text-base">Results</CardTitle><p className="text-xs text-slate-500">{result.smsCount} SMS via {result.source} · {result.dateFrom} → {result.dateTo}</p></div></CardHeader><CardContent className="p-0"><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-y border-slate-100 bg-slate-50/70 text-[11px] uppercase tracking-wider text-slate-400"><tr><th className="px-6 py-3">Application</th><th className="px-6 py-3 text-right">OTP count</th></tr></thead><tbody className="divide-y divide-slate-100">{result.appUsage.map((a, i) => <tr key={i} className="hover:bg-slate-50/70"><td className="px-6 py-3.5 font-medium text-slate-800">{a.app}</td><td className="px-6 py-3.5 text-right font-bold text-slate-900">{a.count}</td></tr>)}{!result.appUsage.length && <tr><td colSpan={2} className="px-6 py-16 text-center text-sm text-slate-400">No application data for this range.</td></tr>}</tbody></table></div></CardContent></Card>}
  </div>;
}

export function WhitenoiseTotals() {
  const ctl = useWhitenoiseCheck();
  const [result, setResult] = useState<CheckResult | null>(null);
  const download = () => {
    if (!result) return;
    void downloadExcel({
      "Tester totals": result.testerTotals.map(t => ({ Tester: t.tester, "Team Leader": t.teamLeader, "Total OTP": t.total })),
    }, `Whitenoise_Totals_${result.dateFrom}_to_${result.dateTo}.xlsx`);
  };
  return <div className="space-y-6">
    <SectionHeading eyebrow="Whitenoise" title="Tester totals" description="Simple per-tester OTP totals with team leader names." />
    <CredentialsCard />
    <CheckControls ctl={ctl} />
    <div className="flex gap-3">
      <Button disabled={ctl.isPending} onClick={() => void ctl.run().then(setResult)} className="bg-emerald-600 hover:bg-emerald-700">{ctl.isPending ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Checking…</> : "Check totals"}</Button>
      {result && <Button variant="outline" onClick={download} className="gap-2"><Download className="h-4 w-4" />Download Excel</Button>}
    </div>
    {result && <Card className="border-slate-200 shadow-none"><CardHeader><div><CardTitle className="text-base">Results</CardTitle><p className="text-xs text-slate-500">{result.smsCount} SMS via {result.source} · {result.dateFrom} → {result.dateTo}</p></div></CardHeader><CardContent className="p-0"><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-y border-slate-100 bg-slate-50/70 text-[11px] uppercase tracking-wider text-slate-400"><tr><th className="px-6 py-3">Tester</th><th className="px-6 py-3">Team Leader</th><th className="px-6 py-3 text-right">Total OTP</th></tr></thead><tbody className="divide-y divide-slate-100">{result.testerTotals.map((t, i) => <tr key={i} className="hover:bg-slate-50/70"><td className="px-6 py-3.5 font-medium text-slate-800">{t.tester}</td><td className="px-6 py-3.5 text-slate-500">{t.teamLeader || "—"}</td><td className="px-6 py-3.5 text-right font-bold text-slate-900">{t.total}</td></tr>)}</tbody></table></div></CardContent></Card>}
  </div>;
}
