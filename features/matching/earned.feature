# features/matching/earned.feature
Feature: Earned fish, used by themselves
  An invitation that counts earns fish in the reward ledger, its inviter's and
  the friend's who used it (#107, ADR-044 §8; TD-15), as many as matching_config
  invitation_reward says that night (the maintainer, 22/10/2026 and
  29/10/2026). Fish are all it earns: earned likes went with #503 (the
  maintainer, 31/10/2026). A unit is used by itself on a fish past the week's
  budget, and is given back when that fish changes the same day. The fish a
  unit paid for are left out of the count, so a banked unit never fills the
  budget it was used past. A fish is a like for every other rule, so an earned
  one needs one of the day's likes too.

  Scenario: An earned fish is used once the window's fish are sent, and the next without one is refused
    Given "A" sent a fish earlier this week, has one earned fish, and "A"'s round today holds "B" and "C"
    When "A" sends a fish to "B" and then to "C"
    Then the fish to "B" is sent with the earned fish, and the fish to "C" is refused as fish_budget_exceeded

  Scenario: A fish an earned fish paid for is left out of the window
    Given "A" sent a fish earlier this week with an earned fish, has one more earned fish, and "A"'s round today holds "B"
    When "A" sends a fish to "B"
    Then it is sent with the window's own fish, and the second earned fish is not spent

  Scenario: A fish changed to a like gives its earned fish back
    Given "A" sent a fish earlier this week, has one earned fish, and "A"'s round today holds "B"
    When "A" sends a fish to "B" and changes it to a like
    Then "B" stays liked, and the earned fish is given back

  Scenario: A fish changed to a pass gives its earned fish back
    Given "A" sent a fish earlier this week, has one earned fish, and "A"'s round today holds "B"
    When "A" sends a fish to "B" and changes it to a pass
    Then the earned fish is given back

  Scenario: An earned fish needs one of the day's likes
    Given like_budget_balanced is 1, "A" sent a fish earlier this week, has one earned fish, and "A"'s round today holds "B" and "C"
    When "A" likes "B" and sends a fish to "C"
    Then the fish to "C" is refused as like_budget_exceeded, and the earned fish is not spent

  Scenario: A like made a fish with no likes left spends the earned fish and no like
    Given like_budget_balanced is 1, "A" sent a fish earlier this week, has one earned fish, and "A"'s round today holds "B"
    When "A" likes "B" and makes it a fish
    Then "B" holds the fish, the earned fish is spent on it, and no like is left, as before

  Scenario: A fish on a card that answers a like never spends an earned fish
    Given "A" sent a fish earlier this week, has one earned fish, and "B" who liked "A" is in "A"'s round today
    When "A" sends "B" a fish
    Then it is a like, and the earned fish is not spent

  Scenario: A pass that gives an earned fish back and a fish on another device are taken one after the other
    Given "A" sent a fish earlier this week, sent "C" a fish today with "A"'s one earned fish, and "D" is in the round
    When one device passes "C" while another sends "D" a fish
    Then the second waits for the first, and "D" gets the fish with the earned fish given back
