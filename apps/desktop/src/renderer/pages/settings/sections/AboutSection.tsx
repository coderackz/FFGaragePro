import { Mail } from "lucide-react";
import { Card } from "../../../components/ui";
import { isCloud } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { formatDate } from "../../../lib/format";
import { SectionShell } from "../SectionShell";

export const SUPPORT_EMAIL = "garagepro@fleetfix.ae";

const STATE: Record<string, string> = { trial: "Free trial", active: "Active", grace: "Ended — renew soon", read_only: "Read-only" };

export function AboutSection() {
  const { licence } = useAuth();
  const licenceText = !licence
    ? "Standalone — no subscription needed"
    : `${STATE[licence.state] ?? licence.state}${licence.endsAt ? ` · until ${formatDate(licence.state === "grace" ? licence.graceEndsAt : licence.endsAt)}` : ""}`;
  return (
    <SectionShell title="About & support" subtitle="Fleetfix Garage Pro">
      <Card>
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[160px_1fr]">
          <dt className="text-zinc-600">Version</dt>
          <dd className="font-medium text-zinc-900" data-testid="app-version">{__APP_VERSION__}{isCloud ? " (browser)" : ""}</dd>
          <dt className="text-zinc-600">Licence</dt>
          <dd className="font-medium text-zinc-900">{licenceText}</dd>
          <dt className="text-zinc-600">Support</dt>
          <dd>
            <a href={`mailto:${SUPPORT_EMAIL}`} className="inline-flex items-center gap-1.5 font-medium text-zinc-900 underline underline-offset-2 hover:text-brand">
              <Mail className="size-4" /> {SUPPORT_EMAIL}
            </a>
          </dd>
        </dl>
      </Card>
    </SectionShell>
  );
}
