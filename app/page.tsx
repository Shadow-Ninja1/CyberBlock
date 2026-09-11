import Dashboard from "@/components/Dashboard";
import { marketView } from "@/lib/view";

export const dynamic = "force-dynamic";

export default async function Page() {
  let initial = null;
  let error: string | null = null;
  try {
    initial = await marketView();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return <Dashboard initial={initial} initialError={error} />;
}
