# features/identity/app-lock.feature
Feature: The app lock
  A person may lock Kuutti on their phone, so that somebody else holding it
  cannot open their matches and conversations (#418, ADR-045): the phone's
  face or fingerprint, never falling back to the phone's own code, or a
  passcode of six digits kept as a salted hash, or both. The lock gates the
  screens, not the session. It lives on the phone only and goes with the
  session. It locks at a cold start and after the person's chosen time in the
  background (straight away, 1, 5 or 15 minutes, 1 by default), and the way
  out is always the bank, which signs this phone out. It is off until the
  person turns it on, and offered once after the e-mail.

  Scenario: The lock is off until the person turns it on
    Given a person signed in on a phone with no lock stored
    When the app starts, goes to the background and comes back
    Then no lock screen and no cover is shown

  Scenario: A cold start with the lock on shows the lock screen
    Given a person signed in with a passcode set
    When the app starts
    Then the lock screen covers the app before any of its screens is shown

  Scenario: The app locks again after the chosen time in the background
    Given a person signed in with the lock on and five minutes chosen
    When the app comes back after five minutes in the background
    Then the lock screen is shown

  Scenario: The app does not lock again within the chosen time
    Given a person signed in with the lock on and five minutes chosen
    When the app comes back after four minutes in the background
    Then the app is as it was left, with no lock screen

  Scenario: The right passcode opens the app and resets the tries
    Given the lock screen after two wrong passcodes
    When the person types the right one
    Then the app opens and the count of wrong tries is back at none

  Scenario: Five wrong passcodes sign this phone out
    Given the lock screen after four wrong passcodes
    When the person types a fifth wrong one
    Then this phone is signed out, the lock is removed, and the sign-in screen says the lock signed it out

  Scenario: Signing in with the bank instead signs this phone out and turns the lock off
    Given the lock screen
    When the person chooses to sign in with the bank instead
    Then this phone's session is dropped as Log out drops it, the stored lock is removed, and the sign-in screen says the lock signed it out

  Scenario: Logging out turns the lock off
    Given a person signed in with the lock on
    When they log out
    Then the stored lock and its tries are removed, and the next sign-in starts unlocked

  Scenario: Biometrics never fall back to the phone's own code
    Given a phone with a face or a fingerprint enrolled
    When the lock asks for it
    Then the phone's prompt is asked with no fallback to the phone's code and with the weak class allowed
    And a cancel is told apart from a failure

  Scenario: A pause by the phone after too many tries is said as a pause, not as a failure
    Given the lock screen with the face, on a phone that has paused it after too many tries
    When the lock asks for the face
    Then it says the phone has paused face unlock and how that ends, and the face, the passcode and the bank are still there

  Scenario: A pause keeps the button when the phone says on return that it has none
    Given the lock screen with the face, on a phone that has paused it after too many tries
    When the app comes back on Android and the phone's answer reads as no face or fingerprint, as Android 16's pause does
    Then the face's button is still there
    And once an ask answers other than the pause, none means none again

  Scenario: Turning biometrics on asks for the face or finger once
    Given a person in the lock's settings on a phone with a face enrolled
    When they turn the face or fingerprint on
    Then the phone's prompt is asked once, and the lock is on only if it answered yes

  Scenario: The lock's settings ask the phone again when the app comes back
    Given a person in the lock's settings on a phone with no face or fingerprint set up
    When they set up a finger in the phone's own settings and come back to Kuutti
    Then the switch for the face or fingerprint is offered, and the line that the phone has none is gone

  Scenario: A lock that cannot be read keeps the app locked with the bank as the way out
    Given a person signed in, and a stored lock that cannot be read
    When the app starts
    Then the lock screen is shown with no passcode field and no face or finger, only the bank

  Scenario: The app switcher shows a cover while the lock is on
    Given a person signed in with the lock on
    When the app goes inactive or loses its window's focus, and comes back within the chosen time
    Then a cover with the app's name hides it while it is away and goes when it is back, with no lock screen

  Scenario: The passcode is stored only as a salted hash
    Given a person who chose a passcode
    When it is hashed for the store
    Then what is kept is a salt and the SHA-256 of the salt and the digits, never the digits
    And two hashes of the same passcode differ, and only the right digits match

  Scenario: The lock is offered once after the e-mail
    Given a person on the e-mail's screen among the later screens, on a phone where the lock was never offered
    When they tap Done
    Then the lock's offer comes next, and once it has been shown, Done goes home
