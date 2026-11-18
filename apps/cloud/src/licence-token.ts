import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LicencePayload } from "@ffgp/sync";

export interface LicenceKey {
  privateKey: KeyObject;
  /** Given to each PC when it links; the PC checks every licence token with it. */
  publicKeyPem: string;
}

/** The cloud's Ed25519 signing key, kept in `<data>/licence-key.pem` (created on first start). */
export function loadOrCreateKey(dataDir: string): LicenceKey {
  const file = join(dataDir, "licence-key.pem");
  if (!existsSync(file)) {
    const { privateKey } = generateKeyPairSync("ed25519");
    writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  }
  const privateKey = createPrivateKey(readFileSync(file));
  return { privateKey, publicKeyPem: createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString() };
}

/** `base64url(json).base64url(signature)`. */
export function signLicence(key: LicenceKey, payload: LicencePayload): string {
  const body = Buffer.from(JSON.stringify(payload));
  return `${body.toString("base64url")}.${sign(null, body, key.privateKey).toString("base64url")}`;
}
