Feature: Attempts to break the identity rules
  TD-7 and features/identity/re-registration.feature: the same bank identity keeps its standing and cooldown.
  Each attack has a separate ordinary control that demonstrates the forbidden result is observable.

  Scenario Outline: Registration attacks cannot discard a standing restriction
    Given the rule's ordinary control and the attack case <case>
    When the attack tries to produce <violation>
    Then that forbidden result is absent
    And the ordinary control demonstrates the same result can be detected

    Examples:
      | case | violation |
      | banned | a banned identity creates a fresh account |
      | suspended | a suspended identity creates a fresh account |
      | cooldown | an identity returns before its deletion cooldown ends |
