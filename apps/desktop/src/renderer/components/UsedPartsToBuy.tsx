import { useState } from "react";
import { Link } from "react-router";
import { useAuth } from "../lib/auth";
import type { UsedPartToBuy } from "../lib/types";
import { useApi } from "../lib/useApi";
import { BuyUsedPartDialog, type UsedPartRequest } from "./BuyUsedPartDialog";
import { Button, Card, Table } from "./ui";

/** Used parts ticked on open job cards whose purchase isn't recorded yet. Nothing when there are none. */
export function UsedPartsToBuy({ onBought }: { onBought?: () => void }) {
  const { can } = useAuth();
  const { data, reload } = useApi<{ items: UsedPartToBuy[] }>("/api/used-parts-to-buy");
  const [buying, setBuying] = useState<UsedPartRequest | null>(null);
  const items = data?.items ?? [];
  return (
    <>
      {items.length > 0 && (
        <div className="mb-4" data-testid="used-to-buy">
          <Card title={`Used parts to buy (${items.length})`} padded={false}>
            <Table rows={items} rowKey={(i) => `${i.documentId}:${i.position}`}
              columns={[
                { header: "Part", cell: (i) => <span className="font-medium">{i.description}</span> },
                { header: "Qty", cell: (i) => i.qty, align: "right" },
                { header: "Job card", cell: (i) => <Link className="font-mono text-[13px] text-brand-700 hover:underline" to={`/documents/${i.documentId}`}>{i.documentNumber}</Link> },
                { header: "Customer", cell: (i) => `${i.customerName}${i.plate ? ` · ${i.plate}` : ""}` },
                ...(can("purchases.manage") ? [{
                  header: "", align: "right" as const,
                  cell: (i: UsedPartToBuy) => <Button size="sm" onClick={() => setBuying({ documentId: i.documentId, documentNumber: i.documentNumber, position: i.position, line: { description: i.description, qty: i.qty } })}>Buy used part</Button>,
                }] : []),
              ]} />
          </Card>
        </div>
      )}
      <BuyUsedPartDialog request={buying} onClose={() => setBuying(null)} onDone={() => { void reload(); onBought?.(); }} />
    </>
  );
}
