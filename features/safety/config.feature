# features/safety/config.feature
Feature: The tunables in the panel
  Every tunable is a row of matching_config (CLAUDE.md). An admin reads each
  key with its versions and writes a new version with a reason; every reader
  uses it from the next request, and nothing needs a deploy (#304, #305).

  Scenario: A changed tunable holds from the next request
    Given feedback_per_day is 5 and "A" has sent five today
    When an admin changes feedback_per_day to 6 with a reason
    Then "A"'s sixth feedback of the day is accepted

  Scenario: A change is a new version with its reason and who
    Given liked_you_cap is at version 1
    When an admin changes it to 25 with the reason "Smaller ponds first"
    Then version 2 holds 25, by the admin's identity, with that reason
    And version 1 is kept, and the audit log has the change

  Scenario: A change keeps the value's shape
    Given photo_fetches_per_day holds thumb, card and full
    When an admin sends a number, or the object without full
    Then each is refused with config_shape and nothing is written
