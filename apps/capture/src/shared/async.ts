/**
 * Resolves on the next animation frame, or after `fallbackMs` when frames are
 * throttled (headset asleep, XR session ended), so no caller waits forever.
 */
export function nextFrame(fallbackMs = 100): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, fallbackMs);
    requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Rejects with `message` if `promise` has not settled within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
