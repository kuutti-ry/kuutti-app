Feature: Attempts to break the chat rules
  ADR-031: an ended conversation keeps its readable history but accepts no new messages or contact shares.
  Each attack has a separate ordinary control that demonstrates the forbidden result is observable.

  Scenario Outline: Conversation attacks cannot write past a close or block
    Given the rule's ordinary control and the attack case <case>
    When the attack tries to produce <violation>
    Then that forbidden result is absent
    And the ordinary control demonstrates the same result can be detected

    Examples:
      | case | violation |
      | closed_message | a message is sent after an unmatch |
      | blocked_message | a message is sent after the counterpart blocks the sender |
      | closed_share | a stored contact is newly shared after an unmatch |
