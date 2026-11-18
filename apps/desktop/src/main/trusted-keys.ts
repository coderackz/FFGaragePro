/**
 * Licence keys built into the app, by cloud address (from GET <cloud>/api/cloud/licence-key). A PC linked to one of
 * these clouds only trusts licences signed with its key, whatever its saved settings say.
 * If the cloud's licence-key.pem is ever replaced, update this and ship a new installer.
 */
export const PINNED_LICENCE_KEYS: Record<string, string> = {
  "https://garagepro.fleetfix.ae": `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAvkyjEYYNrItAp6SB6ub2UN5byDHYr1ZWonq9YWVCyeM=
-----END PUBLIC KEY-----
`,
};
