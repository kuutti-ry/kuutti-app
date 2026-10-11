# features/pond/choice.feature
Feature: The pond choice
  A pond is where matching happens (TD-10, TD-13). The list carries both
  Finnish case forms so no client inflects a name (TD-17); the choice is one
  per account and only from the list (#46).

  Scenario: The pond list carries both case forms
    When a signed-in account asks for the ponds
    Then every pond comes with its nominative and inessive name and its parent

  Scenario: A pond is chosen from the list and an unknown id is refused
    Given a signed-in account
    When it chooses a pond from the list, then one that does not exist
    Then the first choice is stored and the second is refused as pond_unknown

  Scenario: The default pond is assigned only while it is the only pond without a parent
    Given two ponds without a parent, one of them named by matching_config.default_pond
    When a registered account reads its onboarding status
    Then no pond is assigned, the pond step is open, and the account chooses one from the list
