# features/safety/velocity.feature
Feature: Velocity rules
  The half of TD-6's protection against harvesting that notices an account
  taking in other people faster than a person does (#86, ADR-041): URLs of
  other people's photos in the card and full sizes, different people's cards
  served, and reads of the day's round. Each is a rule of ADR-033's seam: a
  shadow ban by nobody, for the reason scraping, on the moderators' list,
  checked after what the request that can trigger it wrote has committed,
  before it answers, and changing no answer. A thumb, a person's own photos and a conversation's photos never
  count. The round's reads are counted in memory, so nothing about them is
  stored. The thresholds are the maintainer's, matching_config rows like every
  other rule's: 30 reads of the round in one minute (21/10/2026), and, with no
  ceiling on cards, 1,500 photos in 60 minutes and 300 different people's cards
  in 10, the alarms that stand instead (01/11/2026, ADR-062 §9).

  Scenario Outline: Other people's photos fetched within the hour shadow-ban the fetcher at the threshold
    Given auto_shadow_ban_photo_fetches is 1500 and auto_shadow_ban_photo_fetches_minutes is 60
    And "A" was handed <earlier> URLs of other people's photos in the card and full sizes in the last 59 minutes
    When "A" fetches one more in the card size
    Then the fetch answers 200 with its URL and "A" is <outcome>

    Examples:
      | earlier | outcome                                                                                  |
      | 1498    | not sanctioned                                                                           |
      | 1499    | shadow-banned by nobody for the reason scraping, by the rule photo_fetches counting 1500 |

  Scenario: Thumbs, the person's own photos and a conversation's photos do not count
    Given auto_shadow_ban_photo_fetches is 1500
    And "A" was handed 1499 URLs in the last hour of other people's thumbs, of their own photos and of photos sent in conversations
    When "A" fetches another person's photo in the card size
    Then "A" is not sanctioned

  Scenario: A fetch as old as the window does not count
    Given auto_shadow_ban_photo_fetches is 1500 and auto_shadow_ban_photo_fetches_minutes is 60
    And "A" was handed one URL of another person's photo exactly 60 minutes ago and 1498 since
    When "A" fetches one more in the card size
    Then "A" is not sanctioned

  Scenario: A thumb is never checked, and the next card is
    Given auto_shadow_ban_photo_fetches is 1500 and "A" was handed 1500 card URLs of other people's photos in the last hour
    When "A" fetches a thumb, and then a photo in the card size
    Then "A" is not sanctioned after the thumb, and shadow-banned by the rule photo_fetches counting 1501 after the card

  Scenario Outline: Reads of the round within a minute shadow-ban the reader at the threshold
    Given auto_shadow_ban_round_reads is 30 and auto_shadow_ban_round_reads_minutes is 1
    And "A" read today's round <earlier> times in the last 59 seconds
    When "A" reads it once more
    Then the read answers 200 with the round as before and "A" is <outcome>

    Examples:
      | earlier | outcome                                                                              |
      | 28      | not sanctioned                                                                       |
      | 29      | shadow-banned by nobody for the reason scraping, by the rule round_reads counting 30 |

  Scenario: A read of the round as old as the window is forgotten
    Given auto_shadow_ban_round_reads is 30 and auto_shadow_ban_round_reads_minutes is 1
    And "A" read today's round 29 times, the first of them exactly a minute before the next
    When "A" reads it once more
    Then "A" is not sanctioned

  Scenario: A read refused over the day's cards is not counted
    Given auto_shadow_ban_round_reads is 30, a ceiling on cards is set in the panel, and "A" has used up the day's cards
    When "A" reads today's round 30 times within the minute
    Then each read answers 429 card_budget_exceeded and "A" is not sanctioned

  Scenario: Cards served counts for nothing while its threshold is zero
    Given an admin set auto_shadow_ban_cards_served to 0
    And "A" was served the cards of 299 people in the last ten minutes
    When "A" reads today's round, which serves the card of one more
    Then "A" is not sanctioned

  Scenario Outline: Cards served within ten minutes shadow-ban the viewer at the threshold
    Given auto_shadow_ban_cards_served is 300 and auto_shadow_ban_cards_served_minutes is 10
    And "A" was served the cards of <earlier> people in the last ten minutes
    When "A" reads today's round, which serves the card of one more
    Then "A" is <outcome>

    Examples:
      | earlier | outcome                                                                                |
      | 298     | not sanctioned                                                                         |
      | 299     | shadow-banned by nobody for the reason scraping, by the rule cards_served counting 300 |

  Scenario: When cards served and the reads are both met, cards served is recorded
    Given auto_shadow_ban_round_reads is 30 within 1 minute and "A" read today's round 29 times in the last 59 seconds
    And "A" was served the cards of 300 people in the last ten minutes, with auto_shadow_ban_cards_served at 300
    When "A" reads it once more
    Then "A" is shadow-banned by the rule cards_served counting 300

  Scenario Outline: A velocity rule writes nothing on a person already out of sight, or on staff
    Given auto_shadow_ban_photo_fetches is 1500 and "A" was handed 1499 URLs of other people's photos in the last hour
    And "A" is <standing>
    When "A" fetches one more in the card size
    Then the fetch answers 200 with its URL and no sanction is written

    Examples:
      | standing                                |
      | shadow-banned by a moderator            |
      | shadow-banned by the round reads rule   |
      | a moderator                             |

  Scenario: Two fetches at the threshold at the same moment shadow-ban the person once
    Given auto_shadow_ban_photo_fetches is 1500 and "A" was handed 1500 URLs of other people's photos in the last hour
    When the photo rule is checked for "A" twice at the same moment
    Then "A" has one shadow ban, by the rule photo_fetches counting 1500

  Scenario: A person a velocity rule shadow-banned gets the answers they got before
    Given a rule shadow-banned "A" at their 1500th fetch of another person's photo
    When "A" fetches the same photo again and reads today's round
    Then every answer is as before the ban

  Scenario: After a reversal only the fetches that follow count
    Given a rule shadow-banned "A" at their 1500th fetch, and a moderator reversed it
    When "A" fetches one more in the card size
    Then "A" is not sanctioned

  Scenario: A velocity ban waits on the moderators' list with its rule, its count and its first fetch
    Given a rule shadow-banned "A" at their 1500th fetch of another person's photo
    When a moderator reads the automatic shadow bans
    Then the list names the rule photo_fetches, the count 1500 and the time of the first counted fetch

  Scenario: No line of a velocity check names a person or carries a fixture
    Given "A" was handed 1499 URLs of other people's photos
    When "A" fetches one more and "B" reads today's round 30 times within the minute, each request carrying the fixtures
    Then the checks' lines carry the rule and its count only, and no line carries a fixture or the photos' owners
