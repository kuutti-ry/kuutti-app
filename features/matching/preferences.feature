# features/matching/preferences.feature
Feature: The hard preferences of onboarding
  Whom a person seeks and the age window are hard filters (rule 7, TD-11):
  rows of mode hard the round builder joins for both parties, never crossed
  in either direction. Onboarding writes them (#46). Whom one seeks is an
  article 9 answer: it is saved only with the sensitive-answers consent of
  the current wording (ADR-019 §4, ADR-010 §16). The deal-breakers over
  profile fields (#149, TD-16) are hard rows of the same table on a whitelist
  of fields, at most deal_breakers_max of them, each only on a field the
  person answered themselves: a filter on what one will not say about
  oneself is the one-sidedness the design document targets. Taking the own
  answer back pauses the filter, which is read, never stored. #87 applies
  them in the pool, both ways.

  Scenario Outline: The hard rows refuse what matching cannot use
    Given a signed-in account
    When it sets seeks <seeks> and an age window from <min> to <max>
    Then the answer is 400 and nothing is stored

    Examples:
      | seeks       | min | max |
      | none        | 25  | 35  |
      | women       | 17  | 35  |
      | women       | 25  | 100 |
      | women       | 35  | 25  |
      | women,women | 25  | 35  |

  Scenario: Seeks and the age window are stored as hard rows and read back
    Given a signed-in account
    When it sets seeks and an age window
    Then two rows of mode hard exist and the read answers the same values

  Scenario: Whom one seeks and the age window are saved one at a time
    Given a signed-in account
    When it sets whom it seeks alone, then the age window alone
    Then each is stored when it is sent and the other stays as it was, and an update naming neither is refused

  Scenario Outline: Whom one seeks needs the consent of the current wording
    Given a signed-in account whose sensitive-answers consent is <consent>
    When it sets whom it seeks and an age window
    Then the answer is 403 consent_required and neither is stored

    Examples:
      | consent                    |
      | never given                |
      | given for an older wording |
      | withdrawn                  |

  Scenario: The age window needs no consent
    Given a signed-in account without the sensitive-answers consent
    When it sets an age window alone
    Then the window is stored

  Scenario: A save of whom one seeks that waited behind a withdrawal stores nothing
    Given an account with the consent, whose withdrawal holds the account row
    When a save of whom it seeks waits for that lock and then runs
    Then it is refused and no answer is left with no consent on record

  Scenario: The preferences of another account are never served
    Given two accounts, one with preferences set
    When the other reads its preferences
    Then it sees nothing set

  Scenario: Whom one seeks can be changed as often as one wishes
    Given a signed-in account that set seeks and an age window
    When it changes whom it seeks, and again, and again
    Then every change is stored, and no status says from when another is possible

  Scenario: A change of gender is possible once in the cadence
    Given a signed-in account that declared a gender
    When it declares another, and another again within the cadence
    Then the first change is stored, the second is refused as change_too_soon, the same gender again passes, and the onboarding status says from when

  Scenario Outline: A deal-breaker the rule refuses is not stored
    Given a signed-in account that answered how it smokes, whether it has kids and its height
    When it sets <what>
    Then the answer is <status> and no deal-breaker is stored

    Examples:
      | what                                              | status |
      | one more deal-breaker than the config allows      | 400    |
      | a deal-breaker on a field outside the whitelist   | 400    |
      | a deal-breaker on a field it has not answered     | 409    |
      | a deal-breaker accepting an answer the field has not | 400 |
      | the same field twice                              | 400    |
      | a deal-breaker on height accepting no relation of height | 400 |
      | a deal-breaker on height accepting two relations  | 400    |

  Scenario: Deal-breakers are stored as hard rows beside onboarding's and paused while the own answer is missing
    Given a signed-in account with seeks, an age window and answers on smoking and kids
    When it sets a deal-breaker on each, takes its smoking answer back, and answers again
    Then the rows are hard and read back, the smoking one is paused in between and nothing is deleted, onboarding's rows stand, the export carries them, and no accepted answer reaches a log line

  Scenario: A deal-breaker on height is stored as one relation to the person's own height
    Given a signed-in account that answered its height
    When it asks for somebody taller, then somebody shorter, then everyone
    Then each relation is a hard row that reads back as saved, a second one replaces the first, and everyone leaves no row

  Scenario: The deal-breakers of another account are never served
    Given two accounts, one with a deal-breaker set
    When the other reads its deal-breakers
    Then it sees none
