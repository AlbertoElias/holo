// Loaded before every other file: @react-three/xr's pointer events augment
// three's Object3D, and the shared xr-ui packages resolve "three" on their
// own. Unless the augmentation is read first, whichever file reaches those
// packages first decides whether Object3D has it, and the program splits.
import type {} from "@react-three/xr";
