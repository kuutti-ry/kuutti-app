# features/safety/report-queue.feature
Feature: The moderators' report queue
  A moderator picks the next report from a list (#311, TD-5): the reports
  waiting the oldest first, those about one person together, each with its
  reason, where it was made, and both people by account id with how they
  have figured in reports before: how many the reporter filed and how many
  of those were upheld, how many the reported person received and how many
  sanctions they have had. Decided reports are behind a filter, the newest
  decision first. The list shows neither the reporter's words nor anything
  of a conversation; opening a report does, with its audit row (#312). A
  member of staff who is a party to a report, by any account of theirs, is
  not shown it, and it counts in none of their figures (ADR-030 §6).

  Scenario: Reports waiting are listed the oldest first, those about one person together
    Given "A" and "B" reported "X", and "C" reported "Y" between the two
    When a moderator reads the queue
    Then "X"'s two reports come first, the older first, and "Y"'s after them

  Scenario: Each report shows how both people have figured in reports before
    Given "A" filed three reports, one of them upheld, and "X" has had a sanction
    When a moderator reads the queue
    Then "A"'s report about "X" says three filed, one upheld, and one sanction

  Scenario: Decided reports are behind the closed filter, the newest decision first
    Given one report waits and two were decided on different days
    When a moderator reads the closed reports
    Then the two decided ones are listed, the later decision first, with their outcomes

  Scenario: A member of staff who is a party to a report is not shown it
    Given "M", a moderator, reported "X" with an account of theirs, and "Y" reported "M"
    When "M" reads the queue and the front page
    Then neither report is listed or counted for "M", and another moderator sees both

  Scenario: The queue carries nothing of the reporter's words or the conversation
    Given "A" reported "B" from their conversation, with a note
    When a moderator reads the queue
    Then the report is listed, and neither the note nor any message's words are in the answer
