# features/identity/attestation.feature
Feature: The app proves it is the app
  A bank login says who signs in, not with what. An iPhone adds Apple's word
  that the real app on a real phone is asking (App Attest, ADR-069): at the
  exchange an attestation of a key the phone made, over the one-time code, and
  at every refresh that key's assertion over the refresh token. A session
  bound to a key is worth nothing to somebody who holds its tokens without the
  phone. Whether an iPhone without an attestation is refused is the
  environment's switch; an Android phone has nothing to bind a session to yet.

  Scenario: An iPhone's attested exchange binds the session to the phone's key
    Given an iPhone has completed a bank login and attested a key over the one-time code
    When the app exchanges the code with the attestation
    Then it receives a session
    And the session keeps the key's public half and a counter of 0

  Scenario: A refused attestation leaves the one-time code unspent
    Given an iPhone holds a one-time code and an attestation made over another code
    When the app exchanges the code with that attestation
    Then the answer is attestation_refused
    And the code is not spent, and a good attestation over it opens the session

  Scenario: An iPhone's exchange without an attestation opens a session bound to nothing
    Given the environment does not require an attestation
    When an iPhone exchanges its code with no attestation
    Then it receives a session with no key

  Scenario: Where an attestation is required an iPhone's exchange without one is refused
    Given the environment requires an attestation
    When an iPhone exchanges its code with no attestation
    Then the answer is attestation_refused
    And the code is not spent, and the same code with its attestation opens the session

  Scenario: Where an attestation is required an Android phone signs in without one
    Given the environment requires an attestation
    When an Android phone exchanges its code with no attestation
    Then it receives a session with no key

  Scenario: A session bound to a key is refreshed with the key's assertion over the refresh token
    Given an iPhone holds a session bound to its key
    When it refreshes with the key's assertion over its refresh token
    Then it receives a new pair
    And the session keeps the assertion's counter

  Scenario: A refresh without an assertion is refused and leaves a bound session as it is
    Given an iPhone holds a session bound to its key
    When somebody refreshes with the refresh token and no assertion
    Then the answer is session_revoked
    And the session is not ended, and the phone's own refresh still works

  Scenario: An assertion's counter never goes back
    Given an iPhone has refreshed with an assertion whose counter is 5
    When it refreshes with a good assertion whose counter is 5 again
    Then the answer is session_revoked
    And a counter of 6 refreshes

  Scenario: A session bound to nothing is refreshed as it always was
    Given a device holds a session with no key
    When it refreshes, with an assertion or without
    Then it receives a new pair
