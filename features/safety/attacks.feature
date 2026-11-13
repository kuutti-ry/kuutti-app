Feature: Attempts to break the safety rules
  ADR-030: a card's block or report needs proof the caller was shown its person; nobody can target themselves.
  Each attack has a separate ordinary control that demonstrates the forbidden result is observable.

  Scenario Outline: Card safety attacks cannot invent a person the caller was shown
    Given the rule's ordinary control and the attack case <case>
    When the attack tries to produce <violation>
    Then that forbidden result is absent
    And the ordinary control demonstrates the same result can be detected

    Examples:
      | case | violation |
      | unseen_block | a caller blocks a card they were never shown |
      | unseen_report | a caller reports a card they were never shown |
      | self_block | a caller blocks their own account |
