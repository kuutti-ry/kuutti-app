# identity

Bank-ID registration, identity standing, accounts, sessions, re-registration. TD-1, TD-7. Taking a break (#170, ADR-022): `BreakScreen` says what happens and `pauseAccount` on the session provider does it; the sign-in screen says the account is on a break from the provider's notice, and the home screen welcomes an `unpaused` login back once. Your account's actions (`AccountActions`) open "I found someone" (#83, ADR-040), the settings slice's `FoundThemScreen`, by its route: telling Kuutti changes nothing, so this slice holds none of it.
