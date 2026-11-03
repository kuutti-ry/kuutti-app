# features/matching/stars.feature
Feature: A star: somebody marked for later, without a like or a pass
  A person who is unsure about somebody, or has run out of likes for the day, can
  put a star on that person's card and come back to them later (#575, ADR-064;
  the maintainer, 03/11/2026). A star is one mark with no degrees. It is no
  decision: it spends nothing, moves no card, and only the person who put it ever
  knows of it, so it feeds neither anybody's order, nor the inbox stop, nor any
  event. A starred person is offered again only through the person's Starred list,
  except that somebody whose like waits keeps coming as a liked-you card. The list
  asks the filters, the account's state and the inbox stop on every read, leaves
  out whoever does not pass, never says why, and takes them back if they pass again.
  Opening one writes their card into today's log, so that a like, a fish or a pass
  from the list spends what it spends anywhere else. A like or a pass takes the
  star off; so does the person, and either person's erasure.

  Scenario: A star spends nothing and leaves the card undecided
    Given "A" has "B" and "C" in today's queue and no likes left
    When "A" stars "B"'s card and reads the queue
    Then the star stands, "B"'s card is undecided, no like was spent and "C" comes next

  Scenario: Nobody is told of a star, and it is in no event
    Given "A" and "B" fit each other, and "A" is in the study
    When "A" stars "B"'s card
    Then "B"'s queue reads the same as before, and no event was written

  Scenario: A star counts for nothing in the inbox stop
    Given "B" has one fewer likes waiting than the inbox stop, and "A" has "B" in today's queue
    When "A" stars "B"'s card
    Then "B" is still in "C"'s queue

  Scenario: A star again answers the same star
    Given "A" starred "B"'s card
    When "A" stars it again
    Then the answer names the same star, and there is one

  Scenario: The first star says it is the only one
    Given "A" has "B" and "C" in today's queue
    When "A" stars both, one after the other
    Then the first answer says it is the first, and the second does not

  Scenario: A starred person is not offered again as a card
    Given "A" starred "B" yesterday and left the card undecided
    When "A" reads the queue today until it ends
    Then "B" does not come, and "A" still has the star

  Scenario: A card starred today leaves the queue at the next read
    Given "A" starred "B"'s card today and left it undecided
    When "A" reads the queue again
    Then "B" does not come

  Scenario: Clearing a star puts them back in the queue
    Given "A" starred "B" yesterday and left the card undecided
    When "A" clears the star and reads the queue today
    Then "B" comes, labelled seen before

  Scenario: A star changes nothing for a like that waits
    Given "B"'s like waits on "A", and "A" starred "B" yesterday and left the card undecided
    When "A" reads the queue today
    Then "B" comes as a liked-you card, with the star on it

  Scenario Outline: A like or a pass takes the star off, and a skip does not
    Given "A" starred "B"'s card
    When "A" chooses <choice> on the card
    Then the star is <after>

    Examples:
      | choice | after |
      | like   | off   |
      | fish   | off   |
      | pass   | off   |
      | skip   | on    |

  Scenario: A like refused leaves the star on
    Given "A" starred "B"'s card and has no likes left
    When "A" likes the card and is refused
    Then the star is on

  Scenario: A card holding a like or a pass takes no star
    Given "A" liked "B"'s card and passed "C"'s
    When "A" stars either card
    Then the answer is not_found and nothing is written

  Scenario: A card of a day that has ended takes no star
    Given "A" holds "B"'s card from yesterday
    When "A" stars it
    Then the answer is round_expired

  Scenario: Another person's card is out of reach
    Given "A" has "B" at the first place of today's queue, and "C" has no queue
    When "C" stars that place
    Then the answer is not_found and "C" has no star

  Scenario: A card that can no longer be shown takes no star
    Given "A" has "B" in today's queue, and "A" blocked "B" since
    When "A" stars the card
    Then the answer is not_found and nothing is written

  Scenario: At the most stars a person may hold, one more is refused
    Given matching_config stars_max is two, and "A" starred "B" and "C"
    When "A" stars "D"'s card
    Then the answer is stars_full and nothing is written

  Scenario: The cap of zero is off, and the contract's ceiling stands
    Given matching_config stars_max is zero, and "A" holds as many stars as the contract's ceiling
    When "A" stars one more card
    Then the answer is stars_full and nothing is written

  Scenario: Somebody left out of the list does not count towards the cap
    Given matching_config stars_max is two, and "A" starred "B" and "C", and "C" no longer fits
    When "A" stars "D"'s card
    Then the star stands

  Scenario: The list holds the people starred, the latest first, with their name, age and a photo shown
    Given "A" starred "B" and then "C"
    When "A" reads the list
    Then "C" comes first and then "B", each with a name, an age and a photo "A" was shown

  Scenario: The list offers no photo the person was never shown
    Given "A" starred "B", and "B" has one photo "A" was never shown since their others went
    When "A" reads the list
    Then "B" comes with no photo

  Scenario Outline: The list leaves out whoever may not be shown, and takes them back
    Given "A" starred "B"
    When <what stands>
    Then "A"'s list leaves out "B", and opening the star answers not_found
    And when it lifts, "B" is back

    Examples:
      | what stands                                 |
      | "A" narrowed their ages past "B"            |
      | "B" narrowed their ages past "A"            |
      | "B" stopped seeking "A"'s gender            |
      | "B" paused                                  |
      | "B" was shadow-banned                       |
      | "B" was suspended                           |
      | "B" took down the photos that completed them |

  Scenario: Somebody who blocks stays out of the list for good, either way
    Given "A" starred "B", and "B" starred "A"
    When "A" blocks "B"
    Then neither list holds the other, and neither star opens

  Scenario: Somebody past the inbox stop is left out, and back once below it
    Given "A" starred "B", and "B" has as many likes waiting as the inbox stop
    When "A" reads the list, and "B" goes through one of the likes, and "A" reads it again
    Then "B" is left out the first time and back the second

  Scenario: The list of somebody with no open matching is empty
    Given "A" starred "B", and an admin closed matching since
    When "A" reads the list
    Then it is empty, and the star stands for when matching opens

  Scenario: Opening a star writes the card into today's log, labelled seen before
    Given "A" starred "B" yesterday and left the card undecided
    When "A" opens the star
    Then "B"'s card comes at a place of today's log, seen before, with its distance and the star on it, and the card was served

  Scenario: Opening a star again the same day gives the same place
    Given "A" opened the star on "B" today
    When "A" opens it again
    Then the card is at the same place, and today's log holds "B" once

  Scenario: A like from the list spends a like and takes the star off
    Given "A" starred "B" yesterday and opened the star today
    When "A" likes the card
    Then a like was spent, and "A"'s list no longer holds "B"

  Scenario: A like waiting makes a match from the list, as in the queue
    Given "A" starred "B" yesterday, and "B" liked "A" since
    When "A" opens the star and likes the card
    Then the card says liked you, and the like makes a match

  Scenario: A shadow-banned person's list never says a like waits
    Given "A" starred "B" yesterday, "B" liked "A" since, and "A" was shadow-banned
    When "A" opens the star and likes the card
    Then the card says seen before, and no match is made

  Scenario: A star stays while its card is opened and left, and the queue does not offer it
    Given "A" opened the star on "B" today and left the card undecided
    When "A" reads the queue
    Then "B" does not come, and the list still holds "B"

  Scenario: Opening a star counts as a read of cards for the alarm
    Given the cards alarm stands at one person's cards
    When "A" opens a star on "B"
    Then "A" is shadow-banned by the alarm

  Scenario: Somebody else's star can be neither opened nor cleared
    Given "A" starred "B"
    When "C" opens that star and clears it
    Then both answer not_found, and "A" still has the star

  Scenario: A star cleared twice answers not_found the second time
    Given "A" starred "B"
    When "A" clears the star twice
    Then the first answers 204 and the second not_found

  Scenario: Every route of the stars asks for a session
    Given nobody is signed in
    When the list is read, a card starred, a star opened and a star cleared
    Then each answers unauthenticated

  Scenario Outline: Erasure of either person takes the star
    Given "A" starred "B"
    When <who> is erased
    Then the star is gone

    Examples:
      | who |
      | "A" |
      | "B" |

  Scenario: The export says when, and never whom
    Given "A" starred "B"
    When "A" exports their account
    Then the stars part holds the time and nothing about "B", and "B"'s holds nothing about "A"
