import { join } from "node:path";
import { buildApp, Db } from "@ffgp/server";
import { tempDir } from "../../server/test/helpers";

export { addUser, call, createPart, onHand, setUp, SETUP, tempDir, type App } from "../../server/test/helpers";

/** A garage app in a fresh folder (closed by the caller via `apps`). */
export async function garageApp(dataDir = tempDir(), options: Partial<Parameters<typeof buildApp>[0]> = {}) {
  return buildApp({ dataDir, ...options });
}

/** Copies a garage database into a new folder (as a snapshot download would) and returns that folder. */
export function twin(db: Db): string {
  const dir = tempDir();
  db.raw.exec(`VACUUM INTO '${join(dir, "garage.db").replace(/'/g, "''")}'`);
  return dir;
}
