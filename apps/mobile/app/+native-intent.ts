import { holdLinkWhileUnsaved } from "@/features/profile";

/**
 * Every link from outside the app passes here first (Expo Router). While a
 * screen holds something unsaved, the link waits for the person's word
 * (ConfirmLeave.tsx, #285); otherwise it goes through as it is.
 */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
  return holdLinkWhileUnsaved(path, initial);
}
