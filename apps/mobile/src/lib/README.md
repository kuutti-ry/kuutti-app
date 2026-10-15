# lib

Horizontal code every feature uses and none owns: API client, secure storage, theme. Not a feature.

- `photo-descriptions.tsx` (#296): the Photo descriptions setting (shown under the photos; the people and setting, face, and activity and objects parts), kept on the device in `preferences.ts` and never sent anywhere, and the hook that turns a photo's `description` into its words for the label and the text under it. Used by the media slice's grid and zoom screen, the profile's card and the settings screen, so it lives here.
