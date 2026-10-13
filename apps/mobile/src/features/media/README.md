# media

The person's photos (#48, TD-2, TD-8): the grid, reordered by dragging a tile (#179), the zoom screen, the upload chain on the phone.

- `pick.ts`: the photo library, then `expo-image-manipulator` re-saves at 1600 px as JPEG, which also drops the original's EXIF.
- `localCheck.ts`: the on-device nudity check runs on the picked file before any byte leaves the phone; a refusal shows one text and sends nothing. The classifier is native and registers itself with `setLocalCheck`; until the native batch lands (#184) every picture passes, on the web preview always.
- `client.ts`: the photo routes through the typed client; the upload is an XMLHttpRequest for progress.
- `PhotoImage.tsx`: `expo-image` cached by `photoId/variant`, never by the signed URL; the blurhash paints first.
- `PhotosScreen.tsx` asks for `thumb`; `PhotoZoomScreen.tsx` is the only place `full` is requested (rules/mobile.md Images).
- `useDragOrder.ts`: the reorder gesture on the platform's own responder system and core `Animated`, no gesture library (a native module would move the fingerprint): a long press lifts the tile, the slot around it takes the touch at the first move and blocks the scroll view, the others slide aside, the drop saves the order once. The lift, the slides and the settling take no time under reduced motion; the drag itself stays. `drag.ts` is the arithmetic: the slot under the finger, where each tile stands meanwhile, the order a drop leaves.
- The same three moves (earlier, later, main) are accessibility actions on every tile, so a screen reader or a switch user has a way that is not a gesture (CLAUDE.md Accessibility).
