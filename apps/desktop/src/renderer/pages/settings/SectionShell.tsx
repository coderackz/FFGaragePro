import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { Button } from "../../components/ui";
import { useReportUnsaved, useUnsaved } from "../../lib/unsaved";

/** "← All settings", asking first when there are unsaved changes. */
export function BackToSettings() {
  const { confirmLeave } = useUnsaved();
  return (
    <Link to="/settings" onClick={(e) => !confirmLeave() && e.preventDefault()} className="mb-1 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900">
      <ArrowLeft className="size-3.5" /> All settings
    </Link>
  );
}

/** One Settings section: back link, title, its own Save, and an optional side column (the print preview). */
export function SectionShell({ title, subtitle, dirty = false, busy = false, onSave, onDiscard, aside, children }: {
  title: string; subtitle?: string; dirty?: boolean; busy?: boolean; onSave?: () => void; onDiscard?: () => void; aside?: ReactNode; children: ReactNode;
}) {
  useReportUnsaved(dirty, title);
  return (
    <div>
      <div className="mb-5 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <BackToSettings />
          <h1 className="truncate text-[22px] font-semibold tracking-tight text-zinc-900">{title}</h1>
          {subtitle && <div className="mt-0.5 text-sm text-zinc-500">{subtitle}</div>}
        </div>
        {onSave && (
          <div className="flex shrink-0 items-center gap-3">
            {dirty && <span className="text-sm text-amber-700">Unsaved changes</span>}
            {dirty && onDiscard && <Button variant="ghost" onClick={onDiscard}>Discard</Button>}
            <Button variant="primary" busy={busy} disabled={!dirty} onClick={onSave}>Save</Button>
          </div>
        )}
      </div>
      {aside ? (
        <div className="flex gap-6 max-lg:flex-col">
          <div className="min-w-0 flex-1 space-y-5">{children}</div>
          <div className="w-[380px] shrink-0 max-lg:w-full">{aside}</div>
        </div>
      ) : (
        <div className="max-w-3xl space-y-5">{children}</div>
      )}
    </div>
  );
}
