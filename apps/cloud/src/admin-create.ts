import { AdminDb } from "./admin-db";

// Adds a Fleet Fix staff account: npm run admin:create -w @ffgp/cloud -- <username> "<name>" <password>
const [username, name, password] = process.argv.slice(2);
if (!username || !name || !password || password.length < 8) {
  console.error('Usage: npm run admin:create -w @ffgp/cloud -- <username> "<full name>" <password (8+ characters)>');
  process.exit(1);
}
const dataDir = process.env.FFGP_CLOUD_DATA ?? new URL("../.cloud-data", import.meta.url).pathname;
const admin = new AdminDb(dataDir);
try {
  admin.addStaff({ username, name, password });
  console.log(`Staff account "${username}" created in ${dataDir}/admin.db`);
} catch (error) {
  console.error((error as Error).message.includes("UNIQUE") ? `"${username}" already exists` : (error as Error).message);
  process.exitCode = 1;
} finally {
  admin.close();
}
