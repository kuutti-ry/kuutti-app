Feature: Attempts to break the matching rules
  Rule 7 and features/matching/filters.feature: eligibility is mutual, including the other person's choices.
  Each attack has a separate ordinary control that demonstrates the forbidden result is observable.

  Scenario Outline: Pool attacks cannot ignore the other person's hard filters
    Given the rule's ordinary control and the attack case <case>
    When the attack tries to produce <violation>
    Then that forbidden result is absent
    And the ordinary control demonstrates the same result can be detected

    Examples:
      | case | violation |
      | reverse_age | a candidate enters despite the other person's age window |
      | reverse_gender | a candidate enters despite the other person's sought genders |
      | dance_intent | open to either admits somebody seeking only a dance partner |
