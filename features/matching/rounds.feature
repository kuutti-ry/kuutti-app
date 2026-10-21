# features/matching/rounds.feature
Feature: The day's round, built: whom it holds and in which order
  The round builder's first cut (#95, ADR-035; the maintainer, 20/10/2026).
  Everybody whose matching has opened (#94) gets one round a Finnish day:
  at night after the gate's count, or at the day's first read when the night
  built none. Its cards are people of the same pond who are seen by others
  and let in, in each other's pool both ways (filters.feature), up to
  round_size, the most soft matches first, equal counts in an order of the
  day's and the person's own. Nobody is shown again while they cool down,
  nobody with whom one has a conversation, and nothing fills a short round.
  Before those cards come the people whose like waits on the person (#97,
  ADR-037), oldest first, up to liked_you_cap. Recycling and relaxing are
  #99's.

  Scenario: Everybody whose matching has opened gets a round for the day, and nobody else
    Given "A" whose matching has opened, "B" who is let in but whose matching has not opened, and "C" who waits in the line
    When the night builds the rounds
    Then "A" has today's round, and "B" and "C" have none

  Scenario: A round holds at most round_size cards, the most soft matches first
    Given round_size is 2 and "A" has three people in their pool, similar to "A" on two, one and no soft fields
    When the night builds the rounds
    Then "A"'s round is the one with two, then the one with one

  Scenario: Somebody hidden from others, or not let in, is nobody's card
    Given "A" whose matching has opened, "B" shadow-banned, and "C" whose profile is complete but who was never let in
    When the night builds the rounds
    Then neither "B" nor "C" is a card in "A"'s round

  Scenario Outline: Somebody shown before waits out the cooldown, then comes back as seen before
    Given "A" was shown "B" <days> days ago and <decided>
    When the night builds the rounds
    Then "B" is <outcome>

    Examples:
      | days | decided    | outcome                               |
      | 1    | left it    | not in "A"'s round                    |
      | 29   | liked them | not in "A"'s round                    |
      | 30   | left it    | in "A"'s round, labelled seen before  |
      | 30   | liked them | in "A"'s round, labelled seen before  |
      | 30   | passed     | not in "A"'s round                    |
      | 89   | passed     | not in "A"'s round                    |
      | 90   | passed     | in "A"'s round, labelled seen before  |

  Scenario: Two people with a conversation between them are never each other's cards
    Given "A" and "B" in each other's pool, with a conversation between them
    When the night builds the rounds
    Then neither is a card in the other's round

  Scenario Outline: A person who hides from their own field never meets it, asked from either side
    Given "A" named <a fields> and <a hides>, and "B" named <b fields> and <b hides>
    Then the two are <apart> by their field, asked from either side

    Examples:
      | a fields      | a hides       | b fields  | b hides       | apart   |
      | tech          | hides         | tech      | does not hide | kept    |
      | tech          | does not hide | tech      | hides         | kept    |
      | tech,business | hides         | business  | does not hide | kept    |
      | tech          | hides         | business  | hides         | not kept |
      | tech          | does not hide | tech      | does not hide | not kept |
      | nothing       | hides         | tech      | does not hide | not kept |

  Scenario: Nobody to show makes an empty round, never a filler
    Given "A" whose matching has opened and nobody in their pool
    When the night builds the rounds
    Then "A" has today's round with no cards

  Scenario: The day's round is built once, whoever asks
    Given the night built "A"'s round
    When the night builds again, and "A" reads the round
    Then "A" has the same round, and one round_built for the day

  Scenario: The day's first read builds the round when the night built none
    Given "A" whose matching opened after the night
    When "A" reads today's round
    Then it has its cards, built then, and the next read is the same round

  Scenario: A person whose matching has not opened reads no round
    Given "A" who is let in but whose matching has not opened
    When "A" reads today's round
    Then the day has no round, and none is written

  # Liked-you (#97, ADR-037): a like reaches the person it was meant for in
  # their next round, first and labelled, for free; it waits until it is
  # answered or like_expiry_days have passed, and its sender is never told
  # which.

  Scenario: A like given on an ended day is in the liked person's next round, first and labelled
    Given "B" liked "A" yesterday, and "A" has two more people in their pool
    When the night builds the rounds
    Then "A"'s round opens with "B", labelled liked you, then the other two

  Scenario: More waiting likes than liked_you_cap wait for a later round, oldest first
    Given liked_you_cap is 2, and "B", "C" and "D" liked "A" three, two and one days ago
    When the night builds the rounds
    Then "A"'s round opens with "B" and "C", and "D" is no card of it

  Scenario Outline: A like waits until it is answered or expires
    Given "B" liked "A" <days> days ago, and <answer>
    When the night builds the rounds
    Then "B" is <outcome>

    Examples:
      | days | answer                                   | outcome                                   |
      | 1    | "A" has not seen it                      | first in "A"'s round, labelled liked you  |
      | 13   | "A" left it undecided twelve days ago    | first in "A"'s round, labelled liked you  |
      | 14   | "A" has not seen it                      | in "A"'s round as an ordinary card        |
      | 3    | "A" passed it two days ago               | not in "A"'s round                        |
      | 3    | "A" liked it two days ago                | not in "A"'s round                        |

  Scenario: A like of today waits for the night
    Given "B" liked "A" earlier today
    When "A" reads today's round for the first time
    Then "B" is no liked-you card of it

  Scenario: A like never reaches the round from somebody the person passed, or who no longer passes the filters
    Given "B" and "C" liked "A" yesterday, "A" passed "B" thirty days ago, and "C" seeks only men since
    When the night builds the rounds
    Then neither "B" nor "C" is in "A"'s round

  Scenario: A shadow-banned person's round holds no liked-you places, and the likes wait for the lift
    Given "B" liked "A" yesterday, and "A" is shadow-banned
    When the night builds the rounds, and again the night after the ban is lifted
    Then "A"'s first round holds "B" in no place, and the second opens with "B", labelled liked you

  Scenario: The sender learns nothing of what became of a like
    Given "B" liked "A" yesterday, and the night built both rounds
    When "A" passes "B"
    Then what "B" reads of their own round and of their rounds' history is as it was
