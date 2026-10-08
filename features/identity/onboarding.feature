# features/identity/onboarding.feature
Feature: Onboarding and consents
  Matching cannot start without four answers (gender, seeks, an age window,
  a pond) and nothing may start without two consents given for the exact
  wording and version the person read (TD-17: the Finnish text is binding).
  The research opt-in has its own yes and can be withdrawn, and so can the
  special-category consent that the seek answer needs (ADR-019 §4). The
  account becomes active when everything required is there; the steps of
  the field sheet (name, intent, photos, prompts or a bio) are asked in the
  same flow and keep it incomplete until done (#46, #146, ADR-010).

  Scenario: A consent counts only for the current version of its wording
    Given the terms have a current consent version
    When the account sends a consent for an older version
    Then the answer is 409 agreement_outdated and no consent row is written

  Scenario: The same consent is recorded once
    Given the account gave the terms consent for the current version
    When it sends the same consent again
    Then there is still one consent row for the terms

  Scenario: The research opt-in can be withdrawn and given again
    Given the account gave the research consent
    When it withdraws and later gives it again
    Then two rows exist, one withdrawn and one active, and the status shows the active one

  Scenario: Terms and privacy have no withdrawal route
    When the account tries to withdraw the terms or the privacy consent
    Then the request is refused as not a kind a person withdraws and the consent stays

  Scenario: The account becomes active when every required answer is there
    Given a registered account that has answered nothing
    When it gives both consents, declares a gender, gives the special-category consent, sets seeks and an age window, and is given a pond
    Then the status lists fewer missing steps after each answer, in the order the app asks, and the account is active at the end with the profile steps still open

  Scenario: The onboarding lists the profile steps the sheet asks, in its order
    Given an active account whose profile is empty
    When it saves a name, an intent and a bio, then uploads three photos
    Then the missing steps shrink from name, intent, photos and prompts or a bio to photos alone, and then to none

  Scenario: An account gets the default pond without a pond step
    Given a pond whose slug matching_config names as the default pond
    When a registered account reads its onboarding
    Then the account is in that pond and no pond step is missing

  Scenario: The seek consent is recorded with the answer and withdrawing it blanks the seek rows
    Given an onboarded account with a politics answer on its profile
    When it withdraws the special-category consent
    Then the seek row is gone and the age window stays, the politics answer and the profile's consent are gone, and the status asks the seek step again

  Scenario: Research is never required for activation
    Given a registered account with every required answer and no research consent
    Then the account is active and the status shows no research opt-in

  Scenario: Erasure removes the preferences, keeps the consents and blanks gender and pond
    Given an onboarded account
    When the account is deleted
    Then its preference rows are gone, its consent rows remain and the tombstone has neither gender nor pond

  Scenario: The export lists gender, pond, preferences and every consent
    Given an onboarded account with a withdrawn research consent
    When it downloads its export
    Then the export carries the gender, the pond with both case forms, the two hard preferences and every consent row

  Scenario: The research opt-in creates the research_id mapping and withdrawal removes it
    Given the account gave the research consent
    Then one mapping row exists for the account
    When it withdraws the consent
    Then no mapping row exists and the events written meanwhile remain

  Scenario: A new research opt-in is a new research_id
    Given the account gave and withdrew the research consent
    When it gives the consent again
    Then the mapping row carries a research_id different from the first one
