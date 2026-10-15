# features/safety/feedback.feature
Feature: Feedback from inside the app
  A person sends a bug, an idea, a complaint or praise in a few lines, and
  the moderators read it in their panel with the app's version, the platform
  and the language the app read (#171, ADR-023). The text reaches no log
  line and no research event; the event carries the kind alone. At most
  matching_config.feedback_per_day a day per account, the Finnish calendar
  day, and a refusal is said in words. The rows are the person's: in the
  export, gone with the account (features/identity/erasure.feature).

  Scenario Outline: Feedback of each kind lands with the build, and its text in no log line
    Given a signed-in person on <platform> in <locale>
    When they send <kind> feedback
    Then a row holds the kind, the text, the app's version, the platform and the locale, unhandled
    And no log line carries the text

    Examples:
      | kind      | platform | locale |
      | bug       | ios      | fi     |
      | idea      | android  | sv     |
      | complaint | web      | en     |
      | praise    | ios      | en     |

  Scenario: The sixth send of a day is refused in words
    Given matching_config allows five a day
    When the person sends five times and once more
    Then the first five are stored and the sixth is refused with 429 feedback_budget_exceeded and Retry-After until midnight
    And another person's day is their own

  Scenario: The research event carries the kind alone
    Given a person with the research consent and one without
    When each sends feedback
    Then one feedback_sent event holds the kind and nothing of the text, and the other leaves none

  Scenario: The panel lists what waits, a bug first and praise last
    Given feedback of every kind, the praise oldest
    When a moderator lists the feedback
    Then the bug comes first and the praise last, oldest first within a kind, and a handled row is not listed

  Scenario: Marking feedback handled is an audit row, once
    Given unhandled feedback
    When a moderator marks it handled
    Then the row says when and by whom, audit_log has feedback.handle on it, and a second marking is refused

  Scenario: Feedback refuses without a session, and the panel refuses a member
    When nobody or a staff token sends feedback, or a member or a researcher calls the panel's routes
    Then the answer is 401, or 403 for the researcher
