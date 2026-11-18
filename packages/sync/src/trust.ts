import { CloudError, type CloudLink } from "./client";

const normalise = (url: string) => url.trim().replace(/\/+$/, "").toLowerCase();

/**
 * The licence key a link must use. For a cloud whose key is built into the app (`pinned`, by address), that key —
 * whatever the saved link says — so editing config.json can't lift a read-only licence. When linking, a server
 * at that address answering with another key is refused. Other addresses (a development cloud) keep their own.
 */
export function trustedLink(link: CloudLink, pinned: Record<string, string>, o: { linking?: boolean } = {}): CloudLink {
  const key = Object.entries(pinned).find(([url]) => normalise(url) === normalise(link.url))?.[1];
  if (!key) return link;
  if (o.linking && link.publicKey.trim() !== key.trim()) {
    throw new CloudError("refused", "That server isn't Fleetfix cloud (its licence key doesn't match). Check the address.");
  }
  return { ...link, publicKey: key };
}
