# features/matching/earned.feature
Feature: Earned likes and fish, used by themselves
  An invitation that counts earns its inviter units of the reward ledger
  (#107, ADR-044 §8; TD-15), likes or fish as matching_config
  invitation_reward says that night (the maintainer, 22/10/2026). A unit is
  used by itself on a like past the day's budget, or on a fish past the
  window's, and is given back when that decision changes the same day. The
  likes and fish a unit paid for are left out of the counts, so a banked
  unit never fills the budget it was used past. A like back on a liked-you
  or fish card is free and never spends one.

  Scenario: An earned like is used once the day's likes are spent, and the next like without one is refused
    Given like_budget_balanced is 1, "A" has one earned like, and a round was built for "A" today with "B", "C" and "D"
    When "A" likes all three
    Then "B" and "C" are liked, the earned like is spent on "C", and the like of "D" is refused as like_budget_exceeded

  Scenario: A like changed to a pass gives its earned like back
    Given like_budget_balanced is 1, "A" has one earned like, and a round was built for "A" today with "B", "C" and "D"
    When "A" likes "B" and "C", changes "C" to a pass, and likes "D"
    Then "D" is liked, and the earned like is spent on "D"

  Scenario: A like an earned like paid for is left out of the day's count
    Given like_budget_balanced is 2, "A" has one earned like, and a round was built for "A" today with "B", "C", "D" and "E"
    When "A" likes "B", "C" and "D", passes "B", and likes "E"
    Then "E" is liked within the day's likes, and the earned like stays spent on "D"

  Scenario: An earned fish is used once the window's fish are sent, and the next without one is refused
    Given fish_window_days is 7, "A" sent a fish three days ago, has one earned fish, and a round was built for "A" today with "B" and "C"
    When "A" sends a fish to "B" and then to "C"
    Then the fish to "B" is sent with the earned fish, and the fish to "C" is refused as fish_budget_exceeded

  Scenario: A fish an earned fish paid for is left out of the window
    Given fish_window_days is 7, "A" sent a fish yesterday with an earned fish, has one more earned fish, and a round was built for "A" today with "B"
    When "A" sends a fish to "B"
    Then it is sent with the window's own fish, and the second earned fish is not spent

  Scenario: A fish changed to a like gives its earned fish back, and a like made a fish keeps its earned like
    Given like_budget_balanced is 1, fish_window_days is 7, "A" sent a fish three days ago, has one earned like and one earned fish, and a round was built for "A" today with "B" and "C"
    When "A" likes "B", likes "C", makes "C" a fish, and changes "C" back to a like
    Then the earned like stays spent on "C", and the earned fish is given back

  Scenario: A like back on a liked-you card never spends an earned like
    Given like_budget_balanced is 1, "A" has one earned like, and "B" who liked "A" and "C" are in "A"'s round today
    When "A" likes "C" and then "B"
    Then both are liked, and the earned like is not spent

  Scenario: A pass that gives an earned like back and a like on another device are taken one after the other
    Given like_budget_balanced is 1, "A" liked "B" and "C" today, "C" with "A"'s one earned like, and "D" is in the round
    When one device passes "C" while another likes "D"
    Then the second waits for the first, and "D" is liked with the earned like given back
