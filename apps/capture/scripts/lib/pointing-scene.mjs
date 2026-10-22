// Named targets of fixtures/scenes/pointing-targets.gltf, in scene metres.
// The scene generator builds them; the take generator and the check aim at
// them. Capture's rig faces -Z at spawn, so these sit ahead, left and right.
export const TARGETS = {
  TargetA: { center: [-1.1, 1.25, -2.6], size: 0.5, color: [0.9, 0.2, 0.15, 1] },
  TargetB: { center: [1.1, 1.25, -2.6], size: 0.5, color: [0.15, 0.35, 0.9, 1] }
};
