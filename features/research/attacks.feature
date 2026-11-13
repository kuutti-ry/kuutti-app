Feature: Attempts to break the research rules
  Rule 5 and ADR-011: recording an event needs the consent mapping, which withdrawal and erasure remove.
  Each attack has a separate ordinary control that demonstrates the forbidden result is observable.

  Scenario Outline: Research attacks cannot record without a live consent mapping
    Given the rule's ordinary control and the attack case <case>
    When the attack tries to produce <violation>
    Then that forbidden result is absent
    And the ordinary control demonstrates the same result can be detected

    Examples:
      | case | violation |
      | no_consent | an event is recorded before research consent |
      | withdrawn | an event is recorded after research consent is withdrawn |
      | erased | an event is recorded after the account is erased |
