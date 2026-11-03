# features/matching/matches.feature
Feature: Two likes make a match, and the match is a conversation
  A like of somebody whose like of the person stands, within
  like_expiry_days, is a match (#100, ADR-038, TD-13): the conversation is
  opened in the statement of the second like, and the answer names it.
  Neither person learns of a like that was not mutual. A like that is part
  of a match is final, the maintainer's of 20/10/2026; any other like may
  still be taken back until the day ends. A match in which nobody writes
  for silent_match_archive_days is put away by itself, and writing brings
  it back (ADR-031 §8). Two people who come back and match again open a new
  conversation, and with too many conversations waiting on their answer a
  person makes no new match (ADR-062 §5, §7).

  Scenario: Two likes make a match, and the match is a conversation for both
    Given "B" liked "A" yesterday, and "B" is in "A"'s round today
    When "A" likes "B"
    Then the answer names a conversation, and both "A" and "B" find it among their conversations

  Scenario: A like that meets no like makes no match, and says nothing of the other
    Given "B" is in "A"'s round today, and "B" never liked "A"
    When "A" likes "B"
    Then the answer has no match, and "B" has no conversation

  Scenario: Two likes of the same day make one match, whichever comes second
    Given "A" and "B" are in each other's round today
    When "A" likes "B", then "B" likes "A"
    Then the second answer names the match, and the first like again names the same one

  Scenario: Two likes at the same moment make exactly one match
    Given "A" and "B" are in each other's round today
    When both like each other at once
    Then one waits for the other, and there is exactly one conversation between them

  Scenario: A like that made a match is final
    Given "A" and "B" liked each other today
    When either changes their like to a pass
    Then it is refused as match_made, and the like and the conversation stay

  Scenario: A like taken back before the other's makes no match
    Given "A" and "B" are in each other's round today
    When "A" likes "B" and takes it back, then "B" likes "A"
    Then no match is made

  Scenario Outline: A like makes a match with a like that has not expired
    Given "B" liked "A" <days> days ago, and "B" is in "A"'s round today
    When "A" likes "B"
    Then <outcome>

    Examples:
      | days | outcome                     |
      | 13   | the answer names a match    |
      | 14   | the answer has no match     |

  Scenario: A match nobody writes in is put away after silent_match_archive_days, and a message keeps it
    Given "A" and "B" matched, and "C" and "D" matched, eight days ago
    And "C" wrote to "D" yesterday
    When the night puts silent conversations away
    Then the match of "A" and "B" is archived, and that of "C" and "D" is not

  # A second match (ADR-062 §7): a like falls on no old conversation, and a pair
  # has one conversation they can write in.

  Scenario: A second match opens a new conversation, and closes the one left archived
    Given "A" and "B" have an archived conversation past its clock, and "B" liked "A" yesterday
    When "A" likes "B"
    Then the answer names a new conversation, and the archived one is closed as an unmatch

  Scenario: A second match after a closed conversation leaves that one as it ended
    Given "A" and "B" have a closed conversation past its clock, and "B" liked "A" yesterday
    When "A" likes "B"
    Then the answer names a new conversation, and the old one keeps how it ended

  Scenario Outline: A like falls on no old conversation it did not make
    Given "A" and "B" have a <ended> conversation past its clock, and "B" has not liked "A" again
    When "A" likes "B"
    Then the answer has no match, and the like may be taken back

    Examples:
      | ended    |
      | closed   |
      | archived |

  Scenario: A like that made a match today stays final after the conversation ended
    Given "A" and "B" matched today, and one of them ended the conversation
    When either changes their like to a pass
    Then it is refused as match_made

  # The your-turn limit (ADR-062 §5; the maintainer, 01/11/2026): a conversation
  # is a person's turn when the last thing said in it came from the other, and a
  # match where nothing has been said is both people's. With your_turn_limit on
  # their turn a person makes no new match, and nothing else stops: which
  # conversations count is features/chat's.

  Scenario Outline: A new like at the your-turn limit is refused, whatever the card
    Given <waiting> conversations are on "A"'s turn, and "B" is in "A"'s round today on <card>
    When "A" chooses <choice>
    Then the answer is <answer>

    Examples:
      | waiting | card             | choice | answer          |
      | 8       | an ordinary card | a like | your_turn_limit |
      | 8       | an ordinary card | a fish | your_turn_limit |
      | 8       | a liked-you card | a like | your_turn_limit |
      | 8       | a liked-you card | a fish | your_turn_limit |
      | 8       | a fish card      | a like | your_turn_limit |
      | 7       | an ordinary card | a like | recorded        |
      | 7       | an ordinary card | a fish | recorded        |
      | 7       | a liked-you card | a like | recorded        |

  Scenario: The refusal at the your-turn limit says nothing of the other person
    Given 8 conversations are on "A"'s turn, "B" liked "A", "C" did not, and "D" no longer fits
    When "A" likes each of the three cards
    Then each answer is the same your_turn_limit, and nothing is written

  Scenario: Neither a pass nor a skip is refused at the your-turn limit
    Given 8 conversations are on "A"'s turn, and "B" and "C" are in "A"'s round today
    When "A" passes "B" and skips "C"
    Then both are recorded

  Scenario: The your-turn limit lets a like go that is standing already
    Given "A" liked "B" and made a fish of "C" today, and 8 conversations are on "A"'s turn since
    When "A" likes "B" again and makes "C" a like
    Then both are answered, and nothing is refused

  Scenario: Only a new like makes a match, so a like made a fish opens nothing
    Given "A" liked "B" today, and "B" liked "A" while shadow-banned, which made no match
    When the ban is lifted, and "A" makes the like a fish
    Then the fish is recorded, and no conversation opens

  Scenario: A your_turn_limit of 0 is off
    Given your_turn_limit is 0, 8 conversations are on "A"'s turn, and "B" is in "A"'s round today
    When "A" likes "B"
    Then the like is recorded

  Scenario: A liked-you card keeps its two weeks at the your-turn limit
    Given 8 conversations are on "A"'s turn, and "B"'s like of yesterday is in "A"'s round today
    When "A" is refused the like back, answers a conversation, and likes "B" again
    Then the like back makes the match

  Scenario: The read and every decision say how many conversations are on the person's turn
    Given 2 conversations are on "A"'s turn, and "B" who liked "A" is in "A"'s round today
    When "A" reads the queue and likes "B"
    Then the read says two, and the answer three, the new match being nobody's word yet
