# features/matching/matches.feature
Feature: Two likes make a match, and the match is a conversation
  A like of somebody whose like of the person stands, within
  like_expiry_days, is a match (#100, ADR-038, TD-13): the conversation is
  opened in the statement of the second like, and the answer names it.
  Neither person learns of a like that was not mutual. A like that is part
  of a match is final, the maintainer's of 20/10/2026; any other like may
  still be taken back until the day ends. A match in which nobody writes
  for silent_match_archive_days is put away by itself, and writing brings
  it back (ADR-031 §8).

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
