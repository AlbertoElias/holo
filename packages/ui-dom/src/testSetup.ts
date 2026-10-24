import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom has no PointerEvent; a MouseEvent with the pointer fields stands in, so
// fireEvent.pointer* carries coordinates, a pointer id and a type like a browser's.
if (typeof window.PointerEvent === "undefined") {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? "mouse";
    }
  }
  Object.defineProperty(window, "PointerEvent", { value: TestPointerEvent, configurable: true, writable: true });
}

afterEach(() => cleanup());
