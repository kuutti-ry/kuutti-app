# features/safety/automatic-shadow-bans.feature
Feature: Automatic shadow bans
  Three rules take a person out of everyone else's sight at once when their
  behaviour looks like abuse (#105, TD-5, ADR-033): reports by different
  people, first messages faster than a person writes them, and the same
  first message to many. It is only ever a shadow ban, by nobody, for the
  reason other, an audit row with no actor naming its rule, and the person
  learns nothing from any route. A moderator confirms or reverses it from the
  moderators' list within matching_config auto_shadow_ban_review_hours; past
  that it stays, and says Late. A confirmed one may close the reports filed
  before it, one by one. Being blocked counts for nothing. The rule's record
  is its name, a count and two times; message text is compared in memory and
  kept nowhere. The thresholds are the maintainer's of 19/10/2026.

  Scenario Outline: Reports by different people within seven days shadow-ban the reported person at the threshold
    Given auto_shadow_ban_reports is 3 and auto_shadow_ban_reports_days is 7
    And <earlier> other people reported "B" in the last six days
    When one more person reports "B" from their conversation
    Then the report answers 204 and "B" is <outcome>

    Examples:
      | earlier | outcome                                                                      |
      | 1       | not sanctioned                                                               |
      | 2       | shadow-banned by nobody for the reason other, by the rule reports counting 3 |

  Scenario: One person's reports count once, through any account of theirs
    Given auto_shadow_ban_reports is 3
    And "C" reported "B" this week, and again through a later account of theirs
    When "D" reports "B"
    Then "B" is not sanctioned

  Scenario: A report a moderator dismissed does not count
    Given auto_shadow_ban_reports is 3
    And "C" and "D" reported "B" this week, and a moderator dismissed "D"'s report
    When "E" reports "B"
    Then "B" is not sanctioned

  Scenario: A report as old as the window does not count
    Given auto_shadow_ban_reports is 3 and auto_shadow_ban_reports_days is 7
    And "C" reported "B" exactly seven days ago and "D" yesterday
    When "E" reports "B"
    Then "B" is not sanctioned

  Scenario: Being blocked by any number of people counts for nothing
    Given auto_shadow_ban_reports is 3
    And "C", "D" and "E" blocked "B" this week, and "F" reported "B"
    When "G" reports "B"
    Then "B" is not sanctioned

  Scenario Outline: First messages within the hour shadow-ban the sender at the threshold
    Given auto_shadow_ban_first_messages is 20 and auto_shadow_ban_first_messages_minutes is 60
    And "A" opened <earlier> conversations in the last 59 minutes, each with a line of its own
    When "A" opens one more
    Then the send answers 201 as before and "A" is <outcome>

    Examples:
      | earlier | outcome                                                                              |
      | 18      | not sanctioned                                                                       |
      | 19      | shadow-banned by nobody for the reason other, by the rule first_messages counting 20 |

  Scenario: A reply is not a first message
    Given auto_shadow_ban_first_messages is 20
    And twenty people wrote first to "A" in the last hour
    When "A" answers each of them
    Then "A" is not sanctioned

  Scenario Outline: The same first message to five people shadow-bans the sender at the threshold
    Given auto_shadow_ban_same_first_message is 5 within 24 hours
    And "A" opened <earlier> conversations today with "Hei! Katso profiilini ja kirjoita minulle"
    When "A" opens one more with the same words in other case and punctuation, with an emoji
    Then "A" is <outcome>

    Examples:
      | earlier | outcome                                                  |
      | 3       | not sanctioned                                           |
      | 4       | shadow-banned by the rule same_first_message counting 5 |

  Scenario Outline: Only the same letters and digits make the same first message
    Given auto_shadow_ban_same_first_message is 5 within 24 hours
    And "A" opened four conversations today with <earlier>
    When "A" opens one more with <next>
    Then "A" is <outcome>

    Examples:
      | earlier                         | next                                                     | outcome        |
      | a line of words                 | it with other spacing, line breaks and full-width letters | shadow-banned  |
      | a line of words                 | it with one word changed                                 | not sanctioned |
      | a line of words and a number    | it with another number                                   | not sanctioned |
      | "Moi! Mitä kuuluu?"             | "moi mitä kuuluu"                                        | shadow-banned  |
      | a photo with no caption         | a photo with no caption                                  | not sanctioned |

  Scenario: The first message that met a rule is delivered, and the next line is withheld
    Given auto_shadow_ban_first_messages is 20
    And "A" opened nineteen conversations in the last hour
    When "A" opens a twentieth with "C" and writes to "C" again
    Then "C" reads the opener and not the second line, and "A" reads both as sent

  Scenario Outline: A rule writes nothing on a person already out of sight, or on staff
    Given auto_shadow_ban_reports is 3 and two people reported "B" this week
    And "B" is <standing>
    When a third person reports "B"
    Then the report answers 204 and no sanction is written

    Examples:
      | standing                                 |
      | shadow-banned by a moderator             |
      | shadow-banned by the first-messages rule |
      | suspended                                |
      | banned                                   |
      | a moderator                              |

  Scenario: Two reports at the threshold at the same moment shadow-ban the person once
    Given auto_shadow_ban_reports is 3 and three people reported "B" this week
    When the reports rule is checked for "B" twice at the same moment
    Then "B" has one shadow ban, by the rule reports counting 3

  Scenario: A person a rule shadow-banned gets the answers they got before
    Given a rule shadow-banned "A" at their twentieth first message
    When "A" sends again, and reads their conversations, their onboarding and their sanctions as the export lists them
    Then every answer is as before the ban, and the export lists no sanction

  Scenario: An automatic shadow ban is an audit row with no actor, naming its rule
    Given auto_shadow_ban_reports is 3 and two people reported "B" this week
    When a third person reports "B"
    Then one sanction.apply row about "B" has no actor and names the rule reports and its count, and nobody's message

  Scenario: No word of a first message reaches a log line, an event or the rule's record
    Given four of "A"'s first messages today carry the message fixture
    When "A" opens a fifth with it and a moderator confirms the ban
    Then no log line, error answer, event, sanction column or audit detail carries the fixture

  Scenario: A threshold changed in the panel holds from the next report, after its config.change row
    Given auto_shadow_ban_reports is 3 and "C" reported "B" this week
    When an admin changes auto_shadow_ban_reports to 2 with a reason, and "D" reports "B"
    Then "B" is shadow-banned by the rule reports counting 2, and one config.change row names the key and its version

  Scenario: A threshold of zero switches its rule off
    Given auto_shadow_ban_first_messages and auto_shadow_ban_same_first_message are 0
    When "A" opens twenty conversations within the hour with the same line
    Then "A" is not sanctioned

  Scenario: A confirmed automatic shadow ban closes the reports filed before it, one by one
    Given a rule shadow-banned "B" after reports by "C", "D" and "E"
    When moderator "M" confirms it with a note
    Then one sanction.review row by "M" says keep and names the rule, and each report closes as acted on with it in its own decision

  Scenario: An automatic shadow ban nobody confirmed closes no report
    Given a rule shadow-banned "B" after reports by "C", "D" and "E"
    When a moderator closes "C"'s report as acted on with it
    Then the answer is sanction_not_for_report and the report still waits

  Scenario: Reversing an automatic shadow ban shows the person again with what they sent
    Given a rule shadow-banned "B" at their twentieth first message, and "B" wrote to "C" since
    When moderator "M" reverses it with a note
    Then "B" is active, "C" reads the line, and one sanction.review row by "M" says lift

  Scenario: After a reversal only what follows counts
    Given a rule shadow-banned "B" after reports by "C", "D" and "E", and a moderator reversed it
    When "F" reports "B"
    Then "B" is not sanctioned

  Scenario: Past the review deadline the shadow ban stays until a moderator decides
    Given auto_shadow_ban_review_hours is 48 and a rule shadow-banned "B" 49 hours ago
    When a moderator reads the automatic shadow bans and the front page
    Then the ban is still open, listed and counted, with the API's clock and 48 review hours

  Scenario: The list shows the rules' open shadow bans oldest first, and nobody their own
    Given a rule shadow-banned "B" and then "C", and a moderator shadow-banned "D"
    And "M", whom a rule shadow-banned, was made a moderator since
    When "M" reads the automatic shadow bans and the front page
    Then "B" and "C" are listed oldest first and counted, and neither "D" nor "M"

  Scenario: The automatic shadow bans refuse without a session and refuse a researcher
    Given a rule shadow-banned "B"
    When the list is read with no session, an expired one, a revoked one, and as a researcher
    Then the answers are 401 and 403, and nothing is written
