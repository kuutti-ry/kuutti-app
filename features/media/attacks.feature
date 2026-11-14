Feature: Attempts to break the media rules
  ADR-006: the profile-photo check refuses definite nudity and photos with no face or several faces.
  Each attack has a separate ordinary control that demonstrates the forbidden result is observable.

  Scenario Outline: Photo check attacks cannot turn a definite refusal into approval
    Given the rule's ordinary control and the attack case <case>
    When the attack tries to produce <violation>
    Then that forbidden result is absent
    And the ordinary control demonstrates the same result can be detected

    Examples:
      | case | violation |
      | nudity | a definite nudity label becomes an approved profile photo |
      | no_face | a profile photo without a face becomes approved |
      | several_faces | a profile photo with several faces becomes approved |
