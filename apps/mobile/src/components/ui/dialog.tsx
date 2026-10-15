import * as DialogPrimitive from "@rn-primitives/dialog";
import X from "lucide-react-native/icons/x";
import * as React from "react";
import { type GestureResponderEvent, Platform, View, type ViewProps } from "react-native";
import { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { FullWindowOverlay as RNFullWindowOverlay } from "react-native-screens";
import { Icon } from "@/components/ui/icon";
import { NativeOnlyAnimatedView } from "@/components/ui/native-only-animated-view";
import { cn } from "@/lib/utils";
import { TOUCH_TARGET } from "@/theme/a11y";

// From React Native Reusables (#12, TD-9), adapted: the close control is a
// labelled 44 pt button (closeLabel is required), the scrim is a token, and
// entering and exiting animations follow the OS reduce-motion setting.
const MINIMUM_TARGET = { minHeight: TOUCH_TARGET, minWidth: TOUCH_TARGET };

const Dialog = DialogPrimitive.Root;

const DialogPortal = DialogPrimitive.Portal;

const FullWindowOverlay = Platform.OS === "ios" ? RNFullWindowOverlay : React.Fragment;

function DialogOverlay({
  className,
  children,
  onPress,
  ...props
}: Omit<React.ComponentProps<typeof DialogPrimitive.Overlay>, "asChild"> & {
  children?: React.ReactNode;
}) {
  const { onOpenChange } = DialogPrimitive.useRootContext();

  function onOverlayPress(event: GestureResponderEvent) {
    onPress?.(event);
    if (event.target === event.currentTarget && !event.isDefaultPrevented()) {
      onOpenChange(false);
    }
  }

  return (
    <FullWindowOverlay>
      <DialogPrimitive.Overlay
        className={cn(
          "absolute bottom-0 left-0 right-0 top-0 flex items-center justify-center bg-overlay/60 p-2",
          Platform.select({
            web: "animate-in fade-in-0 fixed cursor-default [&>*]:cursor-auto",
          }),
          className,
        )}
        {...props}
        // The scrim closes the dialog for a tap outside it. As an accessibility
        // element it would swallow the dialog into one unlabelled node; screen
        // readers close with the labelled control inside.
        accessible={false}
        onPress={Platform.select({ web: onOverlayPress, native: onPress })}
        asChild={Platform.OS !== "web"}
      >
        <NativeOnlyAnimatedView
          entering={FadeIn.duration(200).reduceMotion(ReduceMotion.System)}
          exiting={FadeOut.duration(150).reduceMotion(ReduceMotion.System)}
          as="Pressable"
        >
          <NativeOnlyAnimatedView
            entering={FadeIn.delay(50).reduceMotion(ReduceMotion.System)}
            exiting={FadeOut.duration(150).reduceMotion(ReduceMotion.System)}
          >
            {children}
          </NativeOnlyAnimatedView>
        </NativeOnlyAnimatedView>
      </DialogPrimitive.Overlay>
    </FullWindowOverlay>
  );
}
function DialogContent({
  className,
  portalHost,
  closeLabel,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  portalHost?: string;
  /** Read by screen readers for the close control; an i18n string, never inline. */
  closeLabel: string;
}) {
  return (
    <DialogPortal hostName={portalHost}>
      <DialogOverlay>
        <DialogPrimitive.Content
          accessibilityViewIsModal
          className={cn(
            "bg-background border-border z-50 mx-auto flex w-full max-w-[calc(100%-2rem)] flex-col gap-4 rounded-lg border p-6 sm:max-w-lg",
            Platform.select({
              web: "animate-in fade-in-0 zoom-in-95 duration-200",
            }),
            className,
          )}
          {...props}
        >
          {children}
          <DialogPrimitive.Close
            accessibilityRole="button"
            accessibilityLabel={closeLabel}
            aria-label={closeLabel}
            className={cn(
              "absolute right-1 top-1 min-h-touch min-w-touch items-center justify-center rounded-md active:bg-accent",
              Platform.select({
                web: "hover:bg-accent focus-visible:ring-ring outline-none focus-visible:ring-2",
              }),
            )}
            style={MINIMUM_TARGET}
          >
            <Icon as={X} className="text-foreground" />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogOverlay>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: ViewProps) {
  return (
    <View className={cn("flex flex-col gap-2 text-center sm:text-left", className)} {...props} />
  );
}

function DialogFooter({ className, ...props }: ViewProps) {
  return (
    <View
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn("text-foreground text-lg font-semibold", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogTitle,
};
