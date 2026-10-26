import { tokens } from '@holoim/design-tokens';

import { STICK_TRAVEL_APX, type TouchStick } from '../input/TouchInput';

/**
 * The walk stick, drawn only while a finger holds it (styleguide 1.2: hidden
 * until reached for): a gold ring one stick's travel wide where the finger
 * went down, and a gold dot under the finger. DOM chrome over the canvas,
 * so it is never recorded or exported.
 */
export class TouchStickView {
  private readonly ring: HTMLDivElement;
  private readonly dot: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.ring = document.createElement('div');
    this.dot = document.createElement('div');
    this.ring.dataset.touchStick = 'ring';
    this.dot.dataset.touchStick = 'dot';
    const ringSize = STICK_TRAVEL_APX * 2;
    const dotSize = tokens.glyph.icon;
    for (const [element, size] of [[this.ring, ringSize], [this.dot, dotSize]] as const) {
      element.setAttribute('aria-hidden', 'true');
      element.style.cssText = [
        'position:fixed', 'left:0', 'top:0', `width:${size}px`, `height:${size}px`, `margin:${-size / 2}px 0 0 ${-size / 2}px`,
        'border-radius:50%', 'box-sizing:border-box', 'pointer-events:none', 'z-index:11', 'display:none'
      ].join(';');
      parent.appendChild(element);
    }
    this.ring.style.border = `${tokens.glyph.stroke}px solid var(--holoim-color-gold)`;
    this.dot.style.background = 'var(--holoim-color-gold)';
  }

  update(stick: TouchStick | null): void {
    for (const element of [this.ring, this.dot]) element.style.display = stick ? 'block' : 'none';
    if (!stick) return;
    const dx = stick.current.x - stick.origin.x;
    const dy = stick.current.y - stick.origin.y;
    const length = Math.hypot(dx, dy);
    const clamp = length > STICK_TRAVEL_APX ? STICK_TRAVEL_APX / length : 1;
    this.ring.style.transform = `translate(${stick.origin.x}px, ${stick.origin.y}px)`;
    this.dot.style.transform = `translate(${stick.origin.x + dx * clamp}px, ${stick.origin.y + dy * clamp}px)`;
  }
}
