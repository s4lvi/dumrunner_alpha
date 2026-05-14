// Detect a touch-primary device on the client. Two heuristics
// combined so we don't false-positive on dev laptops with
// touchscreens:
//   - pointer:coarse means the primary input has imprecise
//     hit area (a finger, not a mouse)
//   - hover:none means the device can't sustain a hover state
//     (touchscreens can't, mice can)
// Together they filter to "touch is the only realistic input."
//
// The hook returns null during SSR (no window) and re-runs the
// media-query check when orientation changes, since some browsers
// flip the pointer media query when an external keyboard /
// trackpad is connected to a tablet.

'use client';

import { useEffect, useState } from 'react';

export function useIsTouchDevice(): boolean {
  // Initialise to false so the first SSR-paired client render
  // matches SSR's "no overlay" output; we re-evaluate on mount.
  const [isTouch, setIsTouch] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const coarse = window.matchMedia('(pointer: coarse)');
    const noHover = window.matchMedia('(hover: none)');
    const evaluate = (): void => {
      setIsTouch(coarse.matches && noHover.matches);
    };
    evaluate();
    coarse.addEventListener('change', evaluate);
    noHover.addEventListener('change', evaluate);
    return () => {
      coarse.removeEventListener('change', evaluate);
      noHover.removeEventListener('change', evaluate);
    };
  }, []);
  return isTouch;
}
