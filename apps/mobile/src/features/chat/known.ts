import { photoWithKnownDescription } from "@kuutti/schema";

/**
 * A message as the API sent it, its photo's description as this build can say
 * it (#296, #350): a scene or object key it has no words for is left out, so a
 * newer API's label never fails a whole page or a frame. Anything else is
 * handed back as it is, for the parse to refuse.
 */
export function messageWithKnownDescription(message: unknown): unknown {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return message;
  const { photo } = message as { photo?: unknown };
  return photo === undefined ? message : { ...message, photo: photoWithKnownDescription(photo) };
}
