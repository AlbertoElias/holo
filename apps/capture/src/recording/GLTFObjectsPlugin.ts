import type * as THREE from 'three';
import type { GLTFExporterPlugin } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { assertHoloimObjects, type AuthoringSpan, HOLOIM_OBJECTS_EXTENSION, HOLOIM_OBJECTS_VERSION, type RecordedObjectEntry } from '@holoim/objects';

import type { ObjectExportDraft } from './objectExport';

/** Internal GLTFWriter fields not exposed in the public type declarations. */
interface GLTFWriterInternal {
  json: { extensions?: Record<string, unknown> };
  extensionsUsed: Record<string, boolean>;
  nodeMap: Map<THREE.Object3D, number>;
}

/**
 * GLTFExporter plugin that writes the take's event objects as the root
 * `HOLOIM_objects` extension (listed in `extensionsUsed` only, so viewers and
 * the USDZ converter that do not know it still read the file). Node indices
 * exist only once the writer has processed the scene, so drafts carry
 * objects and are mapped through the writer's `nodeMap` here; an object
 * whose node was not exported is dropped. `authoring` lists the spans where
 * an arm's tray motion was neutralized (PRD-045); with spans and no objects
 * (a tray opened, nothing summoned) the extension is still written.
 */
export class GLTFObjectsPlugin implements GLTFExporterPlugin {
  private readonly writer: GLTFWriterInternal;

  constructor(writer: unknown, private readonly drafts: ObjectExportDraft[], private readonly authoring: AuthoringSpan[] = []) {
    this.writer = writer as GLTFWriterInternal;
  }

  afterParse(): void {
    const objects: RecordedObjectEntry[] = [];
    for (const draft of this.drafts) {
      const node = this.writer.nodeMap.get(draft.node);
      if (node === undefined) continue;
      objects.push({ ...draft, node });
    }
    if (objects.length === 0 && this.authoring.length === 0) return;

    const value = assertHoloimObjects({ version: HOLOIM_OBJECTS_VERSION, objects, ...(this.authoring.length > 0 ? { authoring: this.authoring } : {}) });
    const json = this.writer.json;
    if (!json.extensions) json.extensions = {};
    json.extensions[HOLOIM_OBJECTS_EXTENSION] = value;
    this.writer.extensionsUsed[HOLOIM_OBJECTS_EXTENSION] = true;
  }
}
