import * as DialogPrimitive from "@rn-primitives/dialog";
import X from "lucide-react-native/icons/x";
import * as React from "react";
import {
  type GestureResponderEvent,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  View,
  type ViewProps,
} from "react-native";
import { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { FullWindowOverlay as RNFullWindowOverlay } from "react-native-screens";
import { Icon } from "@/components/ui/icon";
import { NativeOnlyAnimatedView } from "@/components/ui/native-only-animated-view";
import { cn } from "@/lib/utils";
import { MAX_FONT_SCALE, TOUCH_TARGET } from "@/theme/a11y";

// From React Native Reusables (#12, TD-9), adapted: the close control is a
// labelled 44 pt button (closeLabel is required), the scrim is a token,
// entering and exiting animations follow the OS reduce-motion setting, and
// the title and the description keep the app's cap on text size, as the
// Text primitive does (the primitive's own are plain React Native text).
const MINIMUM_TARGET = { minHeight: TOUCH_TARGET, minWidth: TOUCH_TARGET };

// The dialog shrinks into the space it is given rather than overflow it; a
// caller's own cap (a share of the window) holds while that space is larger.
const SHRINK = { flexShrink: 1 };

// The close control lies over the corner, out of the flow, so a title would run
// under it (#530). DialogContent alone draws it, so only a title inside one
// gives up width. The text below, lower than the control reaches, gives up none.
const HasClose = React.createContext(false);

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
  const statusBar = React.useContext(SafeAreaInsetsContext)?.top ?? 0;
  const android = Platform.OS === "android";

  // A keyboard the screen behind left up (the conversation's composer) goes
  // as the dialog opens, once per open, as for the platforms' own dialogs: on
  // Android the view below learns where the keyboard is only when it moves; on
  // iOS the full-window overlay lies below the keyboard's window, so the
  // keyboard would cover the dialog and the first tap in a scroll view would
  // only put it away (#351). The overlay mounts as the dialog opens, before
  // anything in it is focused, so a field inside keeps its own keyboard. The
  // web preview has no such keyboard.
  React.useEffect(() => {
    if (Platform.OS !== "web") Keyboard.dismiss();
  }, []);

  function onOverlayPress(event: GestureResponderEvent) {
    onPress?.(event);
    if (event.target === event.currentTarget && !event.isDefaultPrevented()) {
      onOpenChange(false);
    }
  }

  const dialog = (
    <NativeOnlyAnimatedView
      entering={FadeIn.delay(50).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(150).reduceMotion(ReduceMotion.System)}
      style={SHRINK}
    >
      {children}
    </NativeOnlyAnimatedView>
  );

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
          {android ? (
            // Android draws the app edge to edge, so the window no longer
            // resizes for the keyboard, and this portal is outside every
            // screen's own avoidance (SettingsPage, the conversation): the
            // dialog's space runs from below the status bar to the keyboard's
            // top, and a dialog taller than that shrinks into it, its scroll
            // view then scrolling the focused field into view just above the
            // keyboard, the field's label above it (#351). Nothing animates:
            // Android's keyboard events carry no duration. On iOS the dialog
            // keeps its place, and its scroll view insets itself instead.
            <KeyboardAvoidingView
              behavior="padding"
              className="flex-1 items-center justify-center self-stretch"
              style={{ paddingTop: statusBar }}
            >
              {dialog}
            </KeyboardAvoidingView>
          ) : (
            dialog
          )}
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
            "bg-background border-border z-50 mx-auto flex w-full max-w-[calc(100%-2rem)] shrink flex-col gap-4 rounded-lg border p-6 sm:max-w-lg",
            Platform.select({
              web: "animate-in fade-in-0 zoom-in-95 duration-200",
            }),
            className,
          )}
          {...props}
        >
          <HasClose.Provider value={true}>{children}</HasClose.Provider>
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
  const hasClose = React.useContext(HasClose);
  return (
    <DialogPrimitive.Title
      // pr-8 ends the title where the close control starts: past the content's
      // padding the control takes 26.5 pt on a phone (rem 14) and 24 on the web.
      className={cn(
        "font-sans text-foreground text-lg font-semibold",
        hasClose && "pr-8",
        className,
      )}
      maxFontSizeMultiplier={MAX_FONT_SCALE}
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
      className={cn("font-sans text-muted-foreground text-sm", className)}
      maxFontSizeMultiplier={MAX_FONT_SCALE}
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
