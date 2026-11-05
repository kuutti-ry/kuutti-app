# features/chat/your-turn.feature
Feature: Whose turn it is in a conversation
  A conversation waits on a person when it is open, not archived, and the last
  thing said in it, a message or a shared contact, came from the other person;
  a match where nothing has been said waits on both (ADR-062 §5, the
  maintainer's of 01/11/2026). The list says it of each conversation and counts
  them against matching_config your_turn_limit, at which a person can make no
  new match (features/matching/matches.feature), with a banner from
  your_turn_warning. It is read through what the person may see, so a shadow ban
  shows nothing here. Two people who come back and match open a new conversation
  (§7), and a like belongs to a conversation it can have made.

  Scenario: A fresh match is both people's turn
    Given "A" and "B" have just matched
    Then the conversation is on both people's turn, and each counts one

  Scenario Outline: The last thing said hands the turn to the other person
    Given "A" and "B" are in a conversation
    When "A" <says>
    Then it is "B"'s turn and not "A"'s
    When "B" <says>
    Then it is "A"'s turn and not "B"'s

    Examples:
      | says               |
      | writes a message   |
      | sends a photo      |
      | shares a contact   |

  Scenario: The newer of a message and a shared contact decides, and at the same moment the message
    Given "A" wrote to "B"
    When "B" shares a contact at the same moment
    Then it is still "B"'s turn
    When "B" shares another a moment later
    Then it is "A"'s turn
    When "A" writes again
    Then it is "B"'s turn

  Scenario: An ended or an archived conversation leaves the count, and a message brings an archived one back
    Given "A" is in fresh conversations with "B" and "C"
    When "A" ends the one with "B", and the night archives the one with "C"
    Then neither is on anybody's turn and nobody counts anything
    When "C" writes to "A"
    Then the conversation is open again and on "A"'s turn

  Scenario: A shadow ban shows nothing in the count, either way
    Given "A" is shadow-banned, with one conversation waiting on "B" and one waiting on "A"
    When "A" writes and shares a contact in both
    Then "A" reads both as answered, and "B" reads each as it stood before
    When the shadow ban is lifted
    Then "B" reads both as "A" left them

  Scenario: A blocked conversation is on nobody's turn
    Given "A" and "B" are in a fresh conversation
    When "A" blocks "B"
    Then neither counts it, and "B" reads it ended and not on their turn

  Scenario: The list says each conversation's turn and the count against the limit
    Given "A" has a conversation waiting on them, one waiting on the other person and a fresh one
    When "A" asks for the list, with thumbs or without
    Then each row says whose turn it is, and the list counts two against your_turn_limit and your_turn_warning
    When an admin changes both
    Then the next list says the new numbers

  Scenario: Another person's conversations are never counted
    Given "A" and "B" are in a fresh conversation and "C" is not
    Then "C" counts nothing, and neither does an account nobody has

  Scenario: A second match closes the archived conversation between the two and ends what was shared in it
    Given "A" and "B" have an archived conversation in which "A" shares a contact, and "A" has an archived one with "C"
    When "A" and "B" match again
    Then the old one is closed as an unmatch at that moment and the share is ended by the close
    And the new one is open and both people's turn, and the one with "C" stays as it was

  Scenario Outline: Which conversation a like can be part of
    Given "A" and "B" have a conversation <which>
    When a like between the two asks which conversation it can be part of
    Then the answer is <answer>

    Examples:
      | which                                    | answer           |
      | open, opened long ago                    | that conversation |
      | opened today and since ended             | that conversation |
      | opened today and since archived          | that conversation |
      | opened at the very start of today        | that conversation |
      | opened long ago and ended                | none             |
      | opened long ago and archived             | none             |
      | opened a moment before today, and ended  | none             |
