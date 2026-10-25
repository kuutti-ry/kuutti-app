# lib

Horizontal code every slice uses and none owns: db client, config, logger, S3, SSM, auth middleware, mail and push out. Not a slice.

- `push.ts` (#102, ADR-055 §8): the seam to Expo's push service (`expoPusher`, a hundred pushes a request, five seconds at most, the access token when one is set), a log of the kinds for development and test (`logPusher`), or none (`pusherFor` by `PUSH`). A refused request is `PushFailed`, by Expo's code or the status alone, never a token. Whom to tell is the notifications slice's.
