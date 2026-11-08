# features/chat/conversations.feature
Feature: Conversations and their text messages
  A match opens a conversation (#100 writes it from the second like; until
  then the demo stories and the tests do). The two people write to each
  other in it, and each sees the list of their conversations (#348,
  ADR-031). A message belongs to the conversation (TD-1): nothing is deleted
  when one closes, and when a person deletes their account the other keeps
  what was said, under "Deleted user" (TD-7). Every route reads through the
  caller's own participant row (rule 6). A block ends the conversation for
  both and the blocker never sees it again, the word "blocked" nowhere
  (ADR-030). The text reaches no log line, error detail or event (rule 5).
  Live arrival is #349; photos #350; report, block and unmatch from the
  conversation #351.

  Scenario: The list shows each conversation with its counterpart, the last message and the unread count
    Given "A" and "B" are in a conversation where "B" wrote twice and "A" read the first
    When "A" asks for the list
    Then the row names "B" with the age and a signed thumb, the last message's first characters and one unread
    And nothing in it is "B"'s account id

  Scenario: The list puts open conversations first and the archived and closed ones after, each newest first
    Given "A" has an open, an archived, a silent and a closed conversation
    When "A" asks for the list
    Then the open ones come first, newest first by the last message or the opening, and the others after

  Scenario: One conversation gives the composer its limit and the other side's read mark
    Given "A" and "B" are in a conversation and "B" has read up to the second message
    When "A" opens it
    Then it says the longest message matching_config allows and that "B" read up to the second

  Scenario: A message is sent with the next sequence, and brings an archived conversation back
    Given "A" and "B" are in an archived conversation with two messages
    When "A" sends a message
    Then it is answered 201 with sequence three, "A"'s side, the trimmed text and the time
    And the conversation is open again with that message as its last

  Scenario: A resend with the same client id returns the stored message and writes nothing
    Given "A" sent a message and the answer was lost
    When "A" sends it again with the same client id
    Then the answer is 200 with the message stored the first time, and there is still one

  Scenario: Two sends at once take consecutive sequences without a gap
    Given "A" and "B" send to their conversation at the same moment
    Then the two messages take two consecutive sequences, whichever lands first

  Scenario: The history pages back and the resume reads onward
    Given a conversation of five messages
    When "A" reads the newest page of two, then the page before the oldest of them, then what is after the second
    Then each page holds the messages it names, newest first back, oldest first onward

  Scenario: The read mark goes up, never down, and never past the newest message
    Given a conversation of three messages
    When "A" marks it read up to two, then up to one, then up to ten
    Then the mark stands at two and then at three

  Scenario Outline: A send is refused in words and writes nothing
    Given "A" and "B" are in a conversation
    When "A" sends a message that is <case>
    Then the answer is <status> with <code>, and no message is written

    Examples:
      | case                                    | status | code                |
      | empty after trimming                    | 400    | validation_failed   |
      | over message_max_length after trimming  | 400    | message_too_long    |
      | carrying a phone number                 | 400    | contact_details     |
      | in a conversation that closed           | 409    | conversation_closed |
      | to somebody a block stands between      | 409    | conversation_closed |
      | to somebody who deleted their account   | 409    | conversation_closed |

  Scenario: A block that lands while a message is in flight refuses it
    Given "A" is sending a message to "B"
    When "B" blocks "A" before the send reads what it decides on
    Then the send is refused with conversation_closed and nothing is written

  Scenario: The messages of a minute are counted per account, and a new number holds from the next request
    Given messages_per_minute is two
    When "A" sends three messages in a minute
    Then the third is refused with message_budget_exceeded and Retry-After, and "B" may still send
    When an admin raises the number
    Then "A"'s next message in the same minute is sent

  Scenario: A conversation the caller is not in answers 404 from every route
    Given "A" and "B" are in a conversation and "C" is not
    When "C" lists, opens, pages, sends to or marks it, or asks for one that does not exist
    Then every answer is 404 and nothing is written

  Scenario: The chat routes refuse without a session
    When nobody, a token nobody issued, or a staff token calls each chat route
    Then the answer is 401

  Scenario: A block hides the conversation from its blocker and ends it for the other
    Given "A" and "B" are in a conversation
    When "A" blocks "B"
    Then "A" no longer has it in the list and gets 404 for it from every route
    And "B" has it among the archived ones, ended, the word blocked nowhere, and cannot write

  Scenario: A shadow-banned sender's messages are withheld from the counterpart until the ban is lifted
    Given "A" and "B" are in a conversation and "A" wrote once before a shadow ban
    When "A" writes again while shadow-banned
    Then "A" sees both, and "B" sees only the first, with nothing unread for the second
    When the shadow ban is lifted
    Then "B" sees both

  Scenario: A shadow-banned reader's mark is withheld from the counterpart until the ban is lifted
    Given "A" read "B"'s first line before a shadow ban, and "B" wrote again after it
    When "A" reads it, writes a line of its own and marks that one too, while shadow-banned
    Then "B" sees "A"'s mark where it stood before the ban
    When the shadow ban is lifted
    Then "B" sees all three lines read

  Scenario: What a shadow ban withheld stays withheld in a conversation that ended before the lift
    Given "A" read what "B" and "C" wrote, then wrote to each under a shadow ban and read that too
    When "B" ends theirs, "A" is banned, which ends "C"'s, and the shadow ban is lifted afterwards
    Then "B" and "C" each read their own line alone, "A"'s mark where it stood before the ban, and nothing unread

  Scenario: A ban closes the person's conversations, and a suspension closes none
    Given "A" is in conversations with "B" and "C"
    When "A" is suspended
    Then both stay open
    When "A" is banned
    Then both are closed and read as ended to "B" and "C"

  Scenario: The night archives a silent conversation and leaves one with a recent message
    Given silent_match_archive_days is seven, one conversation silent for eight days, one opened eight days ago without a message, one with a message yesterday, and one closed long ago
    When the night runs
    Then the two silent ones are archived, the recent one and the closed one are not, and each archive is an event

  Scenario: A break stops no clock
    Given "A" is on a break and the conversation with "B" has been silent for eight days
    When the night runs
    Then the conversation is archived all the same

  Scenario: The list's thumb is logged as a fetch and never counted as a card
    Given "A" and "B" are in a conversation and "B" has an approved photo
    When "A" asks for the list, and again without thumbs
    Then the first carries the signed thumb of "B"'s main photo with a fetch-log row, no card is counted, and the second signs nothing
    And "B" paused, banned or blocked has no thumb, nor an ended conversation once a ban is lifted

  Scenario: Each send, archive and close is a research event with no text
    Given "A" and "B" gave the research consent
    When "A" sends, the night archives, and "B" deletes the account
    Then the events carry the kind, the bands of length, wait, count and age, and how it closed, and no text
