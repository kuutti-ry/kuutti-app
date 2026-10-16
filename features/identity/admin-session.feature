# features/identity/admin-session.feature
Feature: Staff sessions
  Staff sign in through the same bank login as everyone (TD-1); what makes a
  moderator is a role on their identity, checked server-side on every admin
  route. Eight hours, no refresh, nothing created for a person without a role.

  Scenario: An allowlisted bank login yields an eight-hour admin session with the role
    Given an identity with the moderator role
    When they complete a staff bank login and the panel exchanges the code
    Then an admin session of eight hours answers with the role
    And no account is created

  Scenario: A bank login without a role is refused and nothing is created
    Given a person the database has never seen, or an identity without a role
    When they complete a staff bank login
    Then the browser is sent to the panel with admin_not_allowed
    And no identity, account or session is created

  Scenario: A moderator who cancels at the bank is sent back to the panel, not to the app
    Given a staff login attempt
    When the broker answers access_denied
    Then the browser is sent to the panel with auth_cancelled

  Scenario: A staff code is exchanged once and never as a product code
    Given a staff login has left a one-time code
    When it is exchanged twice, or at the app's exchange route
    Then only the first exchange at the staff route yields a session

  Scenario: An admin session ends after eight hours and has no refresh
    Given an admin session issued eight hours ago
    When it calls an admin route
    Then the answer is session_expired and there is no route to renew it

  Scenario: A role taken away ends the session's access at once
    Given an admin session whose identity lost its role
    When it calls an admin route
    Then the answer is session_revoked

  Scenario: An admin token never opens a product route and a product token never opens an admin route
    Given an admin session and a product session
    Then the admin token is refused by a product route and the product token by an admin route

  Scenario: Logging out ends the admin session
    Given an admin session
    When it logs out
    Then its token no longer answers

  Scenario: A flood of staff logins from one address is refused before anything is written
    Given the sign-in doors take two requests a minute from one address
    When a third staff login starts from that address within the minute
    Then the browser is sent to the panel with auth_rate_limited and the wait
    And no attempt is written and the broker signs nothing
