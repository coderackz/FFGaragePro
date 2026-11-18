import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { trustedLink } from "../src/index";

const pem = () => generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();

describe("built-in licence keys", () => {
  const real = pem();
  const pinned = { "https://garagepro.fleetfix.ae": real };
  const link = { url: "https://garagepro.fleetfix.ae", garageCode: "alquoz-auto", deviceCode: "P1", deviceKey: "k" };

  it("a link to Fleetfix cloud always uses the key built into the app", () => {
    // Even if the saved link (config.json) was edited to hold another key.
    expect(trustedLink({ ...link, publicKey: pem() }, pinned).publicKey).toBe(real);
    expect(trustedLink({ ...link, url: "https://garagepro.fleetfix.ae/", publicKey: real }, pinned).publicKey).toBe(real);
  });

  it("a cloud answering at Fleetfix cloud's address with another key is refused when linking", () => {
    expect(() => trustedLink({ ...link, publicKey: pem() }, pinned, { linking: true })).toThrow(/isn't Fleetfix cloud/);
  });

  it("other addresses (a development cloud) keep the key they gave", () => {
    const dev = pem();
    expect(trustedLink({ ...link, url: "http://localhost:4790", publicKey: dev }, pinned).publicKey).toBe(dev);
  });
});
