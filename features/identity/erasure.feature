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

  Scenario: The export is a zip with the account, the identity's dates, the devices, the photos as files and the fetch log
    Given "A" has a photo that a moderator approved and has fetched it once
    When "A" exports the account
    Then the zip holds the document and the photo's full-size file, and the document carries the account, first-seen and last-login dates, the device, the photo with its file path and outcome, and the fetch log with the export's own read
    And nothing about anyone else

  Scenario: The optional e-mail is set, cleared, exported and erased, and reaches no log line
    Given "A" sets an optional e-mail
    Then the export carries it, a malformed one is refused, and no log line of any of it holds the address
    When "A" clears it, or deletes the account
    Then the account holds none

  Scenario: The export works without object storage, with no photo files
    Given the API has no object storage
    When "A" exports the account
    Then the photos are listed with no file and the zip holds the document alone

  Scenario: The fourth copy of the day is refused until midnight, and the export lists the day's copies
    Given "A" took a copy two days ago
    When "A" exports three times today and once more
    Then the three are answered, each listing its copies, and the fourth is refused with the wait until midnight
    And "B"'s day is "B"'s own

  Scenario: The export requests go with the account
    Given "A" and "B" each took a copy
    When "A" deletes the account
    Then no export request of "A" remains and "B"'s does

  Scenario: The feedback goes with the account, and the export lists it until then
    Given "A" and "B" each sent feedback
    When "A" exports the account
    Then the export lists "A"'s feedback with its kind, the build and whether a moderator read it, and nothing of "B"'s
    When "A" deletes the account
    Then no feedback of "A" remains and "B"'s does

  Scenario: Deletion and export refuse without a session
    When nobody or a staff token calls the account routes
    Then the answer is 401

  Scenario: Erasure removes the research_id mapping and keeps the events
    Given "A" gave the research consent and an event was tracked
    When "A" deletes the account
    Then the mapping row is gone and the event row remains, joinable to nobody

  Scenario: The export shows the research enrolment but never the events or the research_id
    Given "A" gave the research consent and an event was tracked
    When "A" exports the account
    Then the export says enrolled, with the wording's version and the time, lists no event, and contains no research_id
    And the event stays in the table for the researchers

  Scenario: The consent rows go with the account
    Given "A" and "B" gave their consents and "A" withdrew one
    When "A" deletes the account
    Then no consent row of "A" remains and "B"'s are untouched

  Scenario: The cards shown to the person are in the export and go with the account
    Given "A" was shown "B"'s card and "B" was shown "A"'s
    When "A" exports the account
    Then the export lists "B"'s photo as a card shown and nothing of what "B" was shown
    When "A" deletes the account
    Then no card shown to "A" remains, "B"'s photo stays, and the rows about "A"'s photo went with it

  Scenario: A moderator's role and panel session survive the erasure of their own account
    Given "A" is also a moderator with a panel session
    When "A" deletes the account
    Then the role and the panel session remain on the identity

  Scenario: The export carries the identity's standing, the refused attempts, the cooldown, the state change and each device's user agent
    Given "A" deleted once, was refused twice inside the cooldown, and came back on a device that named itself
    When "A" exports the account
    Then the export says so, field by field

  Scenario: The sanctions go with the account, except the open bans and suspensions, and the export lists them without who
    Given "A" has a lifted warning, a lifted suspension and an open ban, and "B" has a warning
    When "A" exports their data and then is erased
    Then the export lists A's sanctions with kind, reason and dates, never who and never the note
    And only A's open ban remains, on the identity, and B's warning is untouched

  Scenario: Reports and blocks outlive the erasure of either person
    Given "A" reported "B" and "C" blocked "A"
    When "A" deletes the account, and then "B" does
    Then the report, its note with it, and both blocks remain

  Scenario: The export lists the reports filed with their outcome and the blocks set, never the other person's id
    Given "A" reported "B" and "C", a moderator acted on the second, and "A" blocked "D"
    And "E" reported "A" and "F" blocked "A"
    When "A" exports the account, in English, Finnish or Swedish
    Then the export lists A's two reports with their reasons, A's own note and what came of them, and A's three blocks by date, in the request's language
    And nothing names "B", "C", "D", "E" or "F", and nothing of E's report or F's block is there

  Scenario: Erasure leaves the counterpart "Deleted user" and the messages, and closes the conversation
    Given "A" and "B" wrote to each other, and "A" wrote once more under a shadow ban still open
    When "A" deletes the account
    Then "B" reads every message "B" could read before, under "Deleted user", in a conversation closed as deleted
    And "A"'s link to it is gone, the withheld message too, and "B" cannot write

  Scenario: The export carries the person's own messages and the counterpart's as a time and a length
    Given "A" and "B" wrote to each other
    When "A" exports the account
    Then each conversation has its opening, its state, "A"'s messages with their words and "B"'s with a time and a length
    And nothing in it is "B"'s account id or "B"'s words

  Scenario: Erasure deletes the person's contacts and ends their shares, keeping the record without a value
    Given "A" keeps two contacts and shares one with "B", and "B" shares one with "A"
    When "A" deletes the account
    Then A's contacts are gone, both shares are ended as closed and kept with no value, and B's own contact stays B's

  Scenario: The export carries the person's stored contacts and their own shares, never the other's
    Given "A" keeps a phone number, shared it with "B" and stopped, and "B" shares an Instagram username with "A"
    When "A" exports the account
    Then the export lists A's stored contacts, and in the conversation A's own share with when and how it ended, and nothing of B's

  Scenario: The photos a report's copy holds outlive their sender's erasure, and leave the conversation
    Given "A" reported "B" from a conversation where both sent a photo
    When "A" deletes the account
    Then "A"'s photo and its objects stay for the copy, and "B" reads "A"'s photo message as removed
