# features/identity/erasure.feature
Feature: Account deletion per the erasure table
  Deleting an account removes what the product holds about the person and
  keeps what the rules say to keep (TD-7, rules/db.md): the identity row with
  one more deletion and a cooldown, the audit log, staff rows. Export gives the
  person everything Kuutti holds about them, before or instead of deleting.

  Scenario: Deleting the account removes its sessions, login attempts, photos, review rows and fetch log
    Given "A" is signed in on two devices with two photos, one of them reviewed, and has fetched a photo
    When "A" deletes the account
    Then no session, login attempt, photo, review row or fetch log entry of "A" remains
    And the objects of the photos are gone from the bucket

  Scenario: The account row stays as an anonymised tombstone and the identity counts the deletion
    Given "A" deletes the account
    Then the account is deleted with a deletion time and no year or month of birth
    And the identity row has one more deletion and a cooldown of thirty days

  Scenario: A photo another account also uploaded keeps its objects
    Given "A" and "B" uploaded the same picture
    When "A" deletes the account
    Then "A"'s row is gone and the objects stay for "B"

  Scenario: Deletion needs the confirmation and only touches the caller
    Given "A" and "B" have accounts and photos
    When "A" deletes without confirming
    Then nothing changes
    When "A" deletes with confirmation
    Then "B"'s account, sessions and photos are untouched

  Scenario: Every token of a deleted account stops working
    Given "A" deletes the account
    When any of "A"'s tokens is presented
    Then the answer is 401

  Scenario: A request that outlived the deletion writes nothing for the erased account
    Given "A" deletes the account while an upload, a photo fetch or a login exchange is in flight
    When those requests reach their inserts
    Then no photo, fetch log entry or session is written for the erased account

  Scenario: The audit log survives the erasure
    Given a moderator has viewed "A"'s photo
    When "A" deletes the account
    Then the audit row about that view remains

  Scenario: The export lists the account, the identity's dates, the devices, the photos with URLs and the fetch log
    Given "A" has a photo that a moderator approved and has fetched it once
    When "A" exports the account
    Then the export carries the account, first-seen and last-login dates, the device, the photo with three URLs and its outcome, and the fetch log
    And nothing about anyone else

  Scenario: The optional e-mail is set, cleared, exported and erased, and reaches no log line
    Given "A" sets an optional e-mail
    Then the export carries it, a malformed one is refused, and no log line of any of it holds the address
    When "A" clears it, or deletes the account
    Then the account holds none

  Scenario: The export works without object storage, with no URLs
    Given the API has no object storage
    When "A" exports the account
    Then the photos are listed with null URLs

  Scenario: Deletion and export refuse without a session
    When nobody or a staff token calls the account routes
    Then the answer is 401

  Scenario: Erasure removes the research_id mapping and keeps the events
    Given "A" gave the research consent and an event was tracked
    When "A" deletes the account
    Then the mapping row is gone and the event row remains, joinable to nobody

  Scenario: The export shows the research enrolment and the events but never the research_id
    Given "A" gave the research consent and an event was tracked
    When "A" exports the account
    Then the export says enrolled, lists the event with its coarse snapshot, and contains no research_id
