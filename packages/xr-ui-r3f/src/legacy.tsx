import { useFrame } from "@react-three/fiber";
import { Container, Text } from "@react-three/uikit";
import { useMemo, useRef } from "react";
import type { ReactNode } from "react";
import type { Group } from "three";
import { Vector3 } from "three";

import type { PlacementUiState } from "@holoim/xr-ui-core";

export type XrActionSpec = {
  id: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  tone?: "primary" | "ghost" | "danger";
};

type HeadLockedActionBarProps = {
  actions: readonly XrActionSpec[];
  offset?: [number, number, number];
  placement?: PlacementUiState | null;
  children?: ReactNode;
};

const toneStyles = {
  danger: {
    backgroundColor: "#7a2530",
    borderColor: "#ff9ca6",
    textColor: "#fff4f5"
  },
  ghost: {
    backgroundColor: "#112234",
    borderColor: "#6f9cc5",
    textColor: "#d7ebff"
  },
  primary: {
    backgroundColor: "#1a5d8f",
    borderColor: "#8ccfff",
    textColor: "#f6fbff"
  }
} as const;

function resolvePlacementSummary(placement: PlacementUiState | null | undefined): string | null {
  if (!placement) {
    return null;
  }

  if (placement.anchored) {
    return "Placement anchored to world.";
  }

  if (placement.reason) {
    return `Placement: ${placement.reason.replace(/-/g, " ")}.`;
  }

  if (placement.mode) {
    return `Placement mode: ${placement.mode.replace(/-/g, " ")}.`;
  }

  return null;
}

/** @deprecated Head-locked; replaced by HologramFootControls and WristControls when slice 3 moves the AR route over. */
export function HeadLockedActionBar({
  actions,
  offset = [0, -0.18, -0.85],
  placement,
  children
}: HeadLockedActionBarProps) {
  const groupRef = useRef<Group>(null);
  const offsetVector = useMemo(() => new Vector3(...offset), [offset]);
  const placementSummary = resolvePlacementSummary(placement);

  useFrame(({ camera }) => {
    if (!groupRef.current) {
      return;
    }

    groupRef.current.position.copy(offsetVector).applyQuaternion(camera.quaternion).add(camera.position);
    groupRef.current.quaternion.copy(camera.quaternion);
  });

  return (
    <group ref={groupRef}>
      <Container flexDirection="column" gap={10} opacity={0.98} depthTest={false}>
        <Container
          flexDirection="row"
          gap={10}
          paddingX={16}
          paddingY={12}
          borderRadius={32}
          borderWidth={1}
          borderColor="#8bc8ff"
          backgroundColor="#07131f"
          depthTest={false}
        >
          {actions.map((action) => {
            const tone = action.tone ?? "primary";
            const colors = toneStyles[tone];
            const interactionProps = action.disabled
              ? {}
              : {
                onClick: () => action.onSelect(),
                hover: { opacity: 0.88 }
              };

            return (
              <Container
                key={action.id}
                borderRadius={24}
                borderWidth={1}
                borderColor={colors.borderColor}
                backgroundColor={colors.backgroundColor}
                paddingX={14}
                paddingY={8}
                opacity={action.disabled ? 0.45 : 1}
                {...interactionProps}
              >
                <Text fontSize={20} color={colors.textColor}>
                  {action.label}
                </Text>
              </Container>
            );
          })}
        </Container>
        {placementSummary ? (
          <Container
            paddingX={12}
            paddingY={8}
            borderRadius={24}
            borderWidth={1}
            borderColor="#5c88ac"
            backgroundColor="#0d1c2c"
            opacity={0.9}
            depthTest={false}
          >
            <Text fontSize={16} color="#d6ebff">
              {placementSummary}
            </Text>
          </Container>
        ) : null}
        {children}
      </Container>
    </group>
  );
}
