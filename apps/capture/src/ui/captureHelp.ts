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
      'Settings are on the panel ahead of you.'
    ];
  }
  if (mode === 'ar') return ['Recenter AR places the scene in front of you again.'];
  if (touch) {
    return [
      'Drag on the left of the screen to walk.',
      'Drag anywhere else to look around.',
      'Tap the record circle to start a take, and the square to stop it.',
      'Touch and hold the scene to mark "this"; slide to aim, lift to finish.',
      'Hold the Halo glyph and slide: down records or stops, left undoes the last mark, right restores it.'
    ];
  }
  return [
    'W, A, S and D walk; Space jumps; hold C to crouch; V switches between third and first person.',
    'Click the scene to look with the mouse; hold the right button or F to point and mark "this".',
    'Hold B and move the mouse for the Halo: down records or stops, left undoes the last mark, right restores it.',
    'R starts and stops a take.',
    'G picks up or puts down the object; Q and E turn it, Z and X tip it.',
    'Hold T for the tray and press 1 to 5 to summon an item.'
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
