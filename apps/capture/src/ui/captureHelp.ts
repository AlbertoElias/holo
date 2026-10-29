import type { AppMode } from '../types/contracts';

// How to drive capture, in the words of the device in hand (styleguide 9.3:
// touch words on a touch device, never desktop keyboard help). Long text, so
// it lives in the settings side sheet, never on the stage.
export function captureHelp(mode: AppMode, touch: boolean): string[] {
  if (mode === 'vr' || mode === 'mock-vr') {
    return [
      'Hold a neutral standing or seated posture briefly to fit your height; choose Refit height after you switch.',
      'Record with the glyph on your non-dominant wrist: touch it, or point at it and press select.',
      'During a take, pinch thumb to middle finger on your non-dominant hand, or hold its trigger, to mark what your other hand points at.',
      'For the Halo, pinch thumb to middle finger on your dominant hand and move it, or press the non-dominant stick and tilt it: down records or stops, left undoes the last mark, right restores it.',
      'Turn your non-dominant palm up (or hold Y) to open the tray, then pinch or squeeze an item with your dominant hand to summon it, before or during a take; Find on your wrist searches for more.',
      'Holding an object, grab it with your other hand too and pull your hands apart or together to resize it; near its first size it snaps back.',
      'Point at an object out of reach and squeeze to bring it to your hand; push the right stick up or down to send a held object further out or bring it back.',
      'Settings are on the panel ahead of you.'
    ];
  }
  if (mode === 'ar') {
    return ['Recenter AR places the scene in front of you again.', 'Tap Tray, then an item to place it where the centre of the screen points.'];
  }
  if (touch) {
    return [
      'Drag on the left of the screen to walk.',
      'Drag anywhere else to look around.',
      'Tap the record circle to start a take, and the square to stop it.',
      'Touch and hold the scene to mark "this"; slide to aim, lift to finish.',
      'Tap the Halo glyph, or hold it and slide: left undoes the last mark, right restores it.',
      'Tap Tray, then tap an item to summon it, before or during a take; Find searches for more.',
      'Tap an object, near or far, to take it into your hand.',
      'Holding an object, pinch with two fingers to resize it (near its first size it snaps back), or slide two fingers up or down to push it further out or bring it back. Tap to let go.'
    ];
  }
  return [
    'W, A, S and D walk; Space jumps; hold C to crouch; V switches between third and first person.',
    'Click the scene to look with the mouse; hold the right button or F to point and mark "this".',
    'Click the Halo glyph, or hold B and move the mouse, for the Halo: left undoes the last mark, right restores it.',
    'R starts and stops a take.',
    'Hold T to open the tray and press 1 to 5 to summon, before or during a take; Find searches for more.',
    'G picks up the nearest object in reach, or click one at the centre of the view; Q and E turn it, Z and X tip it.',
    'Press G or click again to let go: held still, the object is set down; while you swing or walk, it is thrown.',
    'Click an object out of reach to bring it to your hand.',
    'While holding, scroll or press - and = to resize it, and 0 for its first size; hold Shift and scroll to push it further out or bring it back.'
  ];
}

/** A coarse primary pointer: the page is being driven by touch. */
export function isTouchDevice(): boolean {
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}
