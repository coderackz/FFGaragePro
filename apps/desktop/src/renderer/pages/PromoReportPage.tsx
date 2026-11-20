import { TicketPercent } from "lucide-react";
import { Link } from "react-router";
import { Badge, Card, Empty, PageHeader, Spinner, Table } from "../components/ui";
import { formatAED, formatDate } from "../lib/format";
import { useApi } from "../lib/useApi";
import { promoTerms, type PromoCode } from "./settings/sections/PromoSection";

interface ReportRow extends PromoCode {
  uses: number; discountFils: number; overLimit: boolean;
  invoices: { id: string; number: string; issuedAt: string; discountFils: number }[];
}

/** Reports → Promo codes: each code's uses, the discount given, and the invoices. */
export function PromoReportPage() {
  const { data } = useApi<{ codes: ReportRow[] }>("/api/reports/promo-codes");
  const total = (data?.codes ?? []).reduce((s, c) => s + c.discountFils, 0);
  return (
    <>
      <PageHeader title="Promo codes" subtitle={data ? `${formatAED(total)} given in discounts on issued invoices` : undefined} />
      {!data ? <Spinner /> : !data.codes.length ? (
        <Empty icon={<TicketPercent className="size-10" />} title="No promo codes yet">Make them in Settings → Promo codes.</Empty>
      ) : (
        <div className="space-y-5">
          <Card padded={false}>
            <Table rows={data.codes} rowKey={(c) => c.id}
              columns={[
                { header: "Code", cell: (c) => <span className="font-mono font-medium">{c.code}{c.overLimit && <span className="ml-2"><Badge tone="red">Over its limit</Badge></span>}</span> },
                { header: "Discount", cell: (c) => promoTerms(c) },
                { header: "Uses", cell: (c) => <span className="tabular">{c.uses}{c.maxUses ? ` of ${c.maxUses}` : ""}</span> },
                { header: "Discount given", cell: (c) => <span className="tabular">{formatAED(c.discountFils)}</span> },
              ]} />
          </Card>
          {data.codes.filter((c) => c.invoices.length).map((c) => (
            <Card key={c.id} title={`${c.code}: invoices`}>
              <ul className="space-y-1 text-sm">
                {c.invoices.map((i) => (
                  <li key={i.id} className="flex justify-between">
                    <Link to={`/documents/${i.id}`} className="text-brand-700 hover:underline">{i.number}</Link>
                    <span className="text-zinc-500">{formatDate(i.issuedAt)}</span>
                    <span className="tabular">{formatAED(i.discountFils)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
