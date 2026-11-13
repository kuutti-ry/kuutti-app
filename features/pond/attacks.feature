Feature: Attempts to break the pond rules
  ADR-060 and features/pond/opening.feature: the pond is open and the person's profile and consents are complete.
  Each attack has a separate ordinary control that demonstrates the forbidden result is observable.

  Scenario Outline: Gate attacks cannot announce matching before its prerequisites
    Given the rule's ordinary control and the attack case <case>
    When the attack tries to produce <violation>
    Then that forbidden result is absent
    And the ordinary control demonstrates the same result can be detected

    Examples:
      | case | violation |
      | closed_pond | a complete person sees matching open in a closed pond |
      | missing_photos | a person without approved photos sees matching open |
      | missing_consent | a person without current special-category consent sees matching open |
