// chat-live (#349): whether Antti's phone marked Ville's message read while
// it was on the screen, as Ville's own view of the conversation tells it
// (the read mark his phone would show as Read). The flow asks up to four times.
var seen = JSON.parse(
  http.get(`${API_URL}/conversations/${output.liveConversation}`, {
    headers: { Authorization: output.villeAuth },
  }).body,
);
output.liveRead = seen.counterpartReadUpTo >= output.liveSeq;
