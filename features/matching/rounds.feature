# features/matching/rounds.feature
Feature: The queue: whom it holds and in which order
  One queue to the end of the pool (#502, ADR-062; the maintainer, 29/10/2026
  and 01/11/2026). A person reads everybody who fits them, one card at a time,
  as far as they like. Nothing is built at night: the first read of a Finnish
  day opens the day's log, its round, and a read that finds nothing left to go
  through adds the next people, ten at a time. The cards are people of the same
  pond who are complete and seen by others, in each other's pool both ways
  (filters.feature). First come the people whose like waits on the person
  (#97, ADR-037), however many, fish first and each the oldest first; then
  everybody new, the nearest band first (#514, ADR-061 §6), then the most soft
  matches, equal counts in an order of the day's and the person's own; then
  people seen before, once their clock has run, in the order of
  short-pool.feature. Seen means displayed or decided. Nothing fills the end of
  the queue: it ends, and a pool is finite. What a card's decision does is
  decisions.feature's, and relaxing a deal-breaker for the day
  short-pool.feature's (#99, ADR-042).

  Scenario: The day's first read opens the day and fills ten, nobody built at night
    Given "A" whose matching is open, twelve people in their pool and nothing written for the day
    When "A" reads the queue for the first time that day
    Then ten cards come, and the day's log holds those ten and nobody else

  Scenario: Only somebody complete in an open pond opens a day
    Given "A" complete in an open pond, "B" whose profile lacks its photos there, and "C" complete in a closed pond
    When each of them reads the queue
    Then "A" has today's round, and "B" and "C" have none

  Scenario: A read with undecided cards adds nobody
    Given "A" has twelve people in their pool and has read ten cards, nine of them decided
    When "A" reads the queue
    Then the one undecided card comes, and the log still holds ten

  Scenario: The eleventh person comes once ten are decided
    Given "A" has twelve people in their pool and has decided the first ten cards
    When "A" reads the queue
    Then the other two come, at places eleven and twelve

  Scenario: The queue's end is an empty list, and null means no matching
    Given "A" has decided everybody in their pool, and "B" is complete in a pond nobody has opened
    When each of them reads the queue
    Then "A" gets an empty list and "B" gets null

  Scenario: Two reads at once queue nobody twice
    Given "A" has twelve people in their pool and nothing written for the day
    When two devices read the queue at the same moment
    Then the second waits for the first, and the log holds ten people, each once

  Scenario: Within a band the most soft matches come first
    Given "A" has three people in their pool in one band, similar to "A" on two, one and no soft fields
    When "A" reads the queue
    Then the one with two comes first, then the one with one, then the one with none

  Scenario: Somebody hidden from others, or not complete, is nobody's card
    Given "A" in an open pond, "B" shadow-banned there, and "C" whose profile lacks its photos
    When "A" reads the queue
    Then neither "B" nor "C" is a card in "A"'s queue

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

  Scenario: Nobody to show makes an empty queue, never a filler
    Given "A" whose matching has opened and nobody in their pool
    When "A" reads the queue
    Then "A" has today's round with no cards

  Scenario: A person whose matching has not opened reads no round
    Given "A" complete in a pond nobody has opened
    When "A" reads the queue
    Then the day has no round, and none is written

  # Seen means displayed or decided (ADR-062 §2): an entry queued and never
  # displayed is nothing, and the day's first read deletes the person's own such
  # entries of earlier days. The ladder of clocks is §6: a skip waits for no
  # clock, a pass the shortest, and the one who asked waits longer to ask again.

  Scenario: An entry queued and never displayed starts no clock, and its person is new again
    Given "A"'s log of yesterday queued "B", and the card was never displayed
    When "A" reads the queue today
    Then "B" comes as somebody new, labelled matches your filters

  Scenario: The day's first read deletes what earlier days queued and never displayed
    Given "A"'s logs of earlier days hold a card never displayed, a card displayed and a card decided
    When "A" reads the queue today
    Then the first is gone and the other two stay, and nobody else's log has changed

  Scenario Outline: Somebody seen before waits out their clock, then comes back as seen before
    Given "A" was shown "B" <days> days ago and <decided>
    When "A" reads the queue today
    Then "B" is <outcome>

    Examples:
      | days | decided              | outcome                              |
      | 1    | left it undecided    | in "A"'s queue, labelled seen before |
      | 1    | skipped them         | in "A"'s queue, labelled seen before |
      | 1    | passed               | not in "A"'s queue                   |
      | 29   | passed               | not in "A"'s queue                   |
      | 30   | passed               | in "A"'s queue, labelled seen before |
      | 29   | passed a second time | not in "A"'s queue                   |
      | 364  | passed a second time | not in "A"'s queue                   |
      | 365  | passed a second time | in "A"'s queue, labelled seen before |
      | 1    | liked them           | not in "A"'s queue                   |
      | 89   | liked them           | not in "A"'s queue                   |
      | 90   | liked them           | in "A"'s queue, labelled seen before |

  Scenario Outline: An ended conversation keeps the two apart until its clock has run, both ways
    Given "A" and "B" had a conversation that <ended> <days> days ago
    When each of them reads the queue
    Then each is <outcome>

    Examples:
      | ended                 | days | outcome                                   |
      | one of them closed    | 89   | not in the other's queue                  |
      | one of them closed    | 90   | in the other's queue, labelled seen before |
      | the silence archived  | 89   | not in the other's queue                  |
      | the silence archived  | 90   | in the other's queue, labelled seen before |

  Scenario: Two people with a conversation between them are never each other's cards
    Given "A" and "B" in each other's pool, with a conversation between them
    When each of them reads the queue
    Then neither is a card in the other's queue

  Scenario: A block never runs out
    Given "A" blocked "B", and a conversation between them closed a year ago
    When each of them reads the queue
    Then neither is a card in the other's queue

  # Liked-you (#97, ADR-037, ADR-062 §2): a like reaches the person it was meant
  # for first and labelled, for free; it waits until it is answered or
  # like_expiry_days have passed, and its sender is never told which. Fit and
  # distance never move it, and however many wait, all of them come.

  Scenario: A like given on an ended day comes first in the liked person's queue, labelled
    Given "B" liked "A" yesterday, and "A" has two more people in their pool
    When "A" reads the queue
    Then "A"'s queue opens with "B", labelled liked you, then the other two

  Scenario: More likes than a page all come, the oldest first and ahead of anybody new
    Given twelve people's likes wait on "A", each a day apart, and "A" has one new person in their pool
    When "A" reads the queue, and again each time the cards are decided
    Then the first read has the ten oldest, in order, the second the other two, and the third the new person

  Scenario: Fit moves no like
    Given "B" liked "A" two days ago and shares nothing with "A", and "C" liked "A" yesterday and shares every soft field
    When "A" reads the queue
    Then "A"'s queue opens with "B", then "C"

  Scenario Outline: A like waits until it is answered or expires
    Given "B" liked "A" <days> days ago, and <answer>
    When "A" reads the queue
    Then "B" is <outcome>

    Examples:
      | days | answer                                 | outcome                                  |
      | 1    | "A" has not seen it                    | first in "A"'s queue, labelled liked you |
      | 13   | "A" left it undecided twelve days ago  | first in "A"'s queue, labelled liked you |
      | 13   | "A" skipped it twelve days ago         | first in "A"'s queue, labelled liked you |
      | 14   | "A" has not seen it                    | in "A"'s queue as an ordinary card       |
      | 3    | "A" passed it two days ago             | not in "A"'s queue                       |
      | 3    | "A" liked it two days ago              | not in "A"'s queue                       |

  Scenario: A like of today waits for the day to end
    Given "B" liked "A" earlier today
    When "A" reads the queue for the first time that day
    Then "B" is no liked-you card of it

  Scenario: A like never reaches the queue from somebody the person passed, or who no longer passes the filters
    Given "B" and "C" liked "A" yesterday, "A" passed "B" within their clock, and "C" seeks only men since
    When "A" reads the queue
    Then neither "B" nor "C" is in "A"'s queue

  Scenario: A shadow-banned person's queue holds no liked-you places, and the likes wait for the lift
    Given "B" liked "A" yesterday, and "A" is shadow-banned
    When "A" reads the queue, and again the day after the ban is lifted
    Then "A"'s first day holds "B" in no place, and the second opens with "B", labelled liked you

  Scenario: The sender learns nothing of what became of a like
    Given "B" liked "A" yesterday, and "B" has read today's queue
    When "A" passes "B"
    Then what "B" reads of their own queue and of their rounds' history is as it was

  # The inbox stop (ADR-062 §4; the maintainer, 29/10/2026 and 01/11/2026): the
  # most-liked people's likes pile up and die unread, so somebody with
  # inbox_stop likes waiting is in nobody's ordinary queue until they have gone
  # through enough of them to fall below it. A hard stop on the pile alone, never
  # on gender, whom one seeks or a score, and nothing tells anybody.

  Scenario Outline: Somebody with inbox_stop likes waiting is in nobody's queue
    Given <likes> likes wait on "B" that "B"'s inbox could show
    When "A" reads the queue
    Then "B" is <outcome>

    Examples:
      | likes | outcome            |
      | 29    | in "A"'s queue     |
      | 30    | not in "A"'s queue |

  Scenario Outline: Only the likes the inbox could show now count towards the stop
    Given 29 likes wait on "B", and one more <like>
    When "A" reads the queue
    Then "B" is in "A"'s queue

    Examples:
      | like                                     |
      | has expired                              |
      | was given today                          |
      | came from somebody who no longer fits    |
      | came from somebody "B" passed since      |
      | came from somebody "B" passed before it, within their clock |
      | came from somebody shadow-banned         |

  Scenario Outline: Only a like or a pass clears one from the pile
    Given 30 likes wait on "B", and "B" reads their queue
    When "B" <decides> the first card
    Then "B" is <outcome>

    Examples:
      | decides | outcome             |
      | likes   | in "A"'s queue      |
      | passes  | in "A"'s queue      |
      | skips   | not in "A"'s queue  |

  Scenario: The stop holds a person out of seen-before cards too
    Given 30 likes wait on "B", and "A" skipped "B" yesterday
    When "A" reads the queue
    Then "B" is not in "A"'s queue

  Scenario: The stop holds a person out of what a relaxation lets in
    Given 30 likes wait on "B", and "A" has relaxed the deal-breaker that kept "B" and "C" out
    When "A" reads the queue
    Then "C" comes, and "B" does not

  Scenario: The stop holds back no like the person sent
    Given 30 likes wait on "B", and "B" liked "C" yesterday
    When "C" reads the queue
    Then "C"'s queue opens with "B", labelled liked you

  Scenario: An entry queued already stays when the stop comes
    Given "B" is undecided in "A"'s queue today, and 30 likes wait on "B"
    When "A" reads the queue
    Then "B"'s card comes

  Scenario: The stop says nothing to anybody
    Given 30 likes wait on "B"
    When "B" reads the queue, and "A" reads the queue
    Then neither answer holds anything of the stop or of the pile

  Scenario: An inbox_stop of 0 is off
    Given inbox_stop is 0, and 30 likes wait on "B"
    When "A" reads the queue
    Then "B" is in "A"'s queue

  # Distance (#514, ADR-061 §5 and §6, ADR-062 §8): the straight line between two
  # kept places' centres (home.feature), said in bands and never in kilometres.
  # With one pond nothing else keeps people local, so the band orders new people
  # before the soft count; what waits on a person and who comes back it does not
  # move. A band is written with its entry and read from there, and a move works
  # on the next read, as every other change of what fits does (filters.feature).

  Scenario Outline: Two homes are in the band of the straight line between their kept places
    Given the bands end at 5, 15 and 50 km, and two kept places are <km> km apart, centre to centre
    Then the two are <band>, asked from either side

    Examples:
      | km    | band   |
      | 0     | nearby |
      | 4.99  | nearby |
      | 5     | close  |
      | 14.99 | close  |
      | 15    | around |
      | 49.99 | around |
      | 50    | far    |
      | 900   | far    |

  Scenario: The nearest band comes first, then the most soft matches, then the day's order
    Given "A"'s pool holds "B" far away with three soft matches, "C" close with one, "D" close with two and "E" nearby with none
    When "A" reads the queue
    Then "A"'s queue is "E", "D", "C", "B"
    And two people level on both stand in an order of the day's and "A"'s own

  Scenario: The liked-you places keep their order, whatever the band
    Given "B" liked "A" three days ago from far away, and "C" one day ago from nearby
    When "A" reads the queue
    Then "A"'s queue opens with "B", then "C", each labelled liked you

  Scenario: Coming back keeps its order, whatever the band
    Given nobody new, and "A" was shown "C" 45 days ago, far away, and "D" 40 days ago, nearby, both left undecided
    When "A" reads the queue
    Then "A"'s queue is "C", then "D", each labelled seen before

  Scenario: Every entry is written with its band, whichever way it came into the round
    Given "A"'s round holds somebody new, somebody whose like waited, somebody seen before and somebody a relaxation let in
    When "A" reads the queue
    Then each entry says the band between the two homes as they stood when it was written

  Scenario: An entry keeps its band, so moving home and reading again says nothing new
    Given "A"'s round holds "B" as close
    When "A" moves next door to "B", then "B" moves far away, and "A" reads the queue after each move
    Then "B"'s entry says close every time

  Scenario: A new home and a changed edge count from the next entry, never on an entry written
    Given today's log of "A" holds two people, each with their band
    When "A" moves home and an admin changes distance_nearby_km
    Then today's entries and their order are as they were
    And the next day's read measures from the new home with the new edge

  Scenario: Only a round's entry says a band, and as a word
    Given "A"'s round holds "B"
    When "A" reads the queue and previews their own card
    Then "B"'s entry says a band, neither card says one, and no answer holds a distance in kilometres
