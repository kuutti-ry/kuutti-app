# features/identity/pause.feature
Feature: Taking a break
  A person can step away from Kuutti without deleting anything (#170, ADR-022):
  the profile leaves everybody's view, every device is signed out, and the next
  bank login brings everything back as it was. Nothing is erased; the erasure
  table (erasure.feature) is the only delete. That a paused account is in no
  pool and no counter is held by pond/opening.feature and pond/waitlist.feature.

  Scenario: Taking a break hides the profile, ends every session and erases nothing
    Given "A" is active on two devices with a profile, a photo, preferences and consents
    When "A" takes a break
    Then the account is paused with its former state kept aside
    And every session of "A" is ended and none of "A"'s tokens answers
    And the profile, the photo, the preferences and the consents are as they were

  Scenario: The next bank login resumes a paused account as it was
    Given "A" took a break
    When "A" authenticates with their bank
    Then the account is active again, the login says it ended a break, and no second account is created

  Scenario: A shadow ban survives a break without showing
    Given "A" is shadow-banned and takes a break
    When "A" comes back
    Then the account is shadow-banned again and the break answered like anybody's

  Scenario: An account still in onboarding cannot take a break
    Given "A" has not finished onboarding
    When "A" takes a break
    Then the answer is not_active and nothing changes

  Scenario: Taking a break needs the confirmation and only touches the caller
    Given "A" and "B" are active
    When "A" takes a break without confirming
    Then nothing changes
    When "A" takes a break with confirmation
    Then "B"'s account and sessions are untouched

  Scenario: A break and its end are noted for research without a reason
    Given "A" gave the research consent
    When "A" takes a break and comes back after three days
    Then an account_paused event and an account_resumed event of three days exist, and neither carries text
