import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import {
  CanvasTexture,
  ConeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  Vector3
} from "three";
import type { Object3D } from "three";
import { tokens } from "@holoim/design-tokens";
import { tokenColor } from "@holoim/design-tokens/three";
import { markChromeTree } from "@holoim/xr-ui-core";

import { isCameraTake } from "../hologram/hologramScene";
import { identityOf } from "./identityHue";
import type { Identity } from "./identityHue";

// The author's camera in a camera take (AR recording, Q1 A): a small filled
// mark in the author's identity hue with their initial (styleguide 2.4),
// standing at the RecordedAuthorCamera node and turned the way it looked,
// along the node's -Z, with the clip. It is the author's presence, never the
// view (principle 3). The viewer draws it and nothing exports it: it hangs
// off the card's clone, flagged as chrome so what the card fits, frames,
// hit-tests and clips never sees it.

export const AUTHOR_CAMERA_NODE = "RecordedAuthorCamera";

/** What a test reads back; empty until the mark is up, and for any take that is not a camera take's. */
export type PresenceProbe = {
  node: Object3D | null;
  mark: Object3D | null;
  /** The pointer that turns with the camera: its tip is along the node's -Z from the mark. */
  nose: Object3D | null;
  identity: Identity | null;
  /** The mark's diameter in the card's world, in metres, as last set. */
  diameter: number;
};

export function createPresenceProbe(): PresenceProbe {
  return { node: null, mark: null, nose: null, identity: null, diameter: 0 };
}

/** The mark's face is a disc of this many texture pixels; its initial is `type.authorInitial` in `mark.size` of them. */
const FACE_PX = 128;
const NOSE_LENGTH = 0.9;
const NOSE_RADIUS = 0.2;
const INITIAL_FONT = `${tokens.type.authorInitial.fontWeight} ${Math.round((FACE_PX * tokens.type.authorInitial.fontSize) / tokens.mark.size)}px ${tokens.type.authorInitial.fontFamily.join(", ")}`;
/** Over the link ink (PointingHighlights, 998), so the ink starts under the mark. */
const RENDER_ORDER = 999;

function drawFace(texture: CanvasTexture, identity: Identity): void {
  const canvas = texture.image as HTMLCanvasElement;
  const context = canvas.getContext("2d")!;
  context.clearRect(0, 0, FACE_PX, FACE_PX);
  context.fillStyle = identity.hex;
  context.beginPath();
  context.arc(FACE_PX / 2, FACE_PX / 2, FACE_PX / 2, 0, Math.PI * 2);
  context.fill();
  // The initial sits in deep sea on the filled mark (2.4); a hollow mark would use the hue.
  context.fillStyle = tokens.color.deepSea;
  context.font = INITIAL_FONT;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(identity.initial, FACE_PX / 2, FACE_PX / 2 + FACE_PX * 0.03);
  texture.needsUpdate = true;
}

type Props = {
  /** The card's clone of the take. */
  scene: Object3D;
  /** Who made the take (`submittedBy`): the mark's hue and initial. */
  author: string;
  probe: PresenceProbe;
};

export function AuthorCameraMark({ scene, author, probe }: Props) {
  const { camera, size, invalidate } = useThree();

  useEffect(() => {
    const node = isCameraTake(scene) ? scene.getObjectByName(AUTHOR_CAMERA_NODE) : null;
    if (!node) return;
    const identity = identityOf(author);
    const color = tokenColor(identity.hex);

    const canvas = document.createElement("canvas");
    canvas.width = FACE_PX;
    canvas.height = FACE_PX;
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    drawFace(texture, identity);
    // The face is drawn again once Figtree is in, if it was not yet.
    let live = true;
    void document.fonts?.load(INITIAL_FONT, identity.initial).then(() => {
      if (!live) return;
      drawFace(texture, identity);
      invalidate();
    });

    const face = new Sprite(new SpriteMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false }));
    const noseGeometry = new ConeGeometry(NOSE_RADIUS, NOSE_LENGTH, 20);
    // Apex along -Z, base at the mark's centre.
    noseGeometry.rotateX(-Math.PI / 2).translate(0, 0, -NOSE_LENGTH / 2);
    const nose = new Mesh(noseGeometry, new MeshBasicMaterial({ color, transparent: true, depthWrite: false, toneMapped: false }));
    const mark = new Group();
    mark.name = "RecordedAuthorCameraMark";
    mark.add(face, nose);
    for (const part of [face, nose]) {
      part.renderOrder = RENDER_ORDER;
      part.frustumCulled = false;
    }
    markChromeTree(mark);
    node.add(mark);

    probe.node = node;
    probe.mark = mark;
    probe.nose = nose;
    probe.identity = identity;
    invalidate();

    return () => {
      live = false;
      node.remove(mark);
      texture.dispose();
      face.material.dispose();
      noseGeometry.dispose();
      nose.material.dispose();
      probe.node = null;
      probe.mark = null;
      probe.nose = null;
      probe.identity = null;
    };
  }, [author, invalidate, probe, scene]);

  const scratch = useMemo(() => ({ position: new Vector3(), scale: new Vector3() }), []);
  useFrame(() => {
    const { node, mark } = probe;
    if (!node || !mark || !(camera instanceof PerspectiveCamera)) return;
    // 18 apx is 18 CSS px on a flat screen (styleguide, Units): the mark keeps that size wherever the camera stands.
    // World metres per NDC unit at its depth is depth / P[5]; the canvas spans two NDC units over its height.
    camera.updateMatrixWorld();
    node.updateWorldMatrix(true, false);
    const depth = -scratch.position.setFromMatrixPosition(node.matrixWorld).applyMatrix4(camera.matrixWorldInverse).z;
    if (depth <= 0 || size.height <= 0) return;
    const diameter = (tokens.mark.size * 2 * depth) / (camera.projectionMatrix.elements[5]! * size.height);
    // The node may be scaled; the mark is not.
    const parentScale = node.getWorldScale(scratch.scale).x || 1;
    mark.scale.setScalar(diameter / parentScale);
    probe.diameter = diameter;
  });

  return null;
}
