# media

The person's photos (#48, TD-2, TD-8): the grid with its buttons, the zoom screen, the upload chain on the phone.

- `pick.ts`: the photo library, then `expo-image-manipulator` re-saves at 1600 px as JPEG, which also drops the original's EXIF.
- `localCheck.ts`: the on-device nudity check runs on the picked file before any byte leaves the phone; a refusal shows one text and sends nothing. The classifier is native and registers itself with `setLocalCheck`; until the native batch lands (#184) every picture passes, on the web preview always.
- `client.ts`: the photo routes through the typed client; the upload is an XMLHttpRequest for progress.
- `PhotoImage.tsx`: `expo-image` cached by `photoId/variant`, never by the signed URL; the blurhash paints first.
- `PhotosScreen.tsx` asks for `thumb`; `PhotoZoomScreen.tsx` is the only place `full` is requested (rules/mobile.md Images).
