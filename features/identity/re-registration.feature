# features/identity/re-registration.feature
Feature: Re-registration after deletion or ban
  A ban belongs to the identity, not the account (TD-1, TD-7), so deleting
  an account and authenticating again must not clear a sanction.

  Scenario: A banned identity cannot come back
    Given identity "A" has standing "banned"
    When "A" authenticates with their bank
    Then no account is created
    And the refused attempt is recorded on the identity

  Scenario: A suspended identity waits
    Given identity "A" has standing "suspended" until the start of 22.10.2026 in Finland
    When "A" authenticates with their bank
    Then no account is created
    And the refusal names the instant the suspension ends

  Scenario Outline: Deletion cooldown
    Given identity "A" deleted their account <days> days ago
    And identity "A" has standing "ok"
    When "A" authenticates with their bank
    Then account creation is <outcome>

    Examples:
      | days | outcome |
      | 0    | refused |
      | 29   | refused |
      | 30   | allowed |

  Scenario: A person the database has never seen gets an identity first
    Given no identity exists for the person
    When they authenticate with their bank
    Then an identity is created and then an account

  Scenario: An identity with a live account resumes it
    Given identity "A" has standing "ok" and a live account
    When "A" authenticates with their bank
    Then the live account is resumed and no second account is created
