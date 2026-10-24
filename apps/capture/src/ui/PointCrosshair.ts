import { tokens } from '@holoim/design-tokens';

/**
 * Desktop point action chrome: a DOM crosshair at the screen position where the
 * aim ray lands. It lives outside the scene, so it is never recorded or exported.
 */
export class PointCrosshair {
  private readonly element: HTMLDivElement;

  constructor(parent: HTMLElement) {
    const element = document.createElement('div');
    element.id = 'point-crosshair';
    element.setAttribute('aria-hidden', 'true');
    // A gold glyph ring at the icon size (styleguide 6): a thin line, no glow.
    const size = tokens.glyph.icon;
    element.style.cssText = [
      'position:fixed', 'left:0', 'top:0', `width:${size}px`, `height:${size}px`, `margin:${-size / 2}px 0 0 ${-size / 2}px`,
      'border-radius:50%', 'box-sizing:border-box', 'pointer-events:none', 'z-index:20', 'display:none',
      `border:${tokens.glyph.stroke}px solid var(--holoim-color-gold)`
    ].join(';');
    parent.appendChild(element);
    this.element = element;
  }

  /** `screen` is in CSS pixels; `landed` is false when the ray reaches only sky. */
  show(screen: { x: number; y: number }, landed: boolean): void {
    const style = this.element.style;
    style.display = 'block';
    style.transform = `translate(${screen.x.toFixed(1)}px, ${screen.y.toFixed(1)}px)`;
    style.borderStyle = landed ? 'solid' : 'dashed';
    style.opacity = landed ? '1' : String(tokens.glyph.idleOpacity);
    this.element.dataset.landed = landed ? 'true' : 'false';
  }

  hide(): void {
    this.element.style.display = 'none';
  }
}
