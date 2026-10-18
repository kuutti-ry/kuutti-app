# features/chat/closing.feature
Feature: Ending a conversation
  Either person ends a conversation for both without blocking (an unmatch,
  #351), or blocks or reports the other from it (features/safety/). An
  ended conversation stays in both people's archived group, read-only, under
  "Conversation ended": nothing says who ended it or how, and it names
  nobody, so the person blocked never learns from a name turning into
  "Deleted user" that the other left (ADR-031 Open 10). Either may still
  report it for matching_config.report_after_close_days.

  Scenario: An unmatch closes the conversation for both and blocks nobody
    Given "A" and "B" are in a conversation
    When "A" ends it, and again
    Then both answers are 204, both read it closed among the archived, ended and naming nobody, and neither can write
    And no block stands between the two

  Scenario: Both may still report an unmatched conversation within the window
    Given "A" ended the conversation with "B"
    Then both read it as reportable
    When "B" reports "A" from it
    Then the report is filed, and the conversation is gone for "B"

  Scenario: An ended conversation reads the same before and after the other person's erasure
    Given "B" blocked "A" from their conversation
    When "B" deletes the account
    Then "A" reads the conversation as before: ended, naming nobody, its messages as they were

  Scenario: What either shared ends with an unmatch or a block
    Given "A" shares a contact in a conversation with "B", and "C" one in a conversation with "D"
    When "A" ends theirs and "C" blocks "D" from theirs
    Then both shares are ended as by a close

  Scenario: An unmatch is a research event for the other person, and a block is none
    Given "A" and "B" gave the research consent, in two conversations
    When "A" ends one and blocks "B" from the other
    Then "B" has one conversation_closed event, how unmatch, and nobody has another

  Scenario: Only the conversation's two people can end it
    Given "A" and "B" are in a conversation and "C" is not
    When "C" ends it, "A" ends one that does not exist, and "B" ends it after blocking "A"
    Then each is refused with 404 and nothing is written
    And without a session the answer is 401
