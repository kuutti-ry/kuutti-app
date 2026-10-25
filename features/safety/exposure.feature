# features/safety/exposure.feature
Feature: Exposure is budgeted and counted
  Photos of verified people are what a scraper wants (TD-6). Every signed URL
  of a profile photo is a fetch-log row; the day's fetches of a variant are
  counted against matching_config.photo_fetches_per_day in the statement that
  writes the row, and another account's photo is served only from a card the
  account was shown, and never in the full size, which the app asks for only
  of one's own (ADR-056). A photo sent in a conversation is logged with the
  purpose message and never counted (ADR-031 §10, ADR-008). A refusal is said
  in plain words and counted; nobody is limited in silence. The day is the
  calendar day in Finland (#52, ADR-008).

  Scenario Outline: The photo fetch budget of a day
    Given matching_config allows <limit> fetches of the <variant> variant per day
    When the account fetches a URL for the variant <limit> times and once more
    Then the first <limit> answer with a URL and the last with 429 photo_budget_exceeded and Retry-After

    Examples:
      | variant | limit |
      | thumb   | 3     |
      | card    | 2     |
      | full    | 1     |

  Scenario: A refused fetch writes no fetch-log row and is counted
    Given the account has used the day's budget for a variant
    When it fetches the variant once more
    Then photo_access has no row for that fetch and the log carries a refusal with the account, the count and the limit

  Scenario: Retry-After runs until midnight in Finland
    Given the account has used the day's budget for a variant
    When it fetches the variant once more
    Then Retry-After is the number of seconds until the next midnight in Helsinki

  Scenario: The count resets at the day boundary
    Given the account used the whole budget of a variant two days ago
    When it fetches the variant today
    Then a URL is issued

  Scenario: The full variant of a photo the account was not shown is refused
    Given an approved photo of another account that this account was never shown
    When this account fetches its full variant
    Then the answer is 404, nothing is written to the fetch log, and the log carries a refusal with the account and the reason

  Scenario: A photo on a card the account was shown is served
    Given an approved photo of another account on a card this account was shown
    When this account fetches its card and thumb variants
    Then both are issued and written to the fetch log under this account

  Scenario: Another account's photo is never served in the full size, from a shown card too
    Given an approved photo of another account on a card this account was shown
    When this account fetches its full variant
    Then the answer is 404 as for a photo never shown, nothing is written to the fetch log, and the owner is still served it in the full size

  Scenario: A photo shown twice is one shown record
    Given a photo of another account on a card this account was shown
    When the card is served to this account again
    Then card_shown still has one row for this account and the photo

  Scenario: A photo not yet approved is not served from a shown card
    Given a pending photo of another account on a card this account was shown
    When this account fetches its card variant
    Then the answer is 404

  Scenario Outline: A photo held back by moderation is not served from a shown card
    Given a <state> photo of another account on a card this account was shown
    When this account fetches its card and its full variant
    Then both answers are 404, no access row is written, and the owner is still served

    Examples:
      | state    |
      | queued   |
      | rejected |

  Scenario: Fetching the photos of the account itself ignores the shown record
    Given a pending photo of the account itself and no shown record
    When the account fetches its full variant
    Then a URL is issued
