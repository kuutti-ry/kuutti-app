# features/media/moderation.feature
Feature: Photo moderation before anyone else sees a photo
  A dating app without pre-publication photo moderation ships pornography
  and other people's faces within a day (TD-8). The automatic check rejects
  what it is sure of and tells the owner why; what it is unsure of is a
  person's to decide (ADR-006 §2, #206, #253); nothing is ever deleted by a
  machine. Each hard group of labels has two lines, 60 to ask a person and 90
  to decide, as migration 0030 sets them.

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

  Scenario: An upload is checked and the photo leaves pending with what the check saw recorded
    Given an account uploads a photo
    When the automatic check answers
    Then the photo is approved or queued and photo_review holds the labels, the faces and what was flagged

  Scenario: A failing check leaves the photo pending and the nightly sweep tries again
    Given the automatic check fails on an upload
    Then the photo stays pending with no review row
    When the nightly sweep runs after ten minutes
    Then the photo is checked from its stored card variant

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

  Scenario: The automatic check never overwrites a person's decision
    Given a photo a moderator has decided
    When the automatic check runs on it again
    Then the decision and the state stay the person's
