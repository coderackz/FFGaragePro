# Main-computer mode — Design

## Why
Garages with more than one PC (front desk, service advisors, owner's office) must work on the same
customers, job cards and invoices. Today each PC has its own separate database. Approved by the user 2026-11-17.

## What the user approved
- The PC where the garage was set up is the **main computer**. Owner turns on "Share with other PCs" in
  Settings; Settings then shows its network address and a 6-digit pairing code.
- Other PCs: the first-run screen offers "Connect to the main computer". The app finds main computers on the
  network automatically, or the address is typed. Pairing code is entered once; then everyone signs in with
  their own login.
- Only paired PCs can talk to the main computer. 5 wrong passwords lock that login for 5 minutes. The owner
  can see and remove paired PCs. Traffic on the garage network is not encrypted in this version (comes with Cloud).
- Windows asks once to allow the app through its firewall (needs a Windows administrator).
- Main computer off → other PCs show "Can't reach the main computer" + Retry; no offline editing on them.
- Other PCs see changes when a screen is opened or refreshed (no live push).

## Approaches
- **Picked: main computer runs the existing embedded server on the garage network; other apps connect over HTTP.**
  Already the plan in the project-1 spec; the renderer only talks HTTP, so no screen changes beyond setup/settings.
- Rejected: shared SQLite file on a network folder (SMB locking corrupts SQLite); cloud database (fails without internet).

## Builder's calls (mine, correctable)
- Fixed TCP port **47820** for sharing (single-PC mode keeps a random loopback port); UDP **47821** for discovery
  (broadcast "who is the main computer?", main replies with garage name + port).
- Pairing code: owner clicks "Pair a new PC" → code valid 10 minutes, single use; 5 wrong codes cancel it.
  Pairing returns a random device key (stored hashed on the main computer); every request from another PC must
  carry it (`x-ffgp-device`). Requests from the main computer itself (loopback) don't need it.
- Sharing on/off is stored in the garage database; turning it on/off restarts the embedded server and reloads the window
  (the session survives).
- The connect option is a box at the top of the first-run setup screen (most garages have one PC, so setup stays the default).
- A connected PC's Settings shows which main computer it uses and a "Disconnect this PC" button; sharing controls
  only appear on the main computer.
- CORS limited to the app itself (`file://` = `null`, localhost dev servers).
- Login lockout is per username, in memory (resets if the main computer restarts).
- Windows networks set to "Public" block incoming connections; Settings tells the owner to set the network to Private.
