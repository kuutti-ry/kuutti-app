# features/safety/reports.feature
Feature: Reporting somebody from a card
  A person reports somebody whose card they were shown, with a reason of
  #106's list and, if they like, a few lines for the moderators (#84,
  ADR-030). The report blocks both ways in the same transaction. The
  moderators read it in the panel (#311, #312); the reported person learns
  nothing. The note reaches no log line, error detail or research event. At
  most matching_config.reports_per_day a day per account, the Finnish
  calendar day, and one open report per pair. Kept twelve months from
  filing, whoever of the two is erased meanwhile (features/identity/erasure.feature).

  Scenario Outline: A report from a card lands with its reason, open, and blocks both ways
    Given "A" was shown "B"'s card
    When "A" reports "B" for <reason>, with the note <note>
    Then a report from a card holds the reason and the note, waiting for a moderator
    And a block stands between the two, both ways

    Examples:
      | reason            | note                                       |
      | harassment        | He asked for my WhatsApp in the first line |
      | misrepresentation | none                                       |
      | under_age         | Says she is in year 9 at school.           |
      | commercial_use    | none                                       |
      | scraping          | Asked twenty people the same questions.    |
      | other             | none                                       |

  Scenario: The note reaches no log line, no error detail and no event
    Given "A" gave the research consent and may file one report today
    When "A" files a report with a note, one with a note too long, and one over the day's cap
    Then no log line carries the note, whom it was about or why, and no research event was written

  Scenario: A second report of the same person while one is open writes nothing more
    Given "A" reported "B" and nobody has decided it
    When "A" reports "B" again
    Then the answer is the same, nothing more is written, and the day's count is not spent
    And once a moderator has decided it, a new report is a new row

  Scenario: The sixth report of a day is refused in words and writes nothing
    Given matching_config allows five a day, and "A" reported somebody yesterday
    When "A" reports five people and a sixth
    Then the five are filed and the sixth is refused with 429 report_budget_exceeded and Retry-After until midnight, without a report or a block
    And another person's day is their own

  Scenario: Only somebody whose card the person was shown can be reported
    When "A" reports somebody they were never shown, themselves, or nobody
    Then each is refused alike with 404 and nothing is written

  Scenario: The reported person learns nothing from any route
    Given "A" was shown "B"'s card
    When "A" reports "B"
    Then "B"'s onboarding status, gate and export read as they did before, without a report, a block or "A"
    And "B"'s gate moves only at a night's count, as when anybody leaves a pool

  Scenario: The night prunes reports older than twelve months
    Given reports filed just past and just inside twelve months, open and decided
    When the night prunes
    Then the older ones are gone and the blocks they made stay

  Scenario: Reporting refuses without a session
    When nobody, a token nobody issued, a staff token, an ended session or an expired one reports
    Then the answer is 401 with its code, and nothing is written
