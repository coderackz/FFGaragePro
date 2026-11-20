import { ArrowLeft, LifeBuoy, Search } from "lucide-react";
import { Fragment, useState } from "react";
import { Link, useParams } from "react-router";
import { Card, Empty, Input, PageHeader } from "../components/ui";
import { GUIDES, searchGuides, type Guide } from "../help/guides";

/** The body's simple text: "## " headings, "- " list items, blank lines between paragraphs. */
function Body({ text }: { text: string }) {
  return (
    <div className="space-y-3 text-sm leading-relaxed text-zinc-800">
      {text.split(/\n\s*\n/).map((block, i) => {
        const lines = block.split("\n");
        if (lines[0]!.startsWith("## ")) {
          const rest = lines.slice(1);
          return (
            <Fragment key={i}>
              <h3 className="pt-2 text-base font-semibold text-zinc-900">{lines[0]!.slice(3)}</h3>
              {rest.length > 0 && <Block lines={rest} />}
            </Fragment>
          );
        }
        return <Block key={i} lines={lines} />;
      })}
    </div>
  );
}
function Block({ lines }: { lines: string[] }) {
  if (lines.every((l) => l.startsWith("- "))) return <ul className="list-disc space-y-1 pl-5">{lines.map((l, i) => <li key={i}>{l.slice(2)}</li>)}</ul>;
  return <p>{lines.join(" ")}</p>;
}

/** Knowledge: short how-to guides for each part of the app, searchable, kept in the app (no network needed). */
export function KnowledgePage() {
  const { slug } = useParams();
  const [q, setQ] = useState("");
  const guide = slug ? GUIDES.find((g) => g.slug === slug) : null;
  if (guide) {
    return (
      <>
        <PageHeader back={<Link to="/knowledge" className="mb-1 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800"><ArrowLeft className="size-3.5" /> Help & guides</Link>}
          title={guide.title} subtitle={guide.area} />
        <Card className="max-w-3xl"><Body text={guide.body} /></Card>
      </>
    );
  }
  const found = searchGuides(q);
  const byArea = found.reduce<Record<string, Guide[]>>((m, g) => ({ ...m, [g.area]: [...(m[g.area] ?? []), g] }), {});
  return (
    <>
      <PageHeader title="Help & guides" subtitle="How each part of the app works, step by step" />
      <div className="mb-5 flex max-w-md items-center gap-2">
        <Search className="size-4 text-zinc-400" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the guides (e.g. gratuity, VAT, cheque)" aria-label="Search the guides" />
      </div>
      {!found.length ? <Empty icon={<LifeBuoy className="size-10" />} title="Nothing found">Try another word.</Empty> : (
        <div className="grid grid-cols-2 gap-5 max-lg:grid-cols-1">
          {Object.entries(byArea).map(([area, guides]) => (
            <Card key={area} title={area}>
              <ul className="space-y-2">
                {guides.map((g) => (
                  <li key={g.slug}>
                    <Link to={`/knowledge/${g.slug}`} className="font-medium text-brand-700 hover:underline">{g.title}</Link>
                    <p className="text-xs text-zinc-600">{g.body.split("\n").find((l) => l && !l.startsWith("##"))?.replace(/^- /, "")}</p>
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
