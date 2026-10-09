# features/matching/preferences.feature
Feature: The hard preferences of onboarding
  Whom a person seeks and the age window are hard filters (rule 7, TD-11):
  rows of mode hard the round builder joins for both parties, never crossed
  in either direction. Onboarding writes them (#46); the deal-breakers over
  profile fields are M4.

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

  Scenario: The preferences of another account are never served
    Given two accounts, one with preferences set
    When the other reads its preferences
    Then it sees nothing set

  Scenario: A change of whom one seeks is possible once in the cadence
    Given a signed-in account that set seeks and an age window
    When it changes whom it seeks, and again within the cadence
    Then the first change is stored, the second is refused as change_too_soon, the same answer again and another window of ages pass, and the onboarding status says from when

  Scenario: A change of gender is possible once in the cadence
    Given a signed-in account that declared a gender
    When it declares another, and another again within the cadence
    Then the first change is stored, the second is refused as change_too_soon, the same gender again passes, and the onboarding status says from when
