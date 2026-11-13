Feature: Attempts to break the notifications rules
  ADR-055: match pushes respect quiet hours, notification choices and the life of the device's session.
  Each attack has a separate ordinary control that demonstrates the forbidden result is observable.

  Scenario Outline: Push attacks cannot bypass the person's delivery restrictions
    Given the rule's ordinary control and the attack case <case>
    When the attack tries to produce <violation>
    Then that forbidden result is absent
    And the ordinary control demonstrates the same result can be detected

    Examples:
      | case | violation |
      | quiet_hours | a match push is submitted during quiet hours |
      | switched_off | a match push is submitted after the person switches its kind off |
      | expired_session | a match push is submitted to an expired session |
