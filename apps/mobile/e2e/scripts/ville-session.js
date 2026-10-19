// chat-live's second phone (#349): Ville's session for the flow's scripts,
// from the refresh token scripts/e2e.ts made through the mock bank before the
// run. A refresh hands back a new access token and a new refresh token, the
// old one spent, so the new one is kept for the next script of the run.
if (typeof CHAT_LIVE_REFRESH === "undefined" || typeof API_URL === "undefined") {
  throw new Error("chat-live runs through pnpm e2e, which signs Ville in first");
}
var refresh = output.villeRefresh || CHAT_LIVE_REFRESH;
var refreshed = http.post(`${API_URL}/auth/refresh`, {
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ refreshToken: refresh }),
});
if (!refreshed.ok) throw new Error(`Ville's session could not be refreshed: ${refreshed.status}`);
var session = JSON.parse(refreshed.body);
output.villeRefresh = session.refreshToken;
output.villeAuth = `Bearer ${session.accessToken}`;
