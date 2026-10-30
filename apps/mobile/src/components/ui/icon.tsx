import type { LucideIcon, LucideProps } from "lucide-react-native";
import { cssInterop } from "nativewind";
import * as React from "react";
import Svg from "react-native-svg";
import { TextClassContext } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { DECORATIVE } from "@/theme/a11y";

type IconProps = LucideProps & { as: LucideIcon } & React.RefAttributes<LucideIcon>;

function IconImpl({ as: IconComponent, ...props }: IconProps) {
  return <IconComponent {...props} />;
}

cssInterop(IconImpl, {
  className: { target: "style", nativeStyleToProp: { height: "size", width: "size" } },
});

/**
 * A lucide icon with className support, from React Native Reusables (#12).
 * Icons are decorative: hidden from screen readers, because the control around
 * them carries the label (Button requires one for icon-only content). Colour
 * comes from the surrounding text class or a token class, never a literal.
 */
function Icon({ as: IconComponent, className, size = 20, ...props }: IconProps) {
  const textClass = React.useContext(TextClassContext);
  return (
    <IconImpl
      as={IconComponent}
      {...DECORATIVE}
      className={cn("text-foreground", textClass, className)}
      size={size}
      {...props}
    />
  );
}

/**
 * An icon drawn here in Lucide's grid and line (24 points, a 2-point stroke
 * in the text colour, round ends), for what Lucide has no icon for. Taken by
 * Icon like any of Lucide's.
 */
function drawn(name: string, children: React.ReactNode): LucideIcon {
  const Drawn = React.forwardRef<Svg, LucideProps>(
    (
      {
        size = 24,
        color = "currentColor",
        strokeWidth = 2,
        absoluteStrokeWidth: _absolute,
        ...props
      },
      ref,
    ) => (
      <Svg
        ref={ref}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        {...props}
      >
        {children}
      </Svg>
    ),
  );
  Drawn.displayName = name;
  return Drawn as LucideIcon;
}

export { drawn, Icon };
