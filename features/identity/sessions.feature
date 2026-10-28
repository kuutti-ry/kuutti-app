# features/identity/sessions.feature
Feature: Device-bound sessions
  Bank ID is the account (TD-1): there is no password to reset. A device holds
  a short-lived access token and a single-use refresh token; losing a phone is
  answered by one new bank login and "log out everywhere". A phone in use stays
  signed in: each refresh moves the session's end ninety days on, never past a
  year from the bank login (ADR-058).

  Scenario: An exchanged code yields a session that answers as the account
    Given "A" has completed a bank login and holds the one-time code
    When the app exchanges the code
    Then it receives an access token and a refresh token
    And the access token answers as "A"'s account

  Scenario: A refresh rotates both tokens and retires the old ones
    Given a device holds a session
    When it refreshes
    Then it receives a new pair
    And the previous access token no longer answers

  Scenario: A refresh token used twice ends the device's session
    Given a device has refreshed once
    When the retired refresh token is presented again
    Then the answer is session_revoked
    And the pair from the first refresh no longer answers either

  Scenario: An expired access token asks for a refresh
    Given a device's access token has passed its fifteen minutes
    When it calls a protected route
    Then the answer is session_expired
    And a refresh still succeeds

  Scenario: A refresh moves the session's end to ninety days on
    Given a device signed in through the bank eighty-nine days ago
    When it refreshes
    Then it receives a new pair
    And its session ends ninety days after the refresh

  Scenario: A phone left for ninety days signs in through the bank again
    Given a device last refreshed ninety days ago
    When it refreshes
    Then the answer is session_revoked

  Scenario: A year after the bank login even a phone in use signs in again
    Given a device has refreshed every eighty days since its bank login
    When it refreshes a year after the bank login
    Then the answer is session_revoked
    And the refresh before it ended the session at the year, not ninety days on

  Scenario: Logging out this device leaves the other devices signed in
    Given "A" is signed in on two devices
    When the first device logs out
    Then the first device's tokens stop working
    And the second device still answers

  Scenario: Logging out everywhere ends every device's session
    Given "A" is signed in on two devices
    When one device logs out everywhere
    Then neither device answers on its next request

  Scenario: A session of a sanctioned account stops answering
    Given "A" is signed in
    When "A"'s account is banned
    Then the next request answers session_revoked
