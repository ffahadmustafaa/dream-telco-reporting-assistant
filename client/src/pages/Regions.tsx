import { useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Copy, Loader2, Plus, RefreshCw } from "lucide-react";

function SectionHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <div className="mb-7"><p className="text-xs font-extrabold uppercase tracking-[.18em] text-[#13897f]">{eyebrow}</p><h1 className="mt-2 text-2xl font-extrabold tracking-[-.035em] text-[#10233f] sm:text-3xl">{title}</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">{description}</p></div>;
}

export function RegionsPage() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const isSuper = user?.accountRole === "super_admin";
  const regions = trpc.regions.list.useQuery(undefined, { enabled: isSuper });
  const staff = trpc.staff.list.useQuery(undefined, { enabled: isSuper || user?.accountRole === "hq_admin" });

  const [newRegion, setNewRegion] = useState({ name: "", code: "" });
  const [hqForm, setHqForm] = useState({ name: "", email: "", phoneNumber: "+92", password: "" });
  const [mgrForm, setMgrForm] = useState({ name: "", email: "", phoneNumber: "+92", password: "", regionId: "" });

  const createRegion = trpc.regions.create.useMutation({
    onSuccess: () => { setNewRegion({ name: "", code: "" }); utils.regions.list.invalidate(); toast.success("Region created"); },
    onError: e => toast.error(e.message),
  });
  const regenCode = trpc.regions.regenerateInviteCode.useMutation({
    onSuccess: r => { utils.regions.list.invalidate(); toast.success(`New invite code: ${r.inviteCode}`); },
    onError: e => toast.error(e.message),
  });
  const createHq = trpc.staff.createHqAdmin.useMutation({
    onSuccess: () => { setHqForm({ name: "", email: "", phoneNumber: "+92", password: "" }); utils.staff.list.invalidate(); toast.success("HQ admin account created"); },
    onError: e => toast.error(e.message),
  });
  const createMgr = trpc.staff.createManager.useMutation({
    onSuccess: () => { setMgrForm({ name: "", email: "", phoneNumber: "+92", password: "", regionId: "" }); utils.staff.list.invalidate(); utils.regions.list.invalidate(); toast.success("Manager account created"); },
    onError: e => toast.error(e.message),
  });

  if (!isSuper) return <Card className="border-amber-200 bg-amber-50"><CardContent className="p-8"><h1 className="font-display text-2xl font-semibold text-amber-950">Super admin only</h1><p className="mt-2 text-sm text-amber-800">Region management is restricted to the super admin.</p></CardContent></Card>;

  const copyCode = (code: string) => { void navigator.clipboard.writeText(code); toast.success("Invite code copied"); };

  return <div className="space-y-8">
    <SectionHeading eyebrow="Administration" title="Regions & staff" description="Manage regions, invite codes, HQ admins and region managers." />

    <Card className="border-slate-200 shadow-none">
      <CardHeader><CardTitle className="text-base">Regions</CardTitle><p className="text-xs text-slate-500">Invite codes assign new testers and team leaders to a region at registration.</p></CardHeader>
      <CardContent className="p-0"><div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm">
        <thead className="border-y border-slate-100 bg-slate-50/70 text-[11px] uppercase tracking-wider text-slate-400"><tr><th className="px-6 py-3">Region</th><th className="px-6 py-3">Invite code</th><th className="px-6 py-3 text-right">Leaders</th><th className="px-6 py-3 text-right">Testers</th><th className="px-6 py-3">Manager</th><th className="px-6 py-3 text-right">Actions</th></tr></thead>
        <tbody className="divide-y divide-slate-100">{(regions.data ?? []).map(r => <tr key={r.id} className="hover:bg-slate-50/70">
          <td className="px-6 py-4"><p className="font-semibold text-slate-800">{r.name}</p><p className="text-[11px] text-slate-400">Code {r.code} · <Badge variant="outline" className="text-[10px]">{r.status}</Badge></p></td>
          <td className="px-6 py-4"><div className="flex items-center gap-2"><code className="rounded-lg bg-slate-100 px-2.5 py-1.5 font-mono text-xs font-bold tracking-wider text-slate-800">{r.inviteCode}</code><button className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={() => copyCode(r.inviteCode)} title="Copy invite code"><Copy className="h-3.5 w-3.5" /></button></div></td>
          <td className="px-6 py-4 text-right font-semibold">{r.teamLeaderCount}</td>
          <td className="px-6 py-4 text-right font-semibold">{r.testerCount}</td>
          <td className="px-6 py-4 text-xs text-slate-600">{r.manager ? <><p className="font-medium text-slate-800">{r.manager.name}</p><p className="text-slate-400">{r.manager.email}</p></> : <span className="text-slate-400">No manager</span>}</td>
          <td className="px-6 py-4"><div className="flex justify-end"><Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" disabled={regenCode.isPending} onClick={() => { if (window.confirm(`Regenerate invite code for ${r.name}? Old codes will stop working.`)) regenCode.mutate({ regionId: r.id }); }}><RefreshCw className="h-3 w-3" />New code</Button></div></td>
        </tr>)}
        {!regions.data?.length && !regions.isLoading && <tr><td colSpan={6} className="px-6 py-16 text-center text-sm text-slate-400">No regions yet.</td></tr>}
      </tbody></table></div></CardContent>
    </Card>

    <div className="grid gap-6 xl:grid-cols-3">
      <Card className="h-fit border-slate-200 shadow-none"><CardHeader><CardTitle className="text-base">New region</CardTitle></CardHeader><CardContent className="space-y-4">
        <div><Label className="text-xs">Region name</Label><Input className="mt-1.5" placeholder="Central D" value={newRegion.name} onChange={e => setNewRegion({ ...newRegion, name: e.target.value })} /></div>
        <div><Label className="text-xs">Region code</Label><Input className="mt-1.5 uppercase" placeholder="D" maxLength={8} value={newRegion.code} onChange={e => setNewRegion({ ...newRegion, code: e.target.value.toUpperCase() })} /></div>
        <Button className="w-full bg-slate-950 hover:bg-slate-800" disabled={!newRegion.name.trim() || !newRegion.code.trim() || createRegion.isPending} onClick={() => createRegion.mutate({ name: newRegion.name.trim(), code: newRegion.code.trim() })}>{createRegion.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Plus className="mr-2 h-4 w-4" />Create region</>}</Button>
        <p className="text-[11px] text-slate-400">An invite code is generated automatically.</p>
      </CardContent></Card>

      <Card className="h-fit border-slate-200 shadow-none"><CardHeader><CardTitle className="text-base">New HQ admin</CardTitle><p className="text-xs text-slate-500">Sees all regions, all features except whitenoise.</p></CardHeader><CardContent className="space-y-4">
        <div><Label className="text-xs">Full name</Label><Input className="mt-1.5" value={hqForm.name} onChange={e => setHqForm({ ...hqForm, name: e.target.value })} /></div>
        <div><Label className="text-xs">Email</Label><Input className="mt-1.5" type="email" value={hqForm.email} onChange={e => setHqForm({ ...hqForm, email: e.target.value })} /></div>
        <div><Label className="text-xs">Mobile</Label><Input className="mt-1.5" placeholder="+923001234567" value={hqForm.phoneNumber} onChange={e => setHqForm({ ...hqForm, phoneNumber: e.target.value })} /></div>
        <div><Label className="text-xs">Password</Label><Input className="mt-1.5" type="password" value={hqForm.password} onChange={e => setHqForm({ ...hqForm, password: e.target.value })} /></div>
        <Button className="w-full bg-slate-950 hover:bg-slate-800" disabled={!hqForm.name.trim() || !hqForm.email.trim() || hqForm.password.length < 8 || createHq.isPending} onClick={() => createHq.mutate({ name: hqForm.name.trim(), email: hqForm.email.trim(), phoneNumber: hqForm.phoneNumber.trim(), password: hqForm.password })}>{createHq.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create HQ admin"}</Button>
      </CardContent></Card>

      <Card className="h-fit border-slate-200 shadow-none"><CardHeader><CardTitle className="text-base">New manager</CardTitle><p className="text-xs text-slate-500">Manages one region. HQ admins can also create managers.</p></CardHeader><CardContent className="space-y-4">
        <div><Label className="text-xs">Full name</Label><Input className="mt-1.5" value={mgrForm.name} onChange={e => setMgrForm({ ...mgrForm, name: e.target.value })} /></div>
        <div><Label className="text-xs">Email</Label><Input className="mt-1.5" type="email" value={mgrForm.email} onChange={e => setMgrForm({ ...mgrForm, email: e.target.value })} /></div>
        <div><Label className="text-xs">Mobile</Label><Input className="mt-1.5" placeholder="+923001234567" value={mgrForm.phoneNumber} onChange={e => setMgrForm({ ...mgrForm, phoneNumber: e.target.value })} /></div>
        <div><Label className="text-xs">Password</Label><Input className="mt-1.5" type="password" value={mgrForm.password} onChange={e => setMgrForm({ ...mgrForm, password: e.target.value })} /></div>
        <div><Label className="text-xs">Region</Label><Select value={mgrForm.regionId} onValueChange={v => setMgrForm({ ...mgrForm, regionId: v })}><SelectTrigger className="mt-1.5"><SelectValue placeholder="Select region" /></SelectTrigger><SelectContent>{(regions.data ?? []).filter(r => r.status === "ACTIVE").map(r => <SelectItem key={r.id} value={String(r.id)}>{r.name}</SelectItem>)}</SelectContent></Select></div>
        <Button className="w-full bg-emerald-600 hover:bg-emerald-700" disabled={!mgrForm.name.trim() || !mgrForm.email.trim() || mgrForm.password.length < 8 || !mgrForm.regionId || createMgr.isPending} onClick={() => createMgr.mutate({ name: mgrForm.name.trim(), email: mgrForm.email.trim(), phoneNumber: mgrForm.phoneNumber.trim(), password: mgrForm.password, regionId: Number(mgrForm.regionId) })}>{createMgr.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create manager"}</Button>
      </CardContent></Card>
    </div>

    <Card className="border-slate-200 shadow-none"><CardHeader><CardTitle className="text-base">Staff accounts</CardTitle><p className="text-xs text-slate-500">Super admins, HQ admins and managers.</p></CardHeader><CardContent className="p-0"><div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm">
      <thead className="border-y border-slate-100 bg-slate-50/70 text-[11px] uppercase tracking-wider text-slate-400"><tr><th className="px-6 py-3">Name</th><th className="px-6 py-3">Email</th><th className="px-6 py-3">Role</th><th className="px-6 py-3">Region</th><th className="px-6 py-3">Status</th></tr></thead>
      <tbody className="divide-y divide-slate-100">{(staff.data ?? []).map(s => <tr key={s.id} className="hover:bg-slate-50/70"><td className="px-6 py-3.5 font-medium text-slate-800">{s.name}</td><td className="px-6 py-3.5 text-xs text-slate-500">{s.email}</td><td className="px-6 py-3.5"><Badge variant="outline" className="text-[11px]">{String(s.accountRole).replace("_", " ")}</Badge></td><td className="px-6 py-3.5 text-xs text-slate-500">{s.region?.name ?? "—"}</td><td className="px-6 py-3.5 text-xs text-slate-500">{s.accountStatus}</td></tr>)}
      {!staff.data?.length && !staff.isLoading && <tr><td colSpan={5} className="px-6 py-16 text-center text-sm text-slate-400">No staff accounts yet.</td></tr>}</tbody>
    </table></div></CardContent></Card>
  </div>;
}
