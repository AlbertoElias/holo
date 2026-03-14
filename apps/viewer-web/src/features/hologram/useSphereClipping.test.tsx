import React from "react";
import { render } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, SphereGeometry } from "three";

import {
  useSphereClipping,
  type SphereClipConfig,
  type SphereClipResult,
  type SphereClipStatus
} from "./useSphereClipping";

vi.mock("@react-three/fiber", () => ({
  useFrame: () => undefined
}));

type HookHarnessProps = {
  scene: Group;
  config: SphereClipConfig;
  capture: { current: SphereClipResult | null };
};

function HookHarness({ scene, config, capture }: HookHarnessProps) {
  const result = useSphereClipping(scene, config);
  const captureRef = useRef(capture);
  captureRef.current.current = result;
  return null;
}

function createBubbleMesh(): Mesh {
  const bubble = new Mesh(
    new SphereGeometry(6, 12, 8),
    new MeshStandardMaterial({ color: 0x4488ff })
  );
  bubble.name = "RecordedBubbleSphere";
  return bubble;
}

describe("useSphereClipping safe fallback", () => {
  it("returns inactive + missing-bubble status when bubble mesh is not present", () => {
    const scene = new Group();
    scene.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0xffffff })));
    const capture = { current: null as SphereClipResult | null };
    const statuses: SphereClipStatus[] = [];

    render(
      <HookHarness
        scene={scene}
        capture={capture}
        config={{
          falloffWidth: 0.9,
          onStatus: (status) => statuses.push(status)
        }}
      />
    );

    expect(statuses).toContain("missing-bubble");
    expect(capture.current?.active).toBe(false);
    expect(capture.current?.radius).toBe(0);
  });

  it("emits error status and does not throw when setup fails in safe mode", () => {
    const scene = new Group();
    scene.add(createBubbleMesh());

    const broken = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0xff00ff }));
    (broken as unknown as { material?: unknown }).material = undefined;
    scene.add(broken);

    const capture = { current: null as SphereClipResult | null };
    const statuses: SphereClipStatus[] = [];
    const errors: Error[] = [];

    render(
      <HookHarness
        scene={scene}
        capture={capture}
        config={{
          falloffWidth: 0.9,
          safeMode: true,
          onStatus: (status) => statuses.push(status),
          onError: (error) => errors.push(error)
        }}
      />
    );

    expect(statuses).toContain("error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(capture.current?.active).toBe(false);
  });

  it("emits enabled status when bubble setup succeeds", () => {
    const scene = new Group();
    scene.add(createBubbleMesh());
    scene.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0x22ffaa })));

    const capture = { current: null as SphereClipResult | null };
    const statuses: SphereClipStatus[] = [];

    render(
      <HookHarness
        scene={scene}
        capture={capture}
        config={{
          falloffWidth: 0.9,
          onStatus: (status) => statuses.push(status)
        }}
      />
    );

    expect(statuses).toContain("enabled");
    expect(capture.current?.active).toBe(true);
    expect((capture.current?.radius ?? 0) > 0).toBe(true);
  });
});
