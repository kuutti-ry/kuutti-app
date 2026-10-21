# features/matching/short-pool.feature
Feature: The short pool: coming back, relaxing a deal-breaker for the day, and who did not answer
  When a person's filters leave few people (TD-12, #99, ADR-042; the
  maintainer, 21/10/2026), everybody new comes first, and earlier people
  come back after them in a fixed order, labelled seen before. A short round
  offers to relax one of the person's own deal-breakers for the day, by how
  much it widens the pool in the gate's steps; only the person's tap relaxes,
  and one tap undoes it. Nothing else is ever relaxed, and nobody whose own
  filters exclude the person is ever let in. A like on a relaxed card reaches
  its person. Every card says which of the person's deal-breakers its person
  did not answer.

  Scenario: Everybody new comes before anybody shown before
    Given round_size is 2, "A" has "B" new in their pool, "C" shown 45 days ago and "D" shown 40 days ago, both left undecided
    When the night builds the rounds
    Then "A"'s round is "B", then "C" labelled seen before

  Scenario: Earlier people come back undecided first, then passed, each shown longest ago first
    Given nobody new, and "A" was shown "C" 45 days ago and left it, "D" 40 days ago and liked them, "E" 120 days ago and passed, "F" 100 days ago and passed
    When the night builds the rounds
    Then "A"'s round is "C", "D", "E", "F", each labelled seen before

  Scenario: A round never opened showed nobody
    Given "A"'s round of yesterday held "B" and was never opened
    When the night builds the rounds
    Then "B" is in "A"'s round, labelled matches your filters

  Scenario: A short round offers each deal-breaker relaxed, with the pool's growth in steps
    Given "A" has a deal-breaker on smoking that excludes those who did not answer, twelve people who did not answer it and ten who smoke regularly
    When "A" reads today's relaxations
    Then the round is short, and smoking is offered both ways: letting in those who did not answer, 10 more, and set aside, 20 more

  Scenario: Reading the offers relaxes nothing
    Given "A" has a deal-breaker on smoking and a short round
    When "A" reads today's relaxations
    Then "A"'s round, its relaxations and the deal-breaker are as they were

  Scenario: A relaxation adds the people it lets in, labelled with the field, up to the room left
    Given round_size is 3, "A"'s round holds one card, and four people who did not answer smoking
    When "A" relaxes smoking for those who did not answer
    Then two of them are added after the last place, labelled relaxed with smoking, and the round is short no longer

  Scenario: One tap undoes a relaxation, and takes back its undecided cards only
    Given "A" relaxed smoking for today and liked one of the cards it added
    When "A" undoes it
    Then the other cards leave the round, the liked one stays, and their places stay given, so nothing more is offered today

  Scenario: Tomorrow's round is built from the deal-breakers as stored
    Given "A" relaxed smoking today
    When the next night builds the rounds
    Then nobody who did not answer smoking is in "A"'s round

  Scenario: A relaxation never lets in somebody whose own filters exclude the person
    Given "B" and "C" did not answer smoking, and "B"'s own deal-breaker on kids excludes "A"'s answer
    When "A" sets smoking aside for today
    Then "C" is added to "A"'s round, and "B" is not

  Scenario: A like on a relaxed card reaches its person
    Given "A" relaxed smoking for today and liked "B", who did not answer it
    When the next night builds the rounds
    Then "A" is in "B"'s round, labelled liked you

  Scenario: The same deal-breaker is relaxed once a day
    Given "A" relaxed smoking for today
    When "A" relaxes smoking again
    Then it is refused as already_relaxed, and nothing is added

  Scenario: A card says which of the person's deal-breakers its person did not answer
    Given "A"'s deal-breaker on smoking lets through those who did not answer, "B" did not answer it and "C" did
    When "A" reads today's round
    Then "B"'s card says smoking was not answered, and "C"'s says nothing
