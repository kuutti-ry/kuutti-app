Feature: Attempts to break the erasure rules
  TD-7 and ADR-007: erasure removes the person's profile, sessions and stored contacts.
  Each attack has a separate ordinary control that demonstrates the forbidden result is observable.

  Scenario Outline: Erasure attacks cannot keep the person's private rows
    Given the rule's ordinary control and the attack case <case>
    When the attack tries to produce <violation>
    Then that forbidden result is absent
    And the ordinary control demonstrates the same result can be detected

    Examples:
      | case | violation |
      | profile | a profile row survives account erasure |
      | session | a session row survives account erasure |
      | contact | a stored contact survives account erasure |
