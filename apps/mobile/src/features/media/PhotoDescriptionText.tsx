import { Text } from "@/components/ui/text";

/**
 * The automatic description under a photo, for the eye (#296), where the
 * Photo descriptions setting asks for it. The photo's own label already says
 * it to a screen reader, after the caption, so the text is not an element of
 * its own there: the description is heard once, with the picture.
 */
export function PhotoDescriptionText({ text }: { text: string }) {
  return (
    <Text
      variant="muted"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {text}
    </Text>
  );
}
