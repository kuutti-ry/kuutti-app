# features/notifications/push.feature
Feature: Pushes say that there is something, never what or from whom
  A phone whose app is closed is told of three things through Expo (#102,
  ADR-055): a message the person may read, a match made by the other's like,
  and today's round while it is not opened. A push is one line of the app's
  own words in the phone's language: never a message's text, a name or an
  account (§1). Who may be told of a message is the chat's rule (ADR-031
  §5): nothing crosses a block or a close, and a shadow-banned sender's
  words reach nobody. Nothing is pushed in the quiet hours, nor of a kind
  the person switched off (ADR-032), and a device's token is its session's.

  Scenario: A message to somebody in the app sends no push
    Given "A" and "B" are in a conversation and "B" has the app open
    When "A" writes to "B"
    Then "B" is sent no push, since the socket delivers the message
    And once "B" has closed the app, "A"'s next message pushes

  Scenario: A message to somebody away pushes once however many follow within the interval
    Given "A" and "B" are in a conversation and "B"'s phone has the app closed
    When "A" writes three messages within message_push_min_interval_minutes
    Then "B"'s phone gets one push, in its language
    And a message after the interval pushes again

  Scenario: A push says that there is a message, never its text, its sender or an account
    Given "A" writes "B" a message that names a place, with "B" signed in on two phones
    When the push goes
    Then each of "B"'s phones gets the app's line and the conversation to open
    And nothing in either names the text, "A", "B", an account or a session

  Scenario: Nothing is pushed across a block or a close
    Given "A" is in conversations that a block either way and an unmatch have ended
    When anybody tries to write in them, or a block or a close lands between a send and its push
    Then nobody is pushed

  Scenario: A shadow-banned sender's message pushes nobody
    Given "A" is shadow-banned and in a conversation with "B"
    When "A" writes to "B"
    Then "B" is pushed nothing
    And "B"'s message to "A" pushes "A" as any message would

  Scenario: Nothing is pushed in the quiet hours
    Given "B" has a phone, a conversation and a round
    When a message, a match or the round would be pushed between push_quiet_from_hour and push_quiet_to_hour in Helsinki
    Then nothing is pushed, and nothing is kept to send later
    And outside those hours each of them pushes

  Scenario: A kind switched off is never pushed
    Given "B" has switched one kind of notification off
    When a message, a match and the round would each be pushed
    Then only the kinds still on are pushed

  Scenario: A match tells the one who liked first, in the app or not
    Given "B" liked "A" yesterday and has the app open
    When "A" likes "B" back
    Then "B" is pushed that there is a new match, with its conversation
    And "A", who sees the match in the answer, is pushed nothing

  Scenario: Today's round is told once to those who have not opened it
    Given rounds for today and yesterday, opened and not, empty, with cards erased or blocked, and owners paused or banned
    When the round's push runs at round_push_hour
    Then only the owners of today's unopened rounds with a card to show are pushed, until midnight
    And a second run tells nobody again

  Scenario: A device's token goes when its session ends
    Given "A" registered a token on each of two phones
    When "A" signs out on one, and then everywhere
    Then the first phone's token goes, and then the other's, and nobody else's
