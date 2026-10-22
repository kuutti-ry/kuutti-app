# features/identity/email-confirmation.feature
Feature: Confirming the optional e-mail by a code
  The optional e-mail (#148, TD-18) is a way for Kuutti to stay in touch,
  never a login. Kuutti confirms it before it is ever used: six digits sent to
  the address, typed in the app (#385, ADR-043). A code works for
  matching_config email_code_minutes (30) and email_code_attempts (3); an
  account is sent at most email_codes_per_day (5) codes a Finnish day. Only
  the code's hash is stored, and neither the address nor the code reaches a
  log line. An unconfirmed address is sent nothing but its code.

  Scenario: A code sent to the address confirms it
    Given "A" has set an address
    When "A" asks for a code and types the six digits of the message
    Then the address is confirmed, the code is gone, and the message named nobody

  Scenario: A new address is unconfirmed, and the code waiting for the old one stops working
    Given "A" has a confirmed address and a code waiting for a second one
    When "A" sets a different address
    Then the address is unconfirmed and the waiting code answers email_code_none

  Scenario: The same address again changes nothing
    Given "A" has a confirmed address
    When "A" sets the same address again
    Then it is still confirmed and nothing is sent

  Scenario: A wrong code counts a try, and the third spends it
    Given a code waits for "A"'s address
    When "A" types a wrong code three times
    Then the first two answer email_code_wrong and each is counted, the third email_code_spent, and the right code no longer works

  Scenario: A code typed after its thirty minutes has expired
    Given a code was sent to "A" thirty minutes ago
    When "A" types it
    Then the answer is email_code_expired and the code is gone

  Scenario: A new code replaces the one that waits
    Given a code waits for "A"'s address
    When "A" asks for another
    Then the first no longer works and the second confirms the address

  Scenario: Five codes a day, the sixth refused until midnight
    Given "A" has been sent five codes today
    When "A" asks for a sixth
    Then the answer is 429 email_code_budget_exceeded with the wait until midnight in Finland, and the next day a code is sent

  Scenario: A send that fails counts nothing and leaves no code
    Given the mail service refuses the message
    When "A" asks for a code
    Then the answer is 503 mail_unavailable, no code waits, and the day's count is unspent

  Scenario: Where no mail is sent, asking for a code answers so
    Given an environment where MAIL is off
    When "A" asks for a code
    Then the answer is 503 mail_unavailable and nothing is written

  Scenario: No code for no address, and none for a confirmed one
    When "A" asks for a code with no address set, and again once it is confirmed
    Then the answers are email_none and email_confirmed, and nothing is sent

  Scenario: The confirmation is exported, and goes with the address and the account
    Given "A" has confirmed an address
    When "A" downloads their data, removes the address, and later deletes the account
    Then the export carries when it was confirmed, the removal unconfirms it, and erasure leaves no code and no send
