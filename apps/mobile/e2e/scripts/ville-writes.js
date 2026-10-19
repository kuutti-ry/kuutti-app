// chat-live (#349): Ville writes to Antti over HTTP, as his phone would, while
// the flow watches Antti's conversation. The words are the flow's own (WORDS),
// letters only, since the send refuses what looks like a number or a handle.
var list = JSON.parse(
  http.get(`${API_URL}/conversations?thumbs=false`, {
    headers: { Authorization: output.villeAuth },
  }).body,
);
var withAntti = list.open
  .concat(list.archived)
  .filter(
    (conversation) =>
      conversation.state !== "closed" &&
      conversation.counterpart &&
      !conversation.counterpart.deleted &&
      conversation.counterpart.name === "Antti",
  )[0];
if (!withAntti) throw new Error("Ville has no open conversation with Antti: run pnpm demo:reset");
var clientId = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
  var r = Math.floor(Math.random() * 16);
  return (c === "x" ? r : (r & 3) | 8).toString(16);
});
var sent = http.post(`${API_URL}/conversations/${withAntti.id}/messages`, {
  headers: { Authorization: output.villeAuth, "Content-Type": "application/json" },
  body: JSON.stringify({ clientId: clientId, body: WORDS }),
});
if (sent.status !== 201) throw new Error(`Ville's message was refused: ${sent.status}`);
output.liveConversation = withAntti.id;
output.liveSeq = JSON.parse(sent.body).seq;
