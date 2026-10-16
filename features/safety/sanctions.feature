# features/safety/sanctions.feature
Feature: Sanctions
  Staff warn, hide, suspend or ban a person with a reason and a note; every
  step is a sanction row and an audit row, and the account's state and the
  identity's standing are settled from the sanctions still open (#307,
  ADR-024). A ban is an admin's; the rest any moderator's.

  Scenario: A ban ends every session and refuses the next bank login
    Given account "A" has two signed-in devices
    When an admin bans "A" for harassment
    Then both devices' next requests answer session_revoked
    And "A"'s next bank login is refused with auth_banned

  Scenario: A suspension refuses the login until its day and the night lifts it
    Given a moderator suspends "A" until 22.10.2026
    When "A" authenticates with their bank on 21.10.2026
    Then the login is refused with auth_suspended until the start of 22.10.2026 in Finland
    When the night runs on 22.10.2026
    Then "A" is active again and the next bank login resumes the account

  Scenario: A shadow-banned person gets the same answers from every route
    Given a moderator shadow-bans "A"
    When "A" reads their onboarding status and exports their data
    Then both say the account is active, with the date it last visibly changed
    And the export lists no sanction while the shadow ban is open

  Scenario: A photo of a sanctioned owner is not served from a shown card
    Given "B" was shown a card of "A" with an approved photo
    When a moderator shadow-bans "A"
    Then "B" is refused the photo's URL, and "A" still gets their own
    When the shadow ban is lifted
    Then "B" is served the photo again

  Scenario: Lifting one of two sanctions settles to what is still open
    Given a moderator shadow-bans "A" and then suspends "A"
    When the shadow ban is lifted while the suspension stands
    And the night ends the suspension
    Then "A" is active, not shadow-banned

  Scenario: A sanction on a person on a break keeps the break
    Given "A" is on a break
    When a moderator shadow-bans "A" and lifts it again
    Then "A" is still paused and the next bank login says welcome back

  Scenario: A shadow ban set before the profile is finished holds from the activation
    Given account "A" is still registered
    When a moderator shadow-bans "A" and "A" finishes the profile
    Then "A" is shadow-banned and the onboarding status says active

  Scenario: A review is by somebody other than who applied the sanction
    Given moderator "M" suspended "A"
    When "M" looks at the suspension again
    Then it is refused with own_sanction
    When moderator "N" looks at it again and lifts it
    Then the suspension is lifted with N's note and "A" can sign in

  Scenario: A ban is an admin's, and so are its lift and review
    Given moderator "M" and admin "D"
    When "M" bans "A" or lifts a ban
    Then the route answers 403 admin_forbidden and nothing is written
    When "D" bans "A"
    Then the ban is written with D as its author

  Scenario: A ban binds an erased account's identity
    Given "A" deleted their account
    When an admin bans "A"'s erased account
    Then the identity is banned and the tombstone stays deleted
    And a warning or a suspension of the tombstone is refused with account_deleted

  Scenario: Every sanction step writes the audit log before it happens
    Given a moderator applies, lifts and reviews sanctions on "A"
    Then each step is one audit row with the account as its subject
    And a step that is refused leaves no audit row

  Scenario: The note reaches no log line and no error
    Given a moderator suspends "A" with a note
    Then no log line of the request carries the note
