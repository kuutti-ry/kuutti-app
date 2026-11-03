# features/matching/short-pool.feature
Feature: The short pool: coming back, relaxing a deal-breaker for the day, and who did not answer
  When a person's filters leave few people (TD-12, #99, ADR-042, ADR-062 §10;
  the maintainer, 21/10/2026), everybody new comes first, and earlier people
  come back after them in a fixed order, labelled seen before. A round is short
  once no new person is left in the queue, and it then offers to relax one of the
  person's own deal-breakers for the day, by how much it widens the pool in the
  counter's steps; only the person's tap relaxes, and one tap undoes it. The
  phone shows the offers at the end of the queue. A relaxation adds a page of
  the people it lets in, and the queue goes on to the rest once those are read:
  there is no room to run out of. The offers read the pool as it stands, a move
  included. Nothing else is ever relaxed, and nobody whose own filters exclude
  the person is ever let in. A like on a relaxed card reaches its person. Every
  card says which of the person's deal-breakers its person did not answer. A
  deal-breaker on distance has nobody who did not answer, so it is offered set
  aside alone and no card names it (filters.feature, ADR-061 §7).

  Scenario: Everybody new comes before anybody shown before
    Given "A" has "B" new in their pool, "C" shown 45 days ago and "D" shown 40 days ago, both left undecided
    When "A" reads the queue
    Then "A"'s queue is "B", then "C" and "D" labelled seen before

  Scenario: Earlier people come back skipped first, then passed, then liked with no answer, then former conversations, each shown longest ago first
    Given nobody new, and "A" has seen eight people, two of each kind past their clocks
    When "A" reads the queue
    Then the skipped come first, then the passed, then the liked, then the former conversations, each pair the one shown longest ago first, all labelled seen before

  Scenario: A round is short once no new person is left in the queue
    Given "A" has eleven new people in their pool, and one who did not answer smoking
    When "A" reads the queue, reads today's relaxations, decides the ten and reads both again
    Then the round is not short while one new person is left out of the log, and short once none is

  Scenario: A short round offers each deal-breaker relaxed, with the pool's growth in steps
    Given "A" has a deal-breaker on smoking that excludes those who did not answer, twelve people who did not answer it and ten who smoke regularly
    When "A" reads today's relaxations
    Then the round is short, and smoking is offered both ways: letting in those who did not answer, 10 more, and set aside, 20 more

  Scenario: Reading the offers relaxes nothing
    Given "A" has a deal-breaker on smoking and a short round
    When "A" reads today's relaxations
    Then "A"'s round, its relaxations and the deal-breaker are as they were

  Scenario: A relaxation adds a page of the people it lets in, labelled with the field, and the queue goes on to the rest
    Given "A" has read everybody in their pool, and twelve people did not answer smoking
    When "A" relaxes smoking for those who did not answer, and decides the ten cards it added
    Then the ten came after the last place, labelled relaxed with smoking, and the next read brings the other two, labelled the same

  Scenario: One tap undoes a relaxation, and takes back its undecided cards only
    Given "A" relaxed smoking for today and liked one of the cards it added
    When "A" undoes it
    Then the other cards leave the round, the liked one stays, and their places stay given

  Scenario: Tomorrow's queue reads the deal-breakers as stored
    Given "A" relaxed smoking today
    When "A" reads the queue tomorrow
    Then nobody who did not answer smoking is in "A"'s queue

  Scenario: A relaxation never lets in somebody whose own filters exclude the person
    Given "B" and "C" did not answer smoking, and "B"'s own deal-breaker on kids excludes "A"'s answer
    When "A" sets smoking aside for today
    Then "C" is added to "A"'s round, and "B" is not

  Scenario: A like on a relaxed card reaches its person
    Given "A" relaxed smoking for today and liked "B", who did not answer it
    When "B" reads the queue the next day
    Then "A" is in "B"'s queue, labelled liked you

  Scenario: The same deal-breaker is relaxed once a day
    Given "A" relaxed smoking for today
    When "A" relaxes smoking again
    Then it is refused as already_relaxed, and nothing is added

  Scenario: A move closes nothing: the offers read the pool as it stands
    Given "A" has a short round with smoking on offer, its one person within "A"'s deal-breaker on distance
    When "A" moves too far from them
    Then smoking is no longer on offer, and a tap adds nobody
    When "A" moves back
    Then smoking is on offer again

  Scenario: A card says which of the person's deal-breakers its person did not answer
    Given "A"'s deal-breaker on smoking lets through those who did not answer, "B" did not answer it and "C" did
    When "A" reads the queue
    Then "B"'s card says smoking was not answered, and "C"'s says nothing

  Scenario: A hidden answer reads on a card as one not given
    Given "A"'s deal-breaker on smoking lets through those who did not answer, "B" did not answer it and "C" answered it and hid it
    When "A" reads the queue
    Then neither card shows an answer on smoking, and both say so in the same words
