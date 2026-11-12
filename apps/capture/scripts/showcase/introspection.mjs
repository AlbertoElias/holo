import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { Glb } from './lib/glb.mjs';
import { EYE, FEED_T, ROOMS, frame, rad } from './introspection/common.mjs';
import {
  CHILD_AT, PALETTES, briefcaseGeometry, chestPivot, childPresence, hatGeometry, painter,
  performFigures, travellerPivot, travellerPresence, writeFigure
} from './introspection/figures.mjs';
import { buildRooms } from './introspection/rooms.mjs';
import { layerSounds } from './introspection/sound.mjs';

// "The way down": a man in his thirties on a 1950s film set, doing fine.
// Something made of light steps out of his chest and goes down through
// him, layer by layer, each a trap door below the last: pastel gases that
// keep colliding, then dark liquids crashing like a storm, then the dark,
// where a child sits crying. It kneels and holds the child, and the light
// of that climbs back up to the man, who breathes out.
//
// Each layer is a quarter of a round diorama, lower than the one before,
// and plays its own sound from its own room: wherever you look in, that is
// what you hear.

export const meta = {
  slug: 'the-way-down',
  name: 'The way down',
  submittedBy: 'Claude (agent-authored)'
};

export async function build() {
  const glb = new Glb();
  // Every mesh here is built as loose triangles; welding shared vertices
  // keeps four rooms, three figures and four sounds under the upload limit.
  const rawMesh = glb.mesh.bind(glb);
  glb.mesh = (name, geometry, material) => rawMesh(name, geometry.index ? geometry : mergeVertices(geometry, 1e-5), material);
  glb.provenance({
    holoim: {
      authored: 'synthetic',
      author: meta.submittedBy,
      title: meta.name,
      note: 'Four layers of one man, each with its own positional sound (linear rolloff), so each is heard only from its own room.'
    }
  });

  const mats = {
    painted: glb.material({ name: 'Painted', color: '#ffffff', unlit: true, doubleSided: true }),
    glow: glb.material({ name: 'PortalGlow', color: '#ffffff', opacity: 0.6, unlit: true, doubleSided: true }),
    gas: glb.material({ name: 'Gas', color: '#ffffff', opacity: 0.62, unlit: true }),
    light: glb.material({ name: 'HugLight', color: '#ffffff', opacity: 0.2, unlit: true }),
    lightFaint: glb.material({ name: 'HugLightFaint', color: '#ffffff', opacity: 0.1, unlit: true })
  };
  const scene = glb.node({ name: 'TheWayDown' });

  const kneel = [CHILD_AT.x + 0.4 * Math.sin(CHILD_AT.yaw), CHILD_AT.z + 0.4 * Math.cos(CHILD_AT.yaw)];
  const hugAt = [(CHILD_AT.x + kneel[0]) / 2, (CHILD_AT.z + kneel[1]) / 2];
  const groups = buildRooms(glb, mats, scene, { hugAt });

  // The three of them.
  const { rigs, frames, times } = performFigures();
  const manMat = glb.material({ name: 'Man', color: '#ffffff', emissive: '#1c1814', roughness: 0.72 });
  writeFigure(glb, rigs.man, frames.man, times, {
    name: 'man',
    materials: { body: manMat },
    paint: painter(PALETTES.man),
    hatGeo: hatGeometry('#5a4a3c', '#2a2a2a'),
    hatMaterial: manMat,
    extra: (nodes) => glb.node({ name: 'man-briefcase', mesh: glb.mesh('man-briefcase', briefcaseGeometry(), manMat), parent: nodes.wristR })
  });
  const lightMat = glb.material({ name: 'Traveller', color: '#e6f6ff', opacity: 0.72, emissive: '#cfeaff', emissiveStrength: 1.3, roughness: 0.3 });
  writeFigure(glb, rigs.traveller, frames.traveller, times, {
    name: 'traveller',
    materials: { body: lightMat },
    paint: painter({ top: '#ffffff' }),
    presence: travellerPresence,
    pivotOf: travellerPivot(frames.traveller, frames.man)
  });
  writeFigure(glb, rigs.child, frames.child, times, {
    name: 'child',
    materials: { body: mats.painted },
    paint: painter(PALETTES.child, { baked: true, dim: 0.9 }),
    presence: childPresence,
    pivotOf: chestPivot(0.25)
  });

  // Each layer's sound comes from above the middle of its own room, all
  // at one height (2 m) so the deep rooms are as loud as the high ones: the
  // feed's ear stands up and out from the view's middle. Linear rolloff
  // reaches silence before the next room's emitter, so a listener in one
  // layer does not hear the others.
  const sounds = layerSounds();
  const SOUND_Y = 2.0;
  const gains = { stage: 0.85, gas: 0.8, liquid: 1.0, core: 1.0 };
  for (const room of Object.keys(ROOMS)) {
    const node = glb.node({ name: `sound-${room}`, translation: [0, SOUND_Y - ROOMS[room].floor, 0.1], parent: groups[room] });
    glb.sound(sounds[room], { node, name: `layer-${room}`, gain: gains[room], distanceModel: 'linear', refDistance: 0.9, maxDistance: 2.3 });
  }
  return glb;
}

const dirAt = (yawDeg, pitchDeg) => {
  const y = rad(yawDeg);
  const p = rad(pitchDeg);
  return [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)];
};
const round = (v) => v.map((x) => +x.toFixed(3));
const roomView = (room, d = 4.4, pitch = 20) => {
  const F = frame(room);
  const look = F.at(0, 0.85, 0.1).toArray();
  const dir = dirAt(ROOMS[room].yaw, pitch);
  return { cam: round(look.map((v, i) => v + dir[i] * d)), look: round(look) };
};
const FEED_EYE = round(EYE);

export const tiles = [
  { label: 'feed 0 s', cam: FEED_EYE, look: FEED_T, fov: 38, t: 0.5 },
  { label: 'stage 3.6 s', ...roomView('stage'), fov: 38, t: 3.6 },
  { label: 'stage 6.8 s', ...roomView('stage'), fov: 38, t: 6.8 },
  { label: 'gas 13.9 s', ...roomView('gas'), fov: 38, t: 13.9 },
  { label: 'liquid 26.6 s', ...roomView('liquid'), fov: 38, t: 26.6 },
  { label: 'liquid 34.6 s', ...roomView('liquid'), fov: 38, t: 34.6 },
  { label: 'core 44 s', ...roomView('core'), fov: 38, t: 44 },
  { label: 'core 53 s', ...roomView('core'), fov: 38, t: 53 },
  { label: 'plan 30 s', cam: [0, 10, 0.8], look: [0, 0, 0], fov: 38, t: 30 }
];

