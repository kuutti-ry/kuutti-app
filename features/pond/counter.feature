# features/pond/counter.feature
Feature: The pond counter
  The number of a pond: the people who count there, bank-verified accounts with
  that pond as theirs (TD-10), with an active account and a complete profile. It
  is public, so it is coarse on purpose: it is said only where at least k people
  stand behind it, and it moves only once at least k people have come or gone,
  so one person coming or going changes nothing that is said (#54, #581,
  ADR-013). Nothing says that a profile that is not complete exists.

  Scenario: A pond below k publishes no number
    Given a pond with nine finished profiles and k is ten
    When the figures are taken and the counter is read
    Then the pond is listed with no number and no day

  Scenario: Only live accounts with a pond are counted, a shadow-banned one like any other
    Given a pond with nine finished profiles and a shadow-banned one, and beside them a paused, a suspended and a deleted account, one whose identity is banned, and one that has no pond yet, each with a finished profile
    When the figures are taken
    Then the pond's number is ten

  Scenario: A profile that is not complete is not counted
    Given a pond with twenty-five accounts of which ten have a complete profile
    When the figures are taken and the counter is read
    Then the number is ten

  Scenario: The number of a pond moves only once at least k people have come or gone
    Given a pond whose published number is twenty-five
    When nine more people finish their profiles and the figures are taken on the next day
    Then the counter says what it said, day and all
    When one more finishes and the figures are taken on the day after
    Then the number is thirty-five and the day is that day

  Scenario: The accounts are counted at most once a day
    Given a pond whose published number is twenty-five, counted today
    When ten more people finish their profiles and another process counts on the same day
    Then nothing is counted and the counter says what it said
    When the figures are taken on the next day
    Then the number is thirty-five

  Scenario: The figures do not move between two counts
    Given the figures of one day
    When fifteen more people finish their profiles that day
    Then the counter says what it said, until the figures are taken again

  Scenario: The counter answers without a session and names nobody
    When anybody asks for the counter
    Then the answer carries k and every pond, may be cached, and holds no account, no time of day and nothing from a profile

  Scenario: The counter says one number and nothing of gender or of a profile that is not complete
    Given a pond with ten women and ten men with finished profiles and ten people whose profiles are not complete
    When anybody asks for the counter
    Then the pond's number is twenty and the answer holds no other count of people

  Scenario Outline: Whom a finished profile seeks decides its band
    Given a finished profile that seeks <seeks>
    When the figures are taken
    Then it stands in <band>

    Examples:
      | seeks                         | band              |
      | men                           | the men's band    |
      | women                         | the women's band  |
      | women and men                 | the middle band   |
      | women, men and non-binary     | the middle band   |
      | men and non-binary            | the men's band    |
      | women and non-binary          | the women's band  |
      | non-binary people             | no band           |

  Scenario: A finished profile on an older consent stands in no band
    Given two finished profiles that seek men, one with a consent of an older wording and one with none, and one with the current consent
    When the figures are taken
    Then the men's band holds one and the number is three

  Scenario: A finished profile on a withdrawn consent stands in no band
    Given two finished profiles that seek men with the current consent, and one of them has withdrawn it
    When the figures are taken
    Then the men's band holds one and the number is two

  Scenario: Only finished profiles stand in a band
    Given a pond with ten finished profiles and ten that are not complete, all seeking men
    When the figures are taken
    Then the men's band holds ten and the number is ten

  Scenario Outline: The bar is said only when every band is at least k
    Given a pond whose bands hold <men>, <everyone> and <women> finished profiles, and k is ten
    When the figures are taken and a person of the pond asks
    Then the bar is <bar>

    Examples:
      | men | everyone | women | bar                  |
      | 20  | 10       | 20    | 40, 20 and 40 percent |
      | 15  | 15       | 15    | 35, 30 and 35 percent |
      | 20  | 9        | 20    | not said             |
      | 20  | 0        | 20    | not said             |
      | 0   | 20       | 20    | not said             |

  Scenario: The bar does not move with a number that moved by k
    Given a pond whose bar is said
    When ten more people finish their profiles, nine of them in no band, and the figures are taken on the next day
    Then the number has moved and the bar says what it said

  Scenario: The bar moves once k finished profiles have come or gone
    Given a pond whose bar is said and ten people there whose profiles are not complete
    When nine of them finish and the figures are taken on the next day
    Then the bar says what it said
    When the tenth finishes and the figures are taken on the day after
    Then the bar and the number have moved

  Scenario: The bar moves once k people have changed band
    Given a pond whose bar is said
    When ten people there change whom they seek and the figures are taken on the next day
    Then the bar has moved, and everything public stands, the day included

  Scenario: The bar says shares of the caller's own pond and nothing else
    Given a pond whose bar is said
    When a person of the pond asks
    Then they hear its shares, never cached, with no count of any band

  Scenario: Nobody hears a bar without a pond or without a session
    When somebody with no pond asks
    Then the bar is not said
    When somebody asks without a session
    Then the bar is not said

  Scenario: A session that does not stand is refused, not answered as the public
    When somebody asks with a session that does not stand
    Then the answer is refused

  Scenario: The public counter says nothing of whom anybody seeks
    Given a pond whose bar is said
    When anybody asks for the counter
    Then the answer carries no band and no share
