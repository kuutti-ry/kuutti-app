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
  Liked-you and its forced places are #97's; recycling and relaxing #99's.

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
