'use client';

import type { CSSProperties, ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useSwipeAction,
  mobileSwipeVibrate,
  type SwipeSide,
} from '@/lib/mobile/use-swipe-action';
import {
  MOBILE_BODY_TRACKING,
  MOBILE_CARD_RADIUS,
  type MobilePalette,
} from '@/app/mobile/mobile-approvals-shared';

/**
 * Wraps a card with horizontal swipe-to-action gestures.
 *
 * Swipe right → reveals the right action label (default: green Approve).
 * Swipe left  → reveals the left  action label (default: red Reject).
 *
 * On release past threshold the card holds open in a confirmation strip
 * ("Confirm" / "Cancel") instead of auto-firing — protects against accidental
 * approves. Confirm calls the matching `onLeftSwipe` / `onRightSwipe` handler.
 */

export interface SwipeActionsProps {
  /** Card content (e.g. an ApprovalCard) — sits on top of the action layer. */
  children: ReactNode;
  /** Fired on Confirm after a left swipe. */
  onLeftSwipe?: () => void;
  /** Fired on Confirm after a right swipe. */
  onRightSwipe?: () => void;
  leftLabel?: string;
  rightLabel?: string;
  /** Background colors for the revealed action lanes. */
  leftColor?: string;
  rightColor?: string;
  /** Confirmation step labels. */
  leftConfirmLabel?: string;
  rightConfirmLabel?: string;
  /** Vibrate pattern fired on the Confirm tap (success-rhythm by default). */
  leftConfirmHaptic?: number | number[];
  rightConfirmHaptic?: number | number[];
  /** Pixel threshold for triggering confirmation. Defaults to 80. */
  threshold?: number;
  /** Hide all swipe behavior (e.g. while loading). */
  disabled?: boolean;
  /** Palette for the confirm/cancel strip. */
  palette: MobilePalette;
  /** Wrapper style (border-radius etc.). */
  style?: CSSProperties;
  /** Expand below short rows instead of overlaying their content. */
  confirmationPlacement?: 'overlay' | 'below';
}

interface ConfirmingState {
  side: SwipeSide;
}

