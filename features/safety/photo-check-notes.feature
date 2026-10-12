# features/safety/photo-check-notes.feature
Feature: A closer look after repeated hard rejections
  The check does not show a photo when it is sure of a hard label (nudity,
  violence, disturbing, hate), and keeps a note of which kind and when. Two
  notes within thirty days make the check stricter for that account for
  thirty days: every hard group rejects from 75 instead of its usual line.
  Nothing else follows; a ban stays a person's decision. The notes keep
  twelve months, go with the account, and only the person reads them, in
  their export (#253, ADR-006 §2, migration 0035 sets the numbers).

  Scenario: A photo the check is sure of leaves a note of its kind
    Given the check finds a hard label at or above its group's reject line
    When the owner uploads the photo
    Then the photo is rejected and a note holds the kind and the time, nothing of the picture

  Scenario: Two notes within thirty days make the check stricter for thirty days
    Given an account with two notes eleven days apart
    When the check finds Explicit Nudity at 80 on its next photo
    Then the photo is rejected instead of waiting for a person
    And thirty days after the second note the same photo waits for a person again

  Scenario: What only the closer look rejected leaves no note
    Given an account under a closer look
    When the check rejects a photo it would have sent to a person on the usual lines
    Then no note is added and the closer look ends when it would have

  Scenario: A photo a person approves on appeal takes its note away
    Given the check rejected a photo and left a note
    When the owner appeals and a moderator approves the photo
    Then the note is gone and counts toward no closer look

  Scenario: The notes go after twelve months, and with the account
    Given notes older and younger than twelve months
    When the nightly prune runs
    Then only the younger ones remain
    And erasing the account removes the rest

  Scenario: The person reads the notes in their export in plain words
    Given an account with notes under a closer look
    When the person downloads their data in Finnish
    Then the export says in Finnish what the check is, each photo's date and reason, and until when it is stricter
