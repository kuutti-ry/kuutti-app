# features/pond/waitlist.feature
Feature: The waitlist counter
  The waitlist is the people themselves: bank-verified accounts with a pond,
  waiting for matching to open there (TD-10). Its counter is public, so it is
  coarse on purpose: a number is said only where at least k people stand
  behind it, and the numbers of a pond move only once at least k people have
  come or gone, so one person coming or going changes nothing that is said
  (#54, ADR-013).

  Scenario: A pond below k publishes no number
    Given a pond with nine verified people and k is ten
    When the figures are taken and the waitlist is read
    Then the pond is listed with no total, no split, no count of people finishing and no day

  Scenario Outline: The gender split is published only when every cell is at least k
    Given a pond with <women> women, <men> men, <non_binary> non-binary people and <undeclared> who have declared no gender, and k is ten
    When the figures are taken and the waitlist is read
    Then the total is published and the split is <split>

    Examples:
      | women | men | non_binary | undeclared | split     |
      | 12    | 11  | 10         | 0          | published |
      | 12    | 11  | 10         | 10         | published |
      | 12    | 11  | 10         | 4          | hidden    |
      | 12    | 11  | 3          | 0          | hidden    |
      | 12    | 11  | 0          | 0          | hidden    |
      | 12    | 0   | 0          | 0          | hidden    |

  Scenario: Only live accounts with a pond are counted, a shadow-banned one like any other
    Given a pond with nine counted people and a shadow-banned one, and beside them a paused, a suspended and a deleted account, one whose identity is banned, and one that chose no pond
    When the figures are taken
    Then the pond's total is ten

  Scenario: A profile that is not complete counts as finishing
    Given a pond with twenty-five verified people of whom ten have a complete profile
    When the figures are taken and the waitlist is read
    Then twenty-five are verified and fifteen are finishing their profile

  Scenario: The people finishing are counted in public only when they and the rest are none or at least k
    Given a pond with twelve verified people of whom three have a complete profile
    When the figures are taken and the waitlist is read
    Then twelve are verified and the number finishing is not said

  Scenario: The figures of a pond move only once at least k people have come or gone
    Given a pond whose published total is twenty-five
    When nine more people join and the figures are taken on the next day
    Then the waitlist says what it said, day and all
    When one more joins and the figures are taken on the day after
    Then the total is thirty-five and the day is that day

  Scenario: The accounts are counted at most once a day
    Given a pond whose published total is twenty-five, counted today
    When ten more people join and another process counts on the same day
    Then nothing is counted and the waitlist says what it said
    When the figures are taken on the next day
    Then the total is thirty-five

  Scenario: The figures do not move between two counts
    Given the figures of one day
    When fifteen more people join the pond that day
    Then the waitlist says what it said, until the figures are taken again

  Scenario: The waitlist answers without a session and names nobody
    When anybody asks for the waitlist
    Then the answer carries k and every pond, may be cached, and holds no account, no time of day and nothing from a profile

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

  Scenario: Only finished profiles stand in a band
    Given a pond with ten finished profiles and ten people still finishing theirs, all seeking men
    When the figures are taken
    Then the men's band holds ten and the total twenty

  Scenario Outline: The bar is said only when every band is at least k
    Given a pond whose bands hold <men>, <everyone> and <women> finished profiles, and k is ten
    When the figures are taken and a person of the pond asks
    Then the bar is <bar>

    Examples:
      | men | everyone | women | bar                  |
      | 20  | 10       | 20    | 40, 20 and 40 percent |
      | 15  | 15       | 15    | 33, 33 and 33 percent |
      | 20  | 9        | 20    | not said             |
      | 20  | 0        | 20    | not said             |
      | 0   | 20       | 20    | not said             |

  Scenario: The bar does not move with a total that moved by k
    Given a pond whose bar is said
    When ten people join, one of them with a finished profile, and the figures are taken on the next day
    Then the total has moved and the bar says what it said

  Scenario: The bar moves once k finished profiles have come or gone
    Given a pond whose bar is said and ten people there finishing their profiles
    When nine of them finish and the figures are taken on the next day
    Then the bar says what it said
    When the tenth finishes and the figures are taken on the day after
    Then the bar has moved and the total stands

  Scenario: The bar says shares of the caller's own pond and nothing else
    Given two ponds with different bars
    When a person of each pond asks
    Then each hears the shares of their own pond, never cached, with no count, no pond and no day

  Scenario: Nobody hears a bar without a pond or without a session
    When somebody who chose no pond asks
    Then the bar is not said
    When somebody asks without a session
    Then the answer is refused

  Scenario: The public waitlist says nothing of whom anybody seeks
    Given a pond whose bar is said
    When anybody asks for the waitlist
    Then the answer carries no band and no share
