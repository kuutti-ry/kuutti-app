# features/safety/report-decision.feature
Feature: Opening and deciding a report
  A moderator opens one report from the queue (#312, TD-5): the reporter's
  note, both people's histories, and for a report made from a conversation
  its frozen copy (ADR-030 §12), every line said to be the reporter's or the
  reported person's, a photo shown only on request. Each look is an audit row
  about the report, written before anything is shown: conversation.view, or
  report.view for a card's report, and photo.view per photo. The moderator
  dismisses the report, or acts on the person through the sanctions (#307)
  and closes it naming the sanction; report.decide, once. A member of staff
  who is a party to a report, by any account of theirs, gets the answer of a
  report that does not exist (ADR-030 §6). The words of the note and the copy
  reach the answer alone: no log line, error answer or event (rule 5). Nobody
  is told of the decision; the reporter's export says its outcome (§8).

  Scenario: Opening a report from a conversation shows its note and the frozen copy after a conversation.view row
    Given "A" reported "B" from their conversation, with a note
    When a moderator opens the report
    Then the answer carries the note and every message of the copy in order, each said to be the reporter's or the reported person's
    And a conversation.view row about the report names the moderator and neither person

  Scenario: Opening a report from a card shows its note after a report.view row
    Given "A" reported "B" from a card, with a note
    When a moderator opens the report
    Then the answer carries the note and no conversation, and a report.view row about the report names the moderator

  Scenario: A look whose audit row cannot be written sends nothing
    Given "A" reported "B" from their conversation, with a note
    And the audit log refuses the moderator's row
    When the moderator opens the report
    Then the answer is a generic error with no word of the note or the copy, and neither was read

  Scenario: The copy keeps every line, a shadow ban's withheld ones too, after both people are erased
    Given "B" was shadow-banned and wrote to "A", and "A" reported "B" from the conversation
    And "A" and "B" deleted their accounts since
    When a moderator opens the report
    Then every line is there, each said to be the reporter's or the reported person's

  Scenario: A photo of the copy is shown only on request, one photo.view row per look
    Given "B" sent "A" a photo, and "A" reported "B" from that conversation
    When a moderator opens the report and asks for the photo twice
    Then the report carries no address of it, and each answer is the full photo's signed address after its own photo.view row naming the report and the line

  Scenario: A photo the copy holds is shown after its sender's erasure
    Given "B" sent "A" a photo, and "A" reported "B" from that conversation
    And "B" deleted their account since
    When a moderator asks for the photo
    Then its full variant is signed as before

  Scenario: Dismissing closes the report with who and when, and tells nobody
    Given "A" reported "B"
    When a moderator dismisses the report
    Then it is closed as dismissed by that moderator at that time after one report.decide row
    And "A"'s export says dismissed, the block between them stands, and no notice or event is written

  Scenario: Acting names the sanction the reported person was given after the report
    Given "A" reported "B", and a moderator then warned "B"
    When the moderator closes the report as acted on with the warning
    Then it is closed as acted on with it, the report.decide row names it, and "A"'s export says acted on

  Scenario Outline: A sanction that does not answer this report is refused, and nothing is written
    Given "A" reported "B"
    And <sanction>
    When a moderator closes the report as acted on with it
    Then the answer is sanction_not_for_report, the report still waits, and no report.decide row is written

    Examples:
      | sanction                                  |
      | "C" was warned after the report           |
      | "B" was warned before the report was filed |
      | "B" was banned by nobody after the report |
      | "B" came back with another account and was warned there after the report |
      | no sanction has the id                    |

  Scenario: A ban of the reported person's identity through a later account answers the report
    Given "A" reported "B", and "B" deleted that account and came back with another
    And an admin banned the later account after the report
    When a moderator closes "A"'s report as acted on with the ban
    Then it is closed as acted on with it

  Scenario: One sanction closes every report it was given for
    Given "A" and "C" reported "B", and an admin then banned "B"
    When a moderator closes both reports as acted on with the ban
    Then both are closed as acted on with the same ban

  Scenario: Acting without a sanction is refused, and so is dismissing with one
    Given "A" reported "B"
    When a moderator decides it acted on with no sanction, and dismissed naming one
    Then both answers are 400 validation_failed, and the report still waits

  Scenario: A report is decided once, also when two moderators decide it at the same moment
    Given "A" reported "B"
    When two moderators decide it at the same moment, and one of them again afterwards
    Then one decision is written with one report.decide row, and the others are refused with report_decided

  Scenario: A member of staff who is a party to a report gets the answer of a report that does not exist
    Given "M", a moderator, reported "X" with an earlier account of theirs
    And "Y" reported "M" from their conversation
    When "M" opens either report, asks for a photo of its copy, or decides it
    Then every answer is the not_found of an unknown report, nothing is written, and another moderator opens and decides both

  Scenario: The report's routes refuse without a session, and refuse a researcher
    Given a report waits
    When it is opened, its photo asked for and decided with no session, an expired one, a revoked one, and as a researcher
    Then the answers are 401 and 403, and nothing is written

  Scenario: No word of the note or the copy reaches a log line, an error answer or an event
    Given "A" reported "B" from a conversation whose messages, photo caption and note carry the message fixture
    When a moderator opens it, asks for its photo and dismisses it, and a party and a researcher try the same
    Then no log line, error answer or event carries the fixture
