import type { ComponentType } from "react";
import { Navigate, useParams } from "react-router";
import { CloudCard } from "../../components/CloudCard";
import { OtherPcsCard } from "../../components/OtherPcsCard";
import { SyncIssues } from "../../components/SyncIssues";
import { Card } from "../../components/ui";
import { UsersPage } from "../UsersPage";
import { BackToSettings, SectionShell } from "./SectionShell";
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
