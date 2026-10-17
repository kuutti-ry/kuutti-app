# features/safety/blocks.feature
Feature: Blocking somebody from a card
  A person blocks somebody whose card they were shown (#84, ADR-030). From
  then on neither is shown to the other, in either direction, anywhere a
  person is shown to a person: the pool, the gate's count, the card and its
  photos, and the rounds, likes and matches when they come (rule 7). The
  block is between the two identities, so it holds for a later account of
  either, and it is final: no list and no unblock. Nobody is told, and
  nothing counts blocks: they are a filter, never a signal. A report blocks
  too (features/safety/reports.feature).

  Scenario: A block takes two people out of each other's pool, whoever set it
    Given two people who are in each other's pool
    When either blocks the other, or both do
    Then neither is in the other's pool, asked from either side
    And a block of somebody else changes nothing between them

  Scenario: Neither card is built for the other after a block, and nothing is recorded
    Given "A" blocked "B", and both have complete profiles
    When a card of either is built for the other
    Then both are refused as for somebody outside the pool, before the day's budget, and no card is recorded or counted

  Scenario: A photo from a card shown before the block is refused both ways
    Given "A" and "B" were shown each other's cards and fetched a photo
    When "A" blocks "B"
    Then neither is issued the other's photo in any variant, and each owner still reads their own

  Scenario: The gate's count leaves a blocked pair out of each other's pool
    Given a pond of thirty-one people who all fit, and gate_k thirty
    When one of them blocks another and the night counts
    Then the gate opens for the twenty-nine and the two stay one short

  Scenario: Blocking again, or blocking somebody who blocked first, answers the same
    Given "A" and "B" were shown each other's cards
    When "A" blocks "B" twice and "B" blocks "A"
    Then every answer is the same 204, and each block is its setter's own

  Scenario: Only somebody whose card the person was shown can be blocked
    When "A" blocks somebody they were never shown, themselves, or nobody
    Then each is refused alike with 404 and nothing is written

  Scenario: A block holds for a later account of either identity
    Given "A" blocked "B"
    When "B" deletes the account and comes back after the cooldown
    Then "A" and the new account of "B" are still out of each other's pool, and their cards and photos stay refused

  Scenario: Nothing but the filters reads a block
    Then only the pool's count, the card, the photos, the block itself and the demo's removal name the block table or its test

  Scenario: Blocking refuses without a session
    When nobody, a token nobody issued, a staff token, an ended session or an expired one blocks
    Then the answer is 401 with its code, and nothing is written
