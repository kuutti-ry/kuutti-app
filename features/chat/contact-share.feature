# features/chat/contact-share.feature
Feature: Contacts shared in a conversation
  Messages and profiles refuse contact details; this is the one way through
  (#103, ADR-031 §11, the maintainer's decisions of 18/10/2026, Snapchat's of
  28/10/2026). A person keeps up to five pieces in Settings (a phone number,
  WhatsApp, Telegram, Instagram, Snapchat), each in the one form of its kind, and nobody sees them. In an
  open conversation one press shares a piece: the other person sees it at
  once, until its owner stops sharing it, removes or changes it, or the
  conversation closes. No agreement step, no obligation to share back. A
  share is withheld as a message is: across a block, a close, or a shadow
  ban still open when it began or when its piece last changed (ADR-024 §6,
  ADR-030). A value reaches no log line, error detail, event or socket
  frame, and a share's record holds none. The other person opens a shared
  piece at its service or copies it with one press, and nobody hears of
  either (#473, the maintainer's word of 30/10/2026).

  Scenario: A person keeps a contact of each kind in its one form, seen by nobody
    Given "A" keeps no contacts and is in a conversation with "B"
    When "A" keeps a phone number from 0, a WhatsApp number from 00, a Telegram username with its @, an Instagram one in capitals and a Snapchat one with its @ in capitals
    Then each is kept in its one form, the list answers them in the kinds' order, and "B" sees none of them

  Scenario Outline: A contact that is not of its kind is refused in words, and nothing is kept
    When "A" keeps a contact that is <case>
    Then the answer is 400 with <code>, the detail names no value, and nothing is kept

    Examples:
      | case                                         | code              |
      | a phone number with letters in it            | contact_invalid   |
      | a Telegram username of four characters       | contact_invalid   |
      | an Instagram username with two dots in a row | contact_invalid   |
      | a Snapchat username ending with a hyphen     | contact_invalid   |
      | empty                                        | validation_failed |
      | over sixty-four characters                   | validation_failed |
      | of a kind there is none of                   | validation_failed |

  Scenario: A shared contact is seen by the other person at once, and only in that conversation
    Given "A" keeps an Instagram username and is in conversations with "B" and "C"
    When "A" shares it in the conversation with "B"
    Then A's answer shows it shared, "B" sees it there, "C" does not, and nothing asks "B" to share back

  Scenario: Sharing again writes nothing
    Given "A" shares a phone number with "B"
    When "A" shares it again
    Then the answer is the same, one share stands, and one event was written

  Scenario: Stopping, changing or removing a shared contact shows at once on the other side
    Given "A" shares a phone number and a Telegram username with "B"
    When "A" changes the number, stops sharing the Telegram, and removes the number
    Then "B" sees the new number, then no Telegram, then nothing, and keeping the number again shares nothing

  Scenario Outline: A share is refused in words, and nothing is written
    Given "A" keeps a phone number and is in a conversation with "B"
    When "A" shares it <case>
    Then the answer is <status> with <code>, and no share is written

    Examples:
      | case                                  | status | code                |
      | as a kind "A" does not keep           | 409    | contact_not_stored  |
      | in a conversation that closed         | 409    | conversation_closed |
      | to somebody a block stands between    | 409    | conversation_closed |
      | to somebody who deleted their account | 409    | conversation_closed |
      | after blocking "B"                    | 404    | not_found           |

  Scenario: A share brings an archived conversation back
    Given "A" and "B" are in an archived conversation
    When "A" shares a contact there
    Then the conversation is open again

  Scenario: The night counts a share as it counts a message
    Given silent_match_archive_days is seven, "A" shared a contact ten days ago in a conversation opened a month ago
    And another conversation of A's has been silent for twenty days
    When the night runs, "A" shares a contact in the second, and the night runs again
    Then the first night archives both, the share brings the second back, and the second night archives nothing and writes no event

  Scenario: A close ends every share, and a closed conversation shows none either way
    Given "A" and "B" share contacts with each other
    When "A" is banned
    Then neither sees the other's, each sees their own as not shared, every share ended as closed, and stopping one answers as before

  Scenario: A block hides what the blocker shared, and never says so
    Given "A" and "B" share contacts with each other
    When "B" blocks "A"
    Then "A" reads an ended conversation with nothing shared and no word of a block, and "B" no longer has it

  Scenario: A shadow-banned person's share is withheld from the other until the ban is lifted
    Given "A" shares a phone number with "B", then is shadow-banned and shares an Instagram username
    Then "A" sees both shared, and "B" sees only the number
    When the shadow ban is lifted
    Then "B" sees both

  Scenario: A contact changed under a shadow ban is withheld from the other until the ban is lifted
    Given "A" shares a phone number and a Telegram username with "B", then is shadow-banned
    When "A" changes the number and keeps the username again as it was
    Then "A" sees both shared with the new number, and "B" sees only the username
    When the shadow ban is lifted
    Then "B" sees the new number and the username

  Scenario: The contacts of a conversation read alone sign nothing and write nothing
    Given "A" shares an Instagram username with "B", the media configured as on a server
    When "B" reads the conversation's contacts alone, as the phone does on a contacts frame
    Then each answer is what the detail shows, no thumb is signed and no fetch is logged, while one read of the detail logs one

  Scenario: A close that lands while a share is in flight refuses it
    Given "A" is sharing a contact with "B"
    When "A" is banned before the share reads what it decides on
    Then the share is refused with conversation_closed and none is written

  Scenario: A share that lands before a close in flight is ended by it
    Given "A" is being banned
    When "B" shares a contact with "A" before the ban closes their conversation
    Then the share is ended as closed with the conversation, and "A" sees nothing of it

  Scenario: A removal that lands while a share is in flight refuses the share
    Given "A" is sharing a phone number with "B"
    When "A" removes the number before the share holds it
    Then the share is refused with contact_not_stored and none is written

  Scenario: A share that lands before a removal in flight is ended by it
    Given "A" is removing a phone number
    When "A" shares it with "B" before the removal deletes it
    Then the share is ended as removed, and "B" sees nothing

  Scenario: A removal and an erasure of the same person at once never wait for each other in a cycle
    Given "A" shares a phone number with "B", and is removing it on one connection
    When "A" is erased on another connection after the removal held the account and before it deletes the number
    Then the erasure waits for the removal, both commit, and the share is ended as removed

  Scenario: A share, its end, and a keep or a removal of a contact count with the messages of a minute
    Given messages_per_minute is three
    When "A" keeps a phone number, sends a message, shares the number, then stops sharing it, keeps or removes a contact
    Then each after the third is refused with message_budget_exceeded and Retry-After, nothing is written, and the reads are not counted

  Scenario: A conversation the caller is not in, or one that does not exist, answers 404 to a share and its end
    Given "A" and "B" are in a conversation and "C" is not
    When "C" shares a contact there, stops sharing one, or does either in a conversation that does not exist
    Then every answer is 404 and nothing is written

  Scenario: The contact routes refuse without a session
    When nobody, a token nobody issued, or a staff token calls each contact route
    Then the answer is 401

  Scenario: Each share that begins and each the owner takes back is a research event with no kind or value
    Given "A" gave the research consent
    When "A" shares, shares again, stops, shares another, removes it, and a close ends a third
    Then three contact_shared carry the bands of time and messages, two contact_unshared carry nothing, and no kind or value is in any

  Scenario: A change of what is shared reaches both phones as a contacts frame with no value
    Given "A" and "B" are on the socket in their conversation
    When "A" shares a contact, changes it, and removes it
    Then each phone gets a contacts frame for each, naming the conversation only

  Scenario: A change of what is shared reaches no phone across a block, a close or a shadow ban
    Given "A" and "B" are on the socket in their conversation
    When "A" is shadow-banned, or "B" blocks "A", or the conversation closes, and "A" then changes what is shared
    Then "B" gets no contacts frame, and "A" gets one only while the conversation is open between them

  Scenario: No contact reaches a log line, an error detail or an error report
    When "A" keeps a phone number and a username, is refused one, shares one, reads the conversation, and a fault interrupts a keep
    Then no value appears in any log line, error detail or report, and the refusal names the kind

  Scenario Outline: A shared contact opens at its kind's own address
    Given "A" shares <what> with "B"
    When "B" presses <button> beside it
    Then the phone opens <address>

    Examples:
      | what                  | button | address                              |
      | a phone number        | Call   | tel:+358401234567                    |
      | a WhatsApp number     | Open   | https://wa.me/358401234567           |
      | a Telegram username   | Open   | https://t.me/ville_k                 |
      | an Instagram username | Open   | https://www.instagram.com/ville.k/   |
      | a Snapchat username   | Open   | https://www.snapchat.com/add/ville.k |

  Scenario: A contact not in the one form of its kind opens nothing and can still be copied
    Given "A" shares a contact whose value is not in the one form of its kind
    Then "B" sees it as text with Copy beside it and no Open

  Scenario: Copy puts the contact on the phone's clipboard and says so without the value
    Given "A" shares an Instagram username with "B"
    When "B" presses Copy beside it
    Then the value is on the clipboard and the screen says Instagram was copied, with no value in the words

  Scenario: A contact the phone cannot open says so in words, and Copy stays
    Given "A" shares a phone number with "B", on a phone that makes no calls
    When "B" presses Call beside it
    Then the refusal is said in words with no value in them, nothing is logged, and Copy is still there

  Scenario: Opening or copying a contact tells nobody
    Given "A" shares an Instagram username with "B"
    When "B" opens it and copies it
    Then no request leaves B's phone, so "A" learns of neither and nothing counts them
