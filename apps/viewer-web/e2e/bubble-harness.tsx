// Test-only entry point served by Vite, excluded from the production bundle.
import React, { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Canvas, useThree } from "@react-three/fiber";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, SphereGeometry } from "three";
import { useSphereClipping } from "../src/features/hologram/useSphereClipping";

const scene = new Group();
const shell = new Mesh(new SphereGeometry(2, 32, 24), new MeshBasicMaterial());
shell.name = "RecordedBubbleSphere";
const geometry = new BoxGeometry(1, 1, 1);
const originals = [new MeshBasicMaterial({ color: "#ff0000" }), new MeshBasicMaterial({ color: "#00ff00" })];
geometry.groups.forEach((group, index) => { group.materialIndex = index % 2; });
const displaced = geometry.getAttribute("position").clone();
for (let index = 0; index < displaced.count; index++) displaced.setX(index, displaced.getX(index) + 3);
geometry.morphAttributes.position = [displaced];
geometry.computeBoundingSphere();
const grouped = new Mesh(geometry, originals);
grouped.position.x = 0.7;
scene.add(shell, grouped);
const state = { scene, shell, grouped, originals, mounts: 0, disposals: 0, renderer: null as unknown, renderScene: null as unknown, camera: null as unknown, result: null as unknown };
const tracked = new WeakSet();
function Model({ falloff }: { falloff: number }) {
  const result = useSphereClipping(scene, { falloffWidth: falloff });
  const { gl, scene: renderScene, camera } = useThree();
  useLayoutEffect(() => {
    state.renderer = gl; state.renderScene = renderScene; state.camera = camera; state.result = result;
    [shell, grouped].flatMap((mesh) => Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((material) => {
      if (!tracked.has(material)) { tracked.add(material); state.mounts++; material.addEventListener("dispose", () => { state.disposals++; }); }
    });
  });
  return <primitive object={scene} dispose={null} />;
}
function App() {
  const [mounted, mount] = useState(true);
  const [falloff, setFalloff] = useState(0.2);
  Object.assign(window, { __bubbleLifecycle: state, __bubbleMount: mount, __bubbleFalloff: setFalloff });
  return <Canvas camera={{ position: [0, 0, 5] }}><>{mounted && <Model falloff={falloff} />}</></Canvas>;
}
createRoot(document.getElementById("root")!).render(<App />);
