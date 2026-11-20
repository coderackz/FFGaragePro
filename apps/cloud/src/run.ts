import { scheduleBackups } from "./backups";
import { createCloudServer } from "./server";

/**
 * Starts Fleetfix Cloud: the server on `port`, the first staff account from FFGP_CLOUD_STAFF
 * ("username:Full Name:password" or "username:Full Name:scrypt$…" with a hash; made only if that username doesn't
 * exist yet), and optionally daily backups and the sending of linked garages' email.
 */
export async function runCloud(o: { dataDir: string; webDir?: string; port: number; host?: string; backups?: boolean; messages?: boolean }) {
  // Providers (Meta, Zoho, Intuit) call back on this address: webhooks and OAuth redirects.
  const publicUrl = process.env.FFGP_PUBLIC_URL || "https://garagepro.fleetfix.ae";
  const cloud = await createCloudServer({ dataDir: o.dataDir, webDir: o.webDir, integrations: { publicUrl } });
  const staff = process.env.FFGP_CLOUD_STAFF?.split(":");
  if (staff?.length === 3 && staff[2]!.length >= 8 && !cloud.admin.raw.prepare("SELECT 1 FROM staff WHERE username = ?").get(staff[0]!)) {
    const [username, name, secret] = staff as [string, string, string];
    cloud.admin.addStaff(secret.startsWith("scrypt$") ? { username, name, passwordHash: secret } : { username, name, password: secret });
  }
  const stopBackups = o.backups ? scheduleBackups({ dataDir: o.dataDir, admin: cloud.admin }) : () => undefined;
  if (o.messages) cloud.outbox.start();
  await new Promise<void>((resolve) => cloud.server.listen(o.port, o.host, resolve));
  console.log(`Fleetfix Cloud on port ${o.port}  (data: ${o.dataDir}${o.webDir ? `, web: ${o.webDir}` : ", no web build"})`);
  const stop = async () => {
    stopBackups();
    await cloud.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
  return cloud;
}
