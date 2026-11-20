import type { ComponentType } from "react";
import { Navigate, useParams } from "react-router";
import { CloudCard } from "../../components/CloudCard";
import { OtherPcsCard } from "../../components/OtherPcsCard";
import { SyncIssues } from "../../components/SyncIssues";
import { Card } from "../../components/ui";
import { UsersPage } from "../UsersPage";
import { BackToSettings, SectionShell } from "./SectionShell";
import { AboutSection } from "./sections/AboutSection";
import { DocumentsSection } from "./sections/DocumentsSection";
import { ActivitySection } from "./sections/ActivitySection";
import { BackupsSection } from "./sections/BackupsSection";
import { BooksSection } from "./sections/BooksSection";
import { PayrollSection } from "./sections/PayrollSection";
import { TemplatesSection } from "./sections/TemplatesSection";
import { CreditSection } from "./sections/CreditSection";
import { GarageSection } from "./sections/GarageSection";
import { InventorySection } from "./sections/InventorySection";
import { MessagesSection } from "./sections/MessagesSection";
import { NumberingSection } from "./sections/NumberingSection";
import { PricingSection } from "./sections/PricingSection";
import { SecuritySection } from "./sections/SecuritySection";
import { TaxSection } from "./sections/TaxSection";
import { TILES } from "./tiles";

const CloudSection = () => (
  <SectionShell title="Fleetfix cloud" subtitle="Sync this garage with Fleetfix cloud, and its licence">
    <CloudCard />
  </SectionShell>
);
const OtherPcsSection = () => (
  <SectionShell title="Other PCs" subtitle="Computers in the garage that work through this one">
    <OtherPcsCard />
  </SectionShell>
);
const SyncIssuesSection = () => (
  <SectionShell title="Sync issues" subtitle="Changes from a PC that needed a decision">
    <SyncIssues />
  </SectionShell>
);
const UsersSection = () => <UsersPage back={<BackToSettings />} />;

/** Sections are added here as they are built; the rest say so. */
export const SECTIONS: Record<string, ComponentType> = {
  garage: GarageSection,
  documents: DocumentsSection,
  numbering: NumberingSection,
  tax: TaxSection,
  "customers-credit": CreditSection,
  pricing: PricingSection,
  inventory: InventorySection,
  messages: MessagesSection,
  "message-templates": TemplatesSection,
  books: BooksSection,
  payroll: PayrollSection,
  security: SecuritySection,
  activity: ActivitySection,
  backups: BackupsSection,
  about: AboutSection,
  users: UsersSection,
  cloud: CloudSection,
  "other-pcs": OtherPcsSection,
  "sync-issues": SyncIssuesSection,
};

export function SettingsSectionPage() {
  const { section = "" } = useParams();
  const tile = TILES.find((t) => t.id === section && !t.coming);
  if (!tile) return <Navigate to="/settings" replace />;
  const Section = SECTIONS[section];
  if (Section) return <Section />;
  return (
    <SectionShell title={tile.title} subtitle={tile.blurb}>
      <Card><div className="text-sm text-zinc-600">This section is on its way.</div></Card>
    </SectionShell>
  );
}
