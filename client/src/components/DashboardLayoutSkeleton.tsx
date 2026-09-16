import { useTheme } from "@/contexts/ThemeContext";
import { Skeleton } from "./ui/skeleton";

const DREAM_TELCO_LOGO_LIGHT = "/manus-storage/dream-telco-logo-light_3777217f.png";
const DREAM_TELCO_LOGO_DARK = "/manus-storage/dream-telco-logo-dark_10a72ee7.png";

export function DashboardLayoutSkeleton() {
  const { theme } = useTheme();
  const logo = theme === "dark" ? DREAM_TELCO_LOGO_DARK : DREAM_TELCO_LOGO_LIGHT;
  return (
    <div className="flex min-h-screen bg-background text-foreground transition-colors duration-300">
      <aside className="hidden w-[252px] border-r border-border bg-background p-4 md:block">
        <div className="flex items-center gap-3 border-b border-border px-2 pb-5">
          <div className="h-12 w-12 overflow-hidden rounded-2xl border border-border bg-card p-1 shadow-sm"><img src={logo} alt="Dream Telco logo" className="h-full w-full object-contain" /></div>
          <div><p className="font-display text-sm font-semibold">Dream Telco</p><p className="text-[10px] font-medium uppercase tracking-[0.16em] text-orange-600">Reporting OS</p></div>
        </div>
        <div className="mt-6 space-y-2 px-2"><Skeleton className="h-10 w-full rounded-xl" /><Skeleton className="h-10 w-full rounded-xl" /><Skeleton className="h-10 w-full rounded-xl" /></div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[82px] items-center justify-between border-b border-border px-4 sm:px-6 lg:px-9">
          <div className="flex items-center gap-3"><div className="md:hidden h-9 w-9 overflow-hidden rounded-xl border border-border bg-card p-0.5 shadow-sm"><img src={logo} alt="Dream Telco logo" className="h-full w-full object-contain" /></div><div><p className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">Operations</p><Skeleton className="mt-2 h-4 w-44" /></div></div>
          <Skeleton className="h-9 w-20 rounded-full" />
        </header>
        <div className="flex flex-1 items-center justify-center px-6 py-12"><div className="flex flex-col items-center gap-5 text-center"><div className="h-24 w-24 animate-pulse overflow-hidden rounded-3xl border border-border bg-card p-2 shadow-lg"><img src={logo} alt="Dream Telco loading" className="h-full w-full object-contain" /></div><div><p className="font-display text-lg font-semibold">Preparing your workspace</p><p className="mt-1 text-sm text-muted-foreground">Loading Dream Telco operations securely…</p></div><div className="h-1.5 w-36 overflow-hidden rounded-full bg-muted"><div className="h-full w-1/2 animate-pulse rounded-full bg-emerald-500" /></div></div></div>
      </main>
    </div>
  );
}
