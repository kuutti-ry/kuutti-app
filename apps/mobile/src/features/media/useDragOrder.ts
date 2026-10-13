import { useRef, useState } from "react";
import { Animated, type GestureResponderEvent, type LayoutChangeEvent } from "react-native";
import { type Box, slotAt, slotWhile } from "./drag";

type Options = {
  /** How many tiles the grid has; a box reported for a tile since removed is ignored. */
  count: number;
  /** Milliseconds for the lift, the slides and the settling; 0 under reduced motion. */
  duration: number;
  /** Once per drop that changed the order, after the tile has settled into its slot. */
  onDrop: (from: number, to: number) => void;
};

type Drag = {
  from: number;
  /** The slot under the finger, `from` until it crosses into another tile. */
  to: number;
  /** True once the wrapping view holds the touch; false between the long press and the first move. */
  granted: boolean;
  startX: number;
  startY: number;
};

/** The lifted tile is drawn this much larger, so it reads as picked up. */
const LIFT = 1.05;

/**
 * Reordering the photo grid by dragging a tile (#179), on the platform's own
 * responder system rather than a gesture library: the grid is six tiles at
 * most, and a native module would move the fingerprint (rules/mobile.md).
 *
 * A long press on the tile lifts it. The view wrapping the tile then takes
 * the touch from the pressable at the first move, and blocks the scroll view
 * underneath for the rest of it. Each move puts the tile under the finger and
 * slides the others out of its way; the release settles it into the slot it
 * is over and reports the move once. The drag itself is direct manipulation
 * and stays under reduced motion; the lift, the slides and the settling are
 * animations and take the duration the caller gives, 0 when motion is reduced.
 */
export function useDragOrder({ count, duration, onDrop }: Options) {
  const [active, setActive] = useState<number | null>(null);
  const boxes = useRef<Box[]>([]);
  const offsets = useRef(new Map<number, Animated.ValueXY>()).current;
  const lift = useRef(new Animated.Value(1)).current;
  const drag = useRef<Drag | null>(null);
  // The latest callback, so a drop reaches the order as it is now, not as it
  // was when the gesture began.
  const drop = useRef(onDrop);
  drop.current = onDrop;

  const offsetOf = (index: number): Animated.ValueXY => {
    const known = offsets.get(index);
    if (known) return known;
    const offset = new Animated.ValueXY();
    offsets.set(index, offset);
    return offset;
  };
  const animate = (
    value: Animated.Value | Animated.ValueXY,
    toValue: number | { x: number; y: number },
    done?: () => void,
  ) => Animated.timing(value, { toValue, duration, useNativeDriver: false }).start(done);

  /** Every tile back where the layout puts it, nothing lifted, no drag. */
  const reset = () => {
    for (const offset of offsets.values()) offset.setValue({ x: 0, y: 0 });
    lift.setValue(1);
    drag.current = null;
    setActive(null);
  };

  /** The other tiles slide to where they stand while the lifted one hovers over `to`. */
  const slide = (current: Drag) => {
    const laidOut = boxes.current.slice(0, count);
    laidOut.forEach((box, index) => {
      if (index === current.from) return;
      const target = laidOut[slotWhile(index, current.from, current.to)];
      if (!target) return;
      animate(offsetOf(index), { x: target.x - box.x, y: target.y - box.y });
    });
  };

  const tile = (index: number) => ({
    onLayout: (event: LayoutChangeEvent) => {
      boxes.current[index] = event.nativeEvent.layout;
    },
    /** The long press lifts the tile; the next move starts the drag. */
    onLongPress: () => {
      if (drag.current) return;
      drag.current = { from: index, to: index, granted: false, startX: 0, startY: 0 };
      setActive(index);
      animate(lift, LIFT);
    },
    /**
     * A finger lifted without a move puts the tile down again. Checked a tick
     * later: the hand-off to the wrapping view ends the press too, just before
     * the grant, and that one is a drag.
     */
    onPressOut: () => {
      queueMicrotask(() => {
        const current = drag.current;
        if (current && current.from === index && !current.granted) reset();
      });
    },
    /** The lifted tile is drawn over its neighbours. */
    zIndex: active === index ? 1 : 0,
    transform: [...offsetOf(index).getTranslateTransform(), { scale: active === index ? lift : 1 }],
    responder: {
      onMoveShouldSetResponderCapture: () => drag.current?.from === index,
      onResponderGrant: (event: GestureResponderEvent) => {
        const current = drag.current;
        if (current === null || current.from !== index) return false;
        current.granted = true;
        current.startX = event.nativeEvent.pageX;
        current.startY = event.nativeEvent.pageY;
        // True keeps the native scroll view from taking the touch for a scroll.
        return true;
      },
      onResponderMove: (event: GestureResponderEvent) => {
        const current = drag.current;
        if (!current?.granted) return;
        const dx = event.nativeEvent.pageX - current.startX;
        const dy = event.nativeEvent.pageY - current.startY;
        offsetOf(current.from).setValue({ x: dx, y: dy });
        const box = boxes.current[current.from];
        if (!box) return;
        const to = slotAt(
          boxes.current.slice(0, count),
          box.x + box.width / 2 + dx,
          box.y + box.height / 2 + dy,
        );
        if (to === null || to === current.to) return;
        current.to = to;
        slide(current);
      },
      onResponderRelease: () => {
        const current = drag.current;
        if (!current?.granted) return;
        const from = boxes.current[current.from];
        const to = boxes.current[current.to];
        const rest = from && to ? { x: to.x - from.x, y: to.y - from.y } : { x: 0, y: 0 };
        animate(offsetOf(current.from), rest, () => {
          if (current.to !== current.from) drop.current(current.from, current.to);
          reset();
        });
      },
      // An incoming call, a system gesture: the tile goes back, nothing is saved.
      onResponderTerminate: reset,
      // Another view's touch (a second finger) does not take the tile away.
      onResponderTerminationRequest: () => false,
    },
  });

  return { active, tile };
}
