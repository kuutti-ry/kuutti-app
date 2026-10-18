# features/chat/photos.feature
Feature: A photo in a message
  A photo from the phone's library, sent in a conversation (#350): small in
  the thread, full on a tap, with a few words under it if the sender wants,
  seen by the two of them and nobody else. It goes through the profile
  photo's pipeline (rule 4) with the purpose `message`, and the automatic
  check reads it before anything is stored: what the check is sure of is
  refused in words, what it is unsure of is delivered, and no person is asked
  about a private photo. One request uploads and sends.

  Scenario: A photo goes through the pipeline and reaches the conversation, small and full, for its two people only
    Given "A" and "B" have a conversation
    When "A" sends a photo with a caption
    Then the message carries the photo, its thumb and full size signed for A, the caption as its body
    And the store holds the three variants, re-encoded without the picture's EXIF, and no original
    And B's page carries the photo signed for B, and a third account's is a 404

  Scenario: A photo the check is sure of is refused in words, and nothing is stored
    When "A" sends a photo the check is sure shows nudity, violence, or something disturbing
    Then each is refused with its own code, and no object, photo or message is stored, only the check's note

  Scenario: A photo the check is unsure of is delivered and asks nobody, and one no check saw only on a developer's machine
    When "A" sends a photo the check is unsure of, and one where no check runs
    Then the first is delivered, kept out of the moderators' queue and its count
    And the second is delivered on a developer's machine or in a test, and refused as busy anywhere else

  Scenario: The day's tries are counted, refused ones included
    Given "A" has tried the day's sends, each refused
    When "A" tries one more
    Then it is refused with a wait, before any picture is read

  Scenario: A check that cannot run refuses the photo for now
    When the check fails as "A" sends a photo
    Then the send is refused as busy with a wait, and nothing is stored

  Scenario: The day's photos are counted, and the next one is refused until midnight
    Given "A" has sent the day's photos
    When "A" sends one more
    Then it is refused with the wait until midnight in Finland, before any picture is read, and nothing is stored

  Scenario: A resend with the same id stores one photo and one message
    When "A" sends a photo, and sends it again with the same client id
    Then the second answer is the first message, and one photo and one message are stored

  Scenario: The caption follows the text's rules, before any picture is read
    When "A" sends a photo with a caption too long, or with a phone number
    Then each is refused in words, and the picture was never processed

  Scenario: A closed conversation takes no photo, and nothing is stored
    When "A" sends a photo after the conversation closed, after a block either way, or after B deleted the account
    Then each is refused as closed, or not found for the one who blocked, and nothing is stored

  Scenario: A message photo is nobody's profile photo, and a profile photo never a message's
    Given "A" has sent a photo in a conversation
    Then it is not on A's photos screen, A's card, the conversation's thumb or the moderators' queue
    And the photo routes answer 404 for it: its URL, its caption, its appeal, its deletion

  Scenario: Fetches of a message photo are logged and never spend the day's budget
    Given "B" reads a page with A's photo three times within five minutes
    Then the same URLs come each time, logged once as a message photo's
    And B's card thumbs are counted as before, the photo's fetches none of them
    And in the next five minutes the photo has new URLs, logged again

  Scenario: The sender's erasure leaves the photo removed for the other, and its objects go
    Given "A" has sent a photo to "B"
    When "A" deletes the account
    Then B's page shows the message with its caption and no photo, and the store holds none of its objects

  Scenario: The erasure's hold keeps only what it names, and nothing names a photo yet
    Then an erasure keeps no photo by default, and keeps a photo it is asked to with its objects

  Scenario: The export carries the person's own photos and the counterpart's as a kind, a time and a length
    Given "A" and "B" have each sent a photo with a caption
    When "A" asks for the export
    Then A's own photo is a line with its caption and its file in the zip, and B's a line with a kind, a time and a length
    And of a long history, only the newest hundred photos' files go in the zip

  Scenario: A photo arrives over the socket without its URLs, and the page signs them
    Given "B"'s phone is on the socket
    When "A" sends a photo
    Then B's phone gets the message with the photo and no URLs, and B's page then carries them
