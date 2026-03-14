import { Environment } from "@react-three/drei";

type HologramLightingProps = {
  colorAccurate: boolean;
};

export function HologramLighting({ colorAccurate }: HologramLightingProps) {
  if (colorAccurate) {
    return (
      <>
        <ambientLight intensity={0.58} color="#f5f7fa" />
        <hemisphereLight intensity={0.24} color="#ffffff" groundColor="#a8adb5" />
        <directionalLight position={[2.1, 3.8, 1.9]} intensity={0.78} color="#ffffff" />
        <directionalLight position={[-1.8, 2.4, -1.6]} intensity={0.28} color="#f3f6fa" />
      </>
    );
  }

  return (
    <>
      <hemisphereLight intensity={0.95} groundColor="#0b2538" />
      <directionalLight position={[2, 3, 1]} intensity={1.2} />
      <directionalLight position={[-2, 2.5, -2]} intensity={0.45} color="#85d2ff" />
      <Environment preset="city" />
    </>
  );
}
