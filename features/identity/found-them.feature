# features/identity/found-them.feature
Feature: "Löysin hänet": telling Kuutti you found someone
  A person tells Kuutti they found somebody, and why, from a closed list:
  on Kuutti, elsewhere, another reason (#83, ADR-040; the maintainer,
  21/10/2026). It is an indication and nothing more: nothing in the app
  changes. It feeds the association's one measure of success, an anonymous
  count by Finnish day and reason that names nobody, so it outlives every
  erasure. The account keeps only that it answered, so each counts once,
  and never which reason. A research event carries the reason alone, for
  those who said yes to research.

  Scenario: Telling Kuutti you found someone counts once, by reason, with no name in the count
    Given "A" is signed in
    When "A" tells Kuutti they found someone on Kuutti
    Then the day's count for "on Kuutti" is one, "A" reads that they answered, and no counted row names "A"

  Scenario Outline: Each reason is counted on its own
    Given "A" and "B" are signed in
    When "A" and "B" each tell Kuutti they found someone, "A" <a> and "B" <b>
    Then the day's counts are <here> on Kuutti, <elsewhere> elsewhere and <other> for another reason

    Examples:
      | a         | b         | here | elsewhere | other |
      | here      | here      | 2    | 0         | 0     |
      | here      | elsewhere | 1    | 1         | 0     |
      | other     | elsewhere | 0    | 1         | 1     |

  Scenario: Nothing else changes for the person
    Given "A" is signed in, active, with a conversation with "B"
    When "A" tells Kuutti they found someone elsewhere
    Then "A" is still active and signed in, still in "B"'s view, and the conversation is as it was

  Scenario: A second answer is refused, and counts nothing
    Given "A" told Kuutti they found someone on Kuutti
    When "A" tells Kuutti again, for another reason
    Then it is refused as found_them_answered, and the counts are as they were

  Scenario: The count outlives the person, the account's answer does not
    Given "A" told Kuutti they found someone on Kuutti
    When "A" erases their account
    Then the day's count for "on Kuutti" is still one, and the account's tombstone keeps no answer

  Scenario: The research event carries the reason alone
    Given "A" is in the study
    When "A" tells Kuutti they found someone elsewhere
    Then one found_them event says elsewhere, and nothing else
