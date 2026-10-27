# features/media/moderation.feature
Feature: Photo moderation before anyone else sees a photo
  A dating app without pre-publication photo moderation ships pornography
  and other people's faces within a day (TD-8). The automatic check rejects
  what it is sure of and tells the owner why; what it is unsure of is a
  person's to decide (ADR-006 §2, #206, #253), and one nobody decided within
  matching_config photo_queue_reject_days the night rejects as not reviewed
  (#376); nothing is ever deleted by a machine. A person may also take down
  a profile photo that was approved, with a reason the owner is told (#477).
  Each hard group of labels has two lines, 60 to ask a person and 90
  to decide, as migration 0030 sets them. A photo sent in a conversation is
  held to the same lines without the face rules, and only what the check is
  sure of is refused: there `queued` is the stored state of a photo
  delivered with no human queue (ADR-031 §10).

  Scenario Outline: Automatic moderation decision
    Given the check found labels <labels> and faces <faces> at thresholds <label_threshold> and <face_threshold>
    Then the outcome is <outcome> with <flagged> flagged and the owner told <reason>

    Examples:
      | labels                                          | faces      | label_threshold | face_threshold | outcome  | flagged                    | reason         |
      | none                                            | 99         | 60              | 90             | approved | nothing                    | none           |
      | Explicit Nudity 97                              | 99         | 60              | 90             | rejected | Explicit Nudity            | nudity         |
      | Explicit Nudity 75                              | 99         | 60              | 90             | queued   | Explicit Nudity            | none           |
      | Exposed Male Genitalia 95                       | none       | 60              | 90             | rejected | Exposed Male Genitalia     | nudity         |
      | Implied Nudity 92                               | 99         | 60              | 90             | rejected | Implied Nudity             | nudity         |
      | Bare Back 98, Exposed Male Nipple 97            | 99         | 60              | 90             | approved | nothing                    | none           |
      | Female Swimwear or Underwear 99                 | 99         | 60              | 90             | approved | nothing                    | none           |
      | Weapons 93                                      | 99         | 60              | 90             | rejected | Weapons                    | violence       |
      | Hate Symbols 91                                 | 99         | 60              | 90             | rejected | Hate Symbols               | other          |
      | Corpses 95                                      | 99         | 60              | 90             | rejected | Corpses                    | other          |
      | Smoking 99, Alcoholic Beverages 98, Middle Finger 97 | 99    | 60              | 90             | approved | nothing                    | none           |
      | Suggestive 45                                   | 99         | 60              | 90             | approved | nothing                    | none           |
      | Suggestive 45                                   | 99         | 40              | 90             | queued   | Suggestive                 | none           |
      | none                                            | none       | 60              | 90             | rejected | no_face                    | no_person      |
      | Explicit Nudity 75                              | none       | 60              | 90             | rejected | Explicit Nudity, no_face   | no_person      |
      | none                                            | 70         | 60              | 90             | queued   | no_face                    | none           |
      | none                                            | 99, 98, 95 | 60              | 90             | rejected | several_faces              | several_people |
      | none                                            | 99, 70     | 60              | 90             | approved | nothing                    | none           |
      | Explicit Nudity 97                              | 99, 98     | 60              | 90             | rejected | Explicit Nudity            | nudity         |
      | Violence 80, Explicit Nudity 61                 | 99         | 60              | 90             | queued   | Violence, Explicit Nudity  | none           |
      | Weapons 95, Explicit Nudity 92                  | 99         | 60              | 90             | rejected | Weapons, Explicit Nudity   | nudity         |
      | unchecked                                       | none       | 60              | 90             | queued   | not_checked                | none           |

  Scenario Outline: Automatic decision on a photo sent in a conversation
    Given the check found labels <labels> and faces <faces> in a photo sent in a conversation
    Then the outcome is <outcome> with <flagged> flagged and the sender told <reason>

    Examples:
      | labels                          | faces      | outcome  | flagged            | reason   |
      | none                            | none       | approved | nothing            | none     |
      | none                            | 99, 98, 95 | approved | nothing            | none     |
      | none                            | 70         | approved | nothing            | none     |
      | Female Swimwear or Underwear 99 | 99         | approved | nothing            | none     |
      | Explicit Nudity 97              | 99         | rejected | Explicit Nudity    | nudity   |
      | Explicit Nudity 75              | none       | queued   | Explicit Nudity    | none     |
      | Weapons 93                      | none       | rejected | Weapons            | violence |
      | Corpses 95                      | none       | rejected | Corpses            | other    |
      | unchecked                       | none       | queued   | not_checked        | none     |

  Scenario: An upload is checked and the photo leaves pending with what the check saw recorded
    Given an account uploads a photo
    When the automatic check answers
    Then the photo is approved or queued and photo_review holds the labels, the faces and what was flagged

  Scenario: A failing check leaves the photo pending and the nightly sweep tries again
    Given the automatic check fails on an upload
    Then the photo stays pending with no review row
    When the nightly sweep runs after ten minutes
    Then the photo is checked from its stored card variant

  Scenario: The check asks the face for what a sighted viewer sees and never for gender, age or emotion
    Given the automatic check looks at a photo
    Then DetectFaces is asked for the box, the quality, a smile, glasses, sunglasses, a beard and a moustache by name, never ALL, GENDER, AGE_RANGE or EMOTIONS
    And DetectLabels is asked for the closed list of settings, scenes and objects by name, never a category
    And an answer that carries gender, age or emotion anyway leaves nothing of them in the description

  Scenario: An approved photo carries its automatic description to the owner's list, the card and the export
    Given the automatic check saw one person outdoors by a lake, smiling in sunglasses, hiking with a dog
    When the owner uploads the photo
    Then the description is kept with the review row and answered with the photo, on the list, on the card and in the export as keys and in words
    And a photo no check has reached, or one the queue-all moderator took, has none

  Scenario: The automatic description goes with the photo and with the account
    Given a photo with an automatic description
    When the owner removes the photo, or deletes the account
    Then no description of it remains

  Scenario: A photo without a face is not accepted, and its owner is told why without a moderator
    Given the automatic check finds no face at all
    When the owner uploads the photo
    Then the photo is rejected as no_person with no person's name on the decision
    And the owner's list says why, and the moderators' queue never sees it

  Scenario: A photo with several people is not accepted, and its owner is told why without a moderator
    Given the automatic check finds two faces above the face threshold
    When the owner uploads the photo
    Then the photo is rejected as several_people with no person's name on the decision
    And the owner's list says why, and the moderators' queue never sees it

  Scenario: An owner asks a person to look at a photo the check rejected, once
    Given the automatic check rejected a photo of the owner
    When the owner asks a person to look
    Then the photo waits in the queue again, marked as appealed, and a second ask is refused

  Scenario: A photo the check was very sure showed nudity offers no appeal
    Given the automatic check rejected a photo with a nudity label at 95 or more
    Then the owner cannot ask a person to look, so no moderator is sent the picture

  Scenario: A person's rejection offers no appeal, and neither does an approved photo
    Given a photo a moderator rejected, and one the check approved
    Then the owner cannot ask a person to look at either

  Scenario: The appeal answers 401 without a session, 404 for another account's photo, 400 for a bad id
    Given a photo the check rejected
    Then nobody but its owner can appeal it

  Scenario: The queue marks a photo with a sensitive label, and one the owner appealed
    Given queued photos with a hard label at its review line, with swimwear, and appealed by the owner
    Then the queue marks the first sensitive, so the panel hides it until asked, and the last appealed

  Scenario: No label name reaches a log line
    Given the automatic check returns a label
    Then the log carries counts and the outcome, never the label's name

  Scenario: Neither a label nor its confidence reaches the owner or a log line
    Given the automatic check returns a label and a tip signal, each with a confidence
    When the owner uploads, lists their photos, reads their profile and exports their data
    Then no answer to the owner and no log line carries a label's name or a confidence, while the review row keeps them for the queue

  Scenario: A moderator approves a queued photo
    Given a queued photo
    When a moderator approves it
    Then the photo is approved, the review names the moderator, and an audit row records it

  Scenario: A moderator rejects a queued photo with a reason and the owner is told
    Given a queued photo
    When a moderator rejects it with a reason
    Then the photo is rejected with that reason, the owner's list shows the reason, and an audit row records it

  Scenario: A rejection needs a reason from the list
    When a moderator rejects without a reason, or with a reason outside the list
    Then the request is refused as invalid and nothing changes

  Scenario: A moderator takes down an approved photo with a reason, and the owner is told
    Given an approved profile photo, and another, that a viewer was shown
    When a moderator rejects the first with a reason
    Then the viewer is served only the second, the owner's list shows the reason with no appeal, the review names the moderator, and an audit row records it
    And no sanction, no check note and no deletion follow

  Scenario: An approved photo takes a rejection only, and one taken down stays down
    Given an approved photo, and one a moderator took down
    When a moderator approves the first, or decides the second again
    Then each is refused as not queued and nothing is written

  Scenario: A photo sent in a conversation is never taken down
    Given a photo the check let through in a conversation
    When a moderator rejects it
    Then the answer is the 404 of no photo and nothing changes

  Scenario: The queue shows queued photos oldest first with what the check saw
    Given three photos, two of them queued
    When a moderator lists the queue
    Then the two queued photos come oldest first with their labels, faces and flags, and the total says two

  Scenario: Staff view a card through a signed URL and every view is audited
    Given a queued photo
    When a moderator asks for its card
    Then a signed URL for the card variant is issued and audit_log has a photo.view row naming the moderator

  Scenario: A researcher may not touch the photo queue
    Given a session with the researcher role
    When it lists the queue, views a card or decides
    Then every answer is admin_forbidden and nothing is written

  Scenario: The photo routes for staff refuse a product session and no session
    When a product session or nobody calls the staff photo routes
    Then every answer is 401 and nothing is written

  Scenario: A photo nobody decided within photo_queue_reject_days is rejected as not reviewed
    Given photo_queue_reject_days is 14 and two photos have waited in the queue for 15 days
    When the night runs
    Then both are rejected as not_reviewed with no appeal, their review rows name nobody, and the owner's list says why

  Scenario: The limit counts an appealed photo from its appeal, and leaves every other photo alone
    Given photo_queue_reject_days is 14, queued photos either side of it by a minute, one appealed 3 days ago
    And old photos pending, approved, rejected, and one sent in a conversation
    When the night runs
    Then only the one past fourteen days by a minute is rejected

  Scenario: A moderator's decision and the night's limit on one photo: the first one stands
    Given two photos 20 days in the queue, one of which a moderator approves before the night
    When the night runs and a moderator then decides the other
    Then the first stays approved, and the second stays rejected as not_reviewed with the decision refused

  Scenario: photo_queue_reject_days at 0 switches the limit off
    Given photo_queue_reject_days is 0 and a photo has waited 400 days
    When the night runs
    Then the photo stays queued until the number is set again

  Scenario: The automatic check never overwrites a person's decision
    Given a photo a moderator has decided
    When the automatic check runs on it again
    Then the decision and the state stay the person's
