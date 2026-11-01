import { Suspense } from "react";
import { assemble } from "@/lib/assemble";
import { Profile } from "@/components/Profile";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function Loaded({ view }: { view: "grid" | "bars" }) {
  const { snapshot, settings } = await assemble("365d");
  return <Profile snapshot={snapshot} settings={settings} initialView={view} />;
}

function Skeleton() {
  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <span className="brand-mark" />
            <span>token</span>
          </div>
          <div className="top-actions">
            <span style={{ color: "var(--faint)", fontSize: 12 }}>Reading local sessions…</span>
          </div>
        </div>
      </header>
      <main className="canvas">
        <div style={{ height: 24, width: 120, background: "#161618", borderRadius: 6 }} />
        <div style={{ height: 14, width: 280, background: "#131315", borderRadius: 6, marginTop: 10 }} />
        <div className="panel" style={{ height: 118, marginTop: 26 }} />
        <div className="panel" style={{ height: 300, marginTop: 14 }} />
        <div className="bottom">
          <div className="panel" style={{ height: 106 }} />
          <div className="panel" style={{ height: 106 }} />
        </div>
      </main>
    </div>
  );
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const sp = await searchParams;
  const view = sp.view === "bars" ? "bars" : "grid";
  return (
    <Suspense fallback={<Skeleton />}>
      <Loaded view={view} />
    </Suspense>
  );
}