export function SwipeActions({
  children,
  onLeftSwipe,
  onRightSwipe,
  leftLabel = 'Reject',
  rightLabel = 'Approve',
  leftColor,
  rightColor,
  leftConfirmLabel = 'Confirm reject',
  rightConfirmLabel = 'Confirm approve',
  leftConfirmHaptic,
  rightConfirmHaptic,
  threshold = 80,
  disabled = false,
  palette,
  style,
  confirmationPlacement = 'overlay',
}: SwipeActionsProps) {
  const [confirming, setConfirming] = useState<ConfirmingState | null>(null);
  const suppressClick = useRef(false);

  const handleCommit = useCallback((committedSide: SwipeSide) => {
    // Threshold-cross haptic already fired on the way out; this buzz is the
    // "you can lift your finger now" cue as the strip latches.
    mobileSwipeVibrate(committedSide === 'right' ? 12 : [10, 30]);
    setConfirming({ side: committedSide });
  }, []);

  const handleThresholdCross = useCallback(() => {
    mobileSwipeVibrate(5);
  }, []);

  const swipe = useSwipeAction({
    threshold,
    onCommit: handleCommit,
    onThresholdCross: handleThresholdCross,
    disabled: disabled || confirming !== null,
  });
  const swipeReset = swipe.reset;

  useEffect(() => {
    if (swipe.side) suppressClick.current = true;
  }, [swipe.side]);

  const handleConfirm = useCallback(() => {
    if (!confirming) return;
    if (confirming.side === 'right') {
      mobileSwipeVibrate(rightConfirmHaptic ?? 20);
      onRightSwipe?.();
    } else {
      mobileSwipeVibrate(leftConfirmHaptic ?? [10, 30, 10]);
      onLeftSwipe?.();
    }
    setConfirming(null);
    swipeReset();
  }, [confirming, leftConfirmHaptic, onLeftSwipe, onRightSwipe, rightConfirmHaptic, swipeReset]);

  const handleCancel = useCallback(() => {
    setConfirming(null);
    suppressClick.current = false;
    swipeReset();
  }, [swipeReset]);

  const visibleSide = confirming?.side ?? swipe.side;
  const showLeftLane = visibleSide === 'left';
  const showRightLane = visibleSide === 'right';

  // While confirming, hold the card pinned at threshold distance so the
  // action lane stays visible behind the strip.
  const pinnedOffset = confirming
    ? (confirming.side === 'right' ? threshold : -threshold)
    : swipe.offset;

  const resolvedLeftColor = leftColor ?? palette.danger;
  const resolvedRightColor = rightColor ?? palette.success;

  return (
    <div
      style={{
        position: 'relative',
        borderRadius: MOBILE_CARD_RADIUS,
        overflow: 'hidden',
        // Allow vertical scroll to pass through; we own horizontal.
        touchAction: 'pan-y',
        ...style,
      }}
    >
      {/* Action lanes (rendered behind the card). Only paint when relevant
          to avoid an unnecessary repaint on resting cards. */}
      {(showLeftLane || showRightLane) ? (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'stretch',
            justifyContent: showRightLane ? 'flex-start' : 'flex-end',
            background: showRightLane ? resolvedRightColor : resolvedLeftColor,
            color: '#ffffff',
            fontSize: 13,
            fontWeight: 800,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            paddingLeft: 20,
            paddingRight: 20,
            pointerEvents: 'none',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center' }}>
            {showRightLane ? rightLabel : leftLabel}
          </span>
        </div>
      ) : null}

      {/* The actual card. translateX follows the finger; transition snaps it
          back when the gesture releases (or pins to threshold while
          confirming). */}
      <div
        {...swipe.handlers}
        onPointerDown={(event) => {
          suppressClick.current = false;
          swipe.handlers.onPointerDown(event);
        }}
        onClickCapture={(event) => {
          if (confirming || (suppressClick.current && event.detail !== 0)) {
            event.preventDefault();
            event.stopPropagation();
            suppressClick.current = false;
          }
        }}
        inert={confirming !== null}
        style={{
          position: 'relative',
          transform: `translate3d(${pinnedOffset}px, 0, 0)`,
          transition: swipe.swiping
            ? 'none'
            : 'transform 220ms cubic-bezier(0.34, 1.36, 0.64, 1)',
          willChange: swipe.swiping ? 'transform' : undefined,
          // Hide swipe-revealed visuals during confirmation so the strip below
          // is the unambiguous next step.
          opacity: confirming ? 0.4 : 1,
        }}
      >
        {children}
      </div>

      {/* Confirmation strip — slides in from below the pinned card. */}
      {confirming ? (
        <div
          role="alertdialog"
          aria-label={confirming.side === 'right' ? rightConfirmLabel : leftConfirmLabel}
          style={{
            position: confirmationPlacement === 'below' ? 'relative' : 'absolute',
            left: confirmationPlacement === 'below' ? undefined : 0,
            right: confirmationPlacement === 'below' ? undefined : 0,
            bottom: confirmationPlacement === 'below' ? undefined : 0,
            display: 'grid',
            gridTemplateColumns: '1fr auto',
            gap: 8,
            paddingTop: 12,
            paddingBottom: 12,
            paddingLeft: 12,
            paddingRight: 12,
            background: confirming.side === 'right' ? resolvedRightColor : resolvedLeftColor,
            borderTop: `1px solid ${palette.cardBorder}`,
          }}
        >
          <button
            type="button"
            onClick={handleConfirm}
            style={{
              minHeight: 44,
              borderRadius: MOBILE_CARD_RADIUS,
              border: 'none',
              background: 'rgba(255, 255, 255, 0.95)',
              color: confirming.side === 'right' ? resolvedRightColor : resolvedLeftColor,
              fontSize: 14,
              fontWeight: 800,
              letterSpacing: MOBILE_BODY_TRACKING,
              cursor: 'pointer',
              touchAction: 'manipulation',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            {confirming.side === 'right' ? rightConfirmLabel : leftConfirmLabel}
          </button>
          <button
            type="button"
            onClick={handleCancel}
            style={{
              minHeight: 44,
              paddingLeft: 18,
              paddingRight: 18,
              borderRadius: MOBILE_CARD_RADIUS,
              border: '1px solid rgba(255, 255, 255, 0.4)',
              background: 'transparent',
              color: '#ffffff',
              fontSize: 14,
              fontWeight: 700,
              letterSpacing: MOBILE_BODY_TRACKING,
              cursor: 'pointer',
              touchAction: 'manipulation',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}
