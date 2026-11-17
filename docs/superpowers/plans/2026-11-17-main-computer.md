# Main-computer mode — Implementation Plan

**Goal:** several PCs share one garage database over the LAN. **Spec:** `docs/superpowers/specs/2026-11-17-main-computer-design.md`

## Global constraints
- Sharing port TCP 47820, discovery UDP 47821; env `FFGP_NETWORK_PORT` overrides TCP for tests.
- Device key header `x-ffgp-device`; unpaired → 401 `{ code: "device_not_paired" }`.
- Login lockout: 5 consecutive failures per username → 429 for 5 minutes (even with the right password).

## Review focus
- Request from a LAN address without/with a revoked device key → 401 device_not_paired (health and pair stay open).
- Pairing code: expired, reused, or after 5 wrong tries → refused; brute force impossible.
- Turning sharing on when port 47820 is taken → app still starts (local only) and Settings shows why.
- Main computer restarted/off → client shows "Can't reach", Retry recovers when it's back.
- Lockout can't be bypassed by changing username case.

### Task 1: Server — network routes, device keys, pairing, lockout, CORS
Files: `packages/server/src/{migrations,app,network,auth,errors}.ts`, `routes/setup.ts`, test `test/network.test.ts`.
Migration 2: `settings(key, value)`, `devices(id, name, key_hash, created_at, last_seen_at, revoked_at)`.
API: `GET /api/network`, `PUT /api/network/sharing`, `POST /api/network/pairing-code`, `DELETE /api/network/devices/:id` (owner);
`POST /api/pair {code, deviceName}` → `{ deviceKey, garage: { name } }` (public).
Tests: device check (inject `remoteAddress`), pairing rules, lockout with injected clock, CORS rejects foreign origin.

### Task 2: Server start + discovery
`startServer({ dataDir, networkPort })` reads the sharing flag → 0.0.0.0:47820 + UDP responder, else 127.0.0.1:0;
falls back to local with `networkError` when the port is taken. `discovery.ts`: `startDiscoveryResponder`, `discoverMainComputers`.
Tests: responder answers a discover call with garage name; port-in-use fallback.

### Task 3: Desktop — main process modes, bridge, screens
`config.json` in userData (`local` | `client`); IPC `discover`, `connect`, `disconnect`, `applyNetwork`, `hostname`;
env `FFGP_USER_DATA` for tests. Renderer: connect box on setup → ConnectPage; Settings "Other PCs" card;
unpaired screen; device header in `api.ts`; CSP allows `http://*:47820`.

### Task 4: Two-PC end-to-end test (Mac + Windows CI)
`apps/desktop/test/network.spec.ts`: PC A sets up + shares + pairing code; PC B connects by A's address, signs in,
adds a customer A can see; A removes B → B sees "disconnected"; 5 wrong passwords → locked.
