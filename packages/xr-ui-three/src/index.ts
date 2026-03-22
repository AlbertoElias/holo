import { Container, Text } from "@pmndrs/uikit";
import * as THREE from "three";

import type { RecordingUiState } from "@holoim/xr-ui-core";

export class ThreeRecordingActionPanel {
  readonly group = new THREE.Group();

  private readonly root: Container;
  private readonly actionSurface: Container;
  private readonly label: Text;
  private readonly tmpRay = new THREE.Ray();
  private readonly tmpRaycaster = new THREE.Raycaster();
  private readonly tmpQuat = new THREE.Quaternion();

  constructor() {
    this.root = new Container({
      width: 340,
      height: 110,
      borderRadius: 44,
      borderWidth: 2,
      borderColor: "#8fcfff",
      backgroundColor: "#07131f",
      justifyContent: "center",
      alignItems: "center",
      opacity: 0.98,
      depthTest: false
    });
    this.actionSurface = new Container({
      width: 290,
      height: 70,
      borderRadius: 34,
      borderWidth: 1,
      borderColor: "#8fcfff",
      backgroundColor: "#1a5d8f",
      justifyContent: "center",
      alignItems: "center",
      depthTest: false
    });
    this.label = new Text({
      text: "Start Recording",
      fontSize: 24,
      color: "#f4fbff",
      textAlign: "center",
      anchorX: "center",
      anchorY: "center"
    });

    this.actionSurface.add(this.label);
    this.root.add(this.actionSurface);
    this.group.add(this.root);
    this.group.position.set(0, -0.15, -0.55);
    this.group.scale.setScalar(0.0013);
  }

  updateFromCamera(camera: THREE.Camera): void {
    this.group.position.set(0, -0.15, -0.55);
    this.group.quaternion.copy(camera.quaternion);
  }

  update(deltaSec: number, state: RecordingUiState): void {
    this.root.update(deltaSec * 1000);

    if (state.status === "recording") {
      this.actionSurface.resetProperties({
        width: 290,
        height: 70,
        borderRadius: 34,
        borderWidth: 1,
        borderColor: "#ff9ca6",
        backgroundColor: "#7a2530",
        justifyContent: "center",
        alignItems: "center",
        depthTest: false
      });
      this.label.resetProperties({
        text: state.actionLabel,
        fontSize: 24,
        color: "#fff6f7",
        textAlign: "center",
        anchorX: "center",
        anchorY: "center"
      });
      return;
    }

    if (state.status === "exporting") {
      this.actionSurface.resetProperties({
        width: 290,
        height: 70,
        borderRadius: 34,
        borderWidth: 1,
        borderColor: "#f7cf7a",
        backgroundColor: "#6f5a1e",
        justifyContent: "center",
        alignItems: "center",
        depthTest: false
      });
      this.label.resetProperties({
        text: state.actionLabel,
        fontSize: 24,
        color: "#fff8d8",
        textAlign: "center",
        anchorX: "center",
        anchorY: "center"
      });
      return;
    }

    this.actionSurface.resetProperties({
      width: 290,
      height: 70,
      borderRadius: 34,
      borderWidth: 1,
      borderColor: "#8fcfff",
      backgroundColor: "#1a5d8f",
      justifyContent: "center",
      alignItems: "center",
      depthTest: false
    });
    this.label.resetProperties({
      text: state.actionLabel,
      fontSize: 24,
      color: "#f4fbff",
      textAlign: "center",
      anchorX: "center",
      anchorY: "center"
    });
  }

  isPointerOverAction(controller: THREE.Group): boolean {
    controller.getWorldPosition(this.tmpRay.origin);
    this.tmpRay.direction.set(0, 0, -1).applyQuaternion(controller.getWorldQuaternion(this.tmpQuat));
    this.tmpRaycaster.ray.copy(this.tmpRay);
    return this.tmpRaycaster.intersectObject(this.actionSurface, true).length > 0;
  }
}
