# features/identity/bank-login.feature
Feature: Bank login through the identification broker
  Every account is a person a Finnish bank has identified (TD-1). The API
  drives the login (the app holds no secret and no ID token), keeps of the
  bank's answer only what rules 1 and 3 allow, and hands the app a one-time
  code for this device's session.

  Scenario: A login starts with the platform recorded and the browser sent to the bank chooser
    Given the app asks for a login for its platform
    Then the attempt is remembered with its state and nonce
    And the browser is redirected to the broker

  Scenario: A first login creates the identity and the account and the code is exchanged once
    Given a person the database has never seen
    When the bank identifies them and the app exchanges the one-time code
    Then an identity with the HMAC of their code and an account with year and month of birth exist
    And the same code exchanged again is refused
    And no fragment of the personal identity code or of a token is in the log
    And the log names the level, the method and the decision of the login

  Scenario: A second login of the same person resumes the live account
    Given a person with a live account
    When they log in again
    Then the same account answers and no second one is created

  Scenario: An unknown state, a used state and a broker failure each send the browser back with a code
    When the broker's return carries an unknown or used state, or the exchange with the broker fails
    Then the browser is sent to the app with auth_state_mismatch or auth_provider_error

  Scenario: A person who cancels at the bank is sent back with auth_cancelled
    Given the broker answers access_denied and no code
    Then the browser is sent to the app with auth_cancelled
    And the attempt cannot be completed later

  Scenario: A return from the bank is answered once, and a failed one is spent too
    Given a login whose return from the bank the broker could not complete
    When the same return comes back again
    Then the browser is sent to the app with auth_state_mismatch
    And the broker is not asked again and nothing is created

  Scenario: An authentication that predates the login attempt is refused
    Given the broker reports an authentication from before the app asked for this login
    Then the browser is sent to the app with auth_provider_error
    And no identity is created

  Scenario: A minor is refused and nothing is stored
    Given the bank identifies a person under 18
    Then the browser is sent to the app with auth_under_18
    And no identity is created

  Scenario: A banned identity is refused and the attempt is counted
    Given identity "A" has standing "banned"
    When "A" logs in
    Then the browser is sent to the app with auth_banned
    And the refused attempt is counted on the identity

  Scenario: A cooling-down identity is refused with the date and gets a fresh account afterwards
    Given identity "A" deleted their account today
    When "A" logs in
    Then the browser is sent to the app with auth_cooldown and the date
    When the cooldown has passed and "A" logs in
    Then a fresh account is created

  Scenario: The exchange validates the code and refuses an unknown one
    When the app exchanges a malformed code
    Then the answer is a validation failure
    When the app exchanges a well-formed code nobody issued
    Then the answer is auth_code_used

  Scenario: Without a broker the login answers 503
    Given no identification broker is configured
    When the app asks for a login
    Then the answer is auth_provider_error with status 503

  Scenario: A preview's login sends the app back with auth_unavailable
    Given a pull-request preview, which never has a broker
    When the app asks for a login
    Then the browser is sent to the app with auth_unavailable

  Scenario: A flood of logins from one address is refused before anything is written
    Given the sign-in doors take two requests a minute from one address
    When a third login starts from that address within the minute
    Then the browser is sent to the app with auth_rate_limited and the wait
    And no attempt is written and the broker signs nothing
    And a login from another address still reaches the broker

  Scenario: At the table's cap a login makes room by ending the oldest unanswered attempts
    Given the table holds as many open login attempts as its cap, none answered by the bank
    When a login starts
    Then the two oldest attempts are gone, the table is one under its cap and the login reaches the broker

  Scenario: At the table's cap a login is refused only when every attempt is back from the bank
    Given the table holds as many login attempts as its cap, each with a code awaiting its exchange or its return under way
    When a login starts
    Then the browser is sent to the app with auth_rate_limited and the wait, and nothing is written
