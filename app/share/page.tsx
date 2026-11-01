import { assemble } from "@/lib/assemble";
import { ShareCard } from "@/components/ShareCard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function SharePage() {
  const { snapshot, settings } = await assemble("365d");
  return (
    <div style={{ width: 1200, height: 630, overflow: "hidden" }}>
      <ShareCard snapshot={snapshot} settings={settings} />
    </div>
  );
}
