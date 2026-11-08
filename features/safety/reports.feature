# features/safety/reports.feature
Feature: Reporting somebody from a card or a conversation
  A person reports somebody whose card they were shown, or the other person
  of a conversation (#351, ADR-030 §12), with a reason of
  #106's list and, if they like, a few lines for the moderators (#84,
  ADR-030). The report blocks both ways in the same transaction; from a
  conversation it also freezes a copy of every message for the moderators
  and closes the conversation, and the person blocked can still report it
  for matching_config.report_after_close_days. The
  moderators read it in the panel (#311, #312); the reported person learns
  nothing. The note reaches no log line, error detail or research event. At
  most matching_config.reports_per_day a day per account, the Finnish
  calendar day, and one open report per pair. Kept twelve months from
  filing, whoever of the two is erased meanwhile (features/identity/erasure.feature).
  A report may point at the one photo it is about (#476, ADR-030 §13): a
  photo the other person sent in the conversation, or a photo of the card
  the person was shown; a pointer that does not hold is left out, and the
  answer is the same.

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
    Then "B"'s onboarding status, whether matching is open and export read as they did before, without a report, a block or "A"

  Scenario: The night prunes reports older than twelve months
    Given reports filed just past and just inside twelve months, open and decided
    When the night prunes
    Then the older ones are gone and the blocks they made stay

  Scenario: A report from a card ends the conversation between the two as a block does
    Given "A" was shown "B"'s card, "A" and "B" are in a conversation where "A" shares a contact, and "A" is in another with "C"
    When "A" reports "B" from the card
    Then the conversation with "B" closes as "A"'s block, with no copy, and what "A" shared there ends
    And "B" reads it ended and may still report it, and the conversation with "C" stays open

  Scenario: Reporting refuses without a session
    When nobody, a token nobody issued, a staff token, an ended session or an expired one reports
    Then the answer is 401 with its code, and nothing is written

  Scenario: A report from a conversation copies every message, blocks both ways and closes it
    Given "A" and "B" are in a conversation where each wrote and sent a photo
    When "A" reports "B" from the conversation
    Then the report names the conversation, and its copy is the thread as it stood, both sides' lines and photos, each marked whose
    And a block stands between the two, "A" no longer has the conversation, and "B" reads it ended

  Scenario: The person blocked can still report the conversation within the window, and not after it
    Given report_after_close_days is thirty and "A" blocked "B" from their conversation
    When "B" reports "A" from it on the thirtieth day, and "C" a conversation closed thirty-one days ago
    Then the first is filed with its copy, and the second is refused with 409 report_window_closed and writes nothing

  Scenario: A report from a conversation counts toward the day's cap and one open report per pair
    Given matching_config allows five a day, and "A" reported "B" from their conversation
    When "A" sends the same report again, files four more, and reports "G" from another conversation
    Then the repeat answers 204 and writes nothing, and the last is refused with 429 report_budget_exceeded, without a report, a copy, a block or a close

  Scenario: A second report from a conversation while one is open writes nothing more, whoever is gone meanwhile
    Given "A" reported "B" from their conversation and nobody has decided it
    When "A" sends the report again, and again after "B" deleted the account
    Then each answer is 204, and no report, copy, block or close more is written

  Scenario: The one who blocked cannot report the conversation they no longer see, and learns nothing from the answer
    Given "A" blocked "B" from their conversation
    When "A" reports from it, again after "B" deleted the account, and again after the window
    Then each answer is 404, and nothing is written

  Scenario: Only the conversation's two people can report or block from it
    Given "A" and "B" are in a conversation and "C" is not
    When "C" reports or blocks from it, or anybody names a conversation that does not exist
    Then each is refused with 404 and nothing is written
    And without a session the answer is 401

  Scenario: The night prunes a report's copy, and the photos only it held of an erased sender
    Given "A" reported "B" from a conversation where both sent a photo, and "B" deleted the account since
    When the night prunes the report after twelve months
    Then the copy is gone, "B"'s photo and its objects go with it, and "A"'s photo stays "A"'s

  Scenario: A report from a conversation can point at one photo the other person sent
    Given "A" and "B" are in a conversation where both sent a photo
    When "A" reports "B" from it, pointing at "B"'s photo
    Then the report keeps that line, the copy holds every line as before, and a moderator reads the line pointed at

  Scenario: A pointer that names no photo of the other person's is left out, and the answer is the same
    Given "A" and "B" are in a conversation, and cards "A" was and was not shown
    When "A" reports pointing at their own photo, a text, a photo a shadow ban withheld, a line past the end, or a card's photo never shown or not the person's
    Then each answer is the one without a pointer, the report and the block are written, and no pointer is kept

  Scenario: A report from a card can point at a photo of the card the person was shown
    Given "A" was shown "B"'s card with two photos
    When "A" reports "B", pointing at the second photo
    Then the report keeps that photo, and a moderator sees it on request, one audit row about the report per look

  Scenario: A pointed photo deleted since reads removed for the moderator
    Given "A" reported "B" from a card, pointing at one of "B"'s photos
    When "B" deletes that photo
    Then the report stays, the moderator reads the photo as removed, and asking for it answers 404 and writes nothing
