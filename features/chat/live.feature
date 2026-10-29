# features/chat/live.feature
Feature: The chat's live socket
  One WebSocket per signed-in app in front (#349, ADR-031 §5) tells the phone
  what changed in its conversations: a message, a read mark, the other's
  presence, a conversation archived, back or closed. Writing stays on the
  HTTP routes; Postgres is the store and the socket the notifier, so what is
  committed reaches the sockets, a lost connection resumes from Postgres,
  and nothing is lost or doubled. Everything #348 withholds stays withheld:
  nothing crosses a block or a close, and a shadow-banned sender's words
  reach only the sender. No frame's text and no token reaches a log line.

  Scenario: The first frame authenticates, and the socket says it is ready
    Given "A" holds a live session
    When "A"'s phone opens the socket and sends its access token as the first frame
    Then the socket answers ready

  Scenario: A socket that does not authenticate in time, or brings anything else first, is closed
    When a phone sends nothing within the deadline, a resume or a pong first, a token nobody issued, a staff token, a revoked session's token, or an auth with a key too many
    Then each is told why in an error frame and closed with 1008

  Scenario: A frame outside the contract closes the socket
    Given "A"'s phone is signed in
    When it sends text that is no JSON, a frame of an unknown type, a second auth, a resume naming no conversation id or one conversation twice, a binary frame, a second resume, or a frame past the bound
    Then the socket says bad_frame and closes with 1008, or closes with 1009 for the frame past the bound

  Scenario: An upgrade from an origin the API does not admit is refused; its own host and an admitted one pass
    When a browser opens the socket from another origin, or names an origin that is no URL
    Then the upgrade is refused with 403
    And one from the API's own host or an origin on the allowlist opens, and a plain GET is told 426

  Scenario: A message reaches every socket of both people as it is committed
    Given "A" has two phones on the socket and "B" one
    When "B" sends a message
    Then each of A's phones gets it as theirs without B's client id, and B's phone gets it as mine with it

  Scenario: A resend writes one message and sends one frame
    Given "A"'s phone is on the socket
    When "B" sends a message, sends it again with the same client id, and sends another
    Then A's phone gets two message frames, the first and the third

  Scenario: A message committed while the phone is away arrives once at the next resume
    Given "A"'s phone held the first message and went away
    When "B" sends two more, and A's phone comes back and resumes from the first
    Then it gets the two in order, then the read mark, the presence and the state, and a conversation not its own answers gone

  Scenario: A resume before the list has loaded still hears who is online
    Given "B"'s phone is on the socket in their conversation
    When "A"'s phone resumes naming only a conversation not its own, and then another phone of A's names theirs
    Then the first hears B online before the answer about what it named, and the second hears it once

  Scenario: A resume far behind gets the oldest page it lacks, the rest left to HTTP
    Given "A"'s conversation with "B" holds a page and one more of messages A's phone has never had
    When A's phone resumes from none of them, and then from the newest
    Then the first resume gets the oldest page in order before the read mark, the presence and the state, and the second no message

  Scenario: The other side's read mark reaches the writer
    Given "A"'s phone is on the socket and "A" wrote to "B"
    When "B" reads it
    Then A's phone gets the read mark

  Scenario: The counterpart shows online while a socket is open, and offline when the last one closes
    Given "A"'s phone is on the socket
    When "B" opens a socket, opens and closes a second, and closes the first
    Then A's phone hears online once and offline once, and nothing for the second

  Scenario: The sixth socket of an account closes the oldest
    Given "A" has five sockets open
    When "A" opens a sixth
    Then the oldest is told too_many_sockets and closed

  Scenario: A block reaches both sides as a conversation frame, and nothing after it
    Given "A" and "B" are on the socket in their conversation
    When "B" blocks "A"
    Then A's phone hears that it ended and B's that it is gone, and nothing of A's after it reaches B

  Scenario: A shadow-banned sender's message reaches no counterpart, and the sender is never online
    Given "A" is shadow-banned and both are on the socket
    When "A" writes to "B"
    Then A's phone gets the message and B's gets nothing of it, and B never hears A online

  Scenario: A shadow-banned reader's mark reaches no counterpart until the lift
    Given "A" is shadow-banned and "B"'s phone is on the socket
    When "B" writes and "A" reads it
    Then B's phone hears no read mark, and B's other phone resumes with the mark from before the ban
    When the ban is lifted and "A" reads "B"'s next line
    Then B's phone gets that mark

  Scenario: A shadow ban put on while the socket is open hides the person at the next ping
    Given "A" and "B" are on the socket in their conversation, and B hears A online
    When "A" is shadow-banned and the ping comes
    Then B hears A offline, and B's next resume says so too

  Scenario: A session that ends closes its sockets at once
    When "A" logs out, or "B" deletes the account
    Then their phones are told session_revoked and closed

  Scenario: Archive and erasure reach the other side as the conversation's state
    Given "A"'s phone is on the socket
    When the night archives the conversation, and then "B" deletes the account
    Then A's phone hears archived, and then closed by erasure

  Scenario: The ping asks the session, a pong keeps the socket, and silence or an expired token closes it
    Given three phones on the socket
    When the ping comes and the first answers, the second stays silent, and the third's access token has expired
    Then the first stays, the second is closed for pong_timeout with 1001, and the third is told session_expired

  Scenario: A lost listener closes every socket, and the phones resume from Postgres
    Given "A"'s phone is on the socket
    When the API's connection to the channel is lost, "B" writes meanwhile, and the connection comes back
    Then A's phone is told restarting and closed with 1012, as is a phone that tries before the connection is back, then it resumes and gets B's message, and then gets the next one live
