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
    element.style.cssText = [
      'position:fixed', 'left:0', 'top:0', 'width:26px', 'height:26px', 'margin:-13px 0 0 -13px',
      'border-radius:50%', 'box-sizing:border-box', 'pointer-events:none', 'z-index:20', 'display:none',
      'border:2px solid rgba(255,255,255,0.95)', 'box-shadow:0 0 0 1px rgba(0,0,0,0.45), inset 0 0 0 1px rgba(0,0,0,0.35)'
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
    style.opacity = landed ? '1' : '0.7';
    this.element.dataset.landed = landed ? 'true' : 'false';
  }

  hide(): void {
    this.element.style.display = 'none';
  }
}
