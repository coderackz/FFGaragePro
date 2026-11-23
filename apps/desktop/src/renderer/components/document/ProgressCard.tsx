import clsx from "clsx";
import type { DocType } from "@ffgp/shared";
import { Card } from "../ui";

/** The steps a document goes through, by status; "Part paid" sits on the Paid step. */
const STEPS: Partial<Record<DocType, { label: string; statuses: string[] }[]>> = {
  estimate: [{ label: "Draft", statuses: ["draft"] }, { label: "Sent", statuses: ["sent"] }, { label: "Approved", statuses: ["approved"] }, { label: "Converted", statuses: ["converted"] }],
  jobcard: [{ label: "Open", statuses: ["open"] }, { label: "In progress", statuses: ["in_progress"] }, { label: "Completed", statuses: ["completed"] }, { label: "Invoiced", statuses: ["converted"] }],
  invoice: [{ label: "Draft", statuses: ["draft"] }, { label: "Issued", statuses: ["issued"] }, { label: "Paid", statuses: ["part_paid", "paid"] }],
};

/** Where the document is: done steps filled, the current one marked. Read-only (status changes stay in the header). */
export function ProgressCard({ type, status }: { type: DocType; status: string }) {
  const steps = STEPS[type];
  if (!steps) return null;
  const at = steps.findIndex((s) => s.statuses.includes(status));
  const finished = status === "paid" || status === "converted";
  return (
    <Card title="Progress">
      <ol className="flex flex-col gap-2.5 text-sm" data-testid="progress">
        {steps.map((s, i) => {
          const done = i < at || (i === at && finished);
          const current = i === at && !finished;
          return (
            <li key={s.label} className={clsx("flex items-center gap-2.5", current ? "font-semibold text-zinc-900" : done ? "text-zinc-500" : "text-zinc-400")} aria-current={current ? "step" : undefined}>
              <span className={clsx("grid size-4 place-items-center rounded-full border-[1.5px]", done ? "border-brand-600 bg-brand" : current ? "border-brand-700" : "border-zinc-300")}>
                {current && <span className="size-1.5 rounded-full bg-brand-700" />}
              </span>
              {status === "part_paid" && s.label === "Paid" ? "Part paid" : s.label}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
