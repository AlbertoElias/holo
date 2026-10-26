export interface RuntimeConfig {
  sceneUrl: string;
  avatarUrl: string;
  /** The supplied object (PRD-043): a GLB URL, loaded before recording. */
  objectUrl: string | null;
  /** The prepared tray (PRD-045): repeated `?tray=` GLB or image URLs, loaded before recording. */
  trayUrls: string[];
  avatarHeightOverride: number;
  avatarScaleMultiplier: number;
  sceneScaleOverride: number;
  sceneSpanAvatars: number;
  embodyOffset: number;
  avatarForwardOffset: number;
  handTrackPitchDeg: number;
  handTrackYawDeg: number;
  handTrackRollDeg: number;
  handTrackInwardYawDeg: number;
  handFingerCurlGain: number;
  handRetargetMode: 'hybrid' | 'legacy';
  controllerTrackPitchDeg: number;
  controllerTrackYawDeg: number;
  controllerTrackRollDeg: number;
  mockVrEnabledFromQuery: boolean;
  /**
   * `?arCamera=1`: a handheld AR session authors a camera take (docs/features/
   * ar-recording.md). Off by default until slice 4 is verified; with it off
   * phone AR is the spectator it always was.
   */
  arCameraAuthor: boolean;
}

export function loadRuntimeConfig(search = window.location.search): RuntimeConfig {
  const query = new URLSearchParams(search);
  const defaultSceneUrl = '/gltf/models/scene.glb';
  const defaultAvatarUrl = '/gltf/models/avatar.glb';
  const handRetargetModeQuery = (query.get('handRetargetMode') ?? 'hybrid').toLowerCase();
  const handRetargetMode = handRetargetModeQuery === 'legacy' ? 'legacy' : 'hybrid';

  return {
    sceneUrl: query.get('scene') ?? defaultSceneUrl,
    avatarUrl: query.get('avatar') ?? defaultAvatarUrl,
    objectUrl: query.get('object'),
    trayUrls: query.getAll('tray').filter(Boolean),
    avatarHeightOverride: Number(query.get('avatarHeight')),
    avatarScaleMultiplier: Number(query.get('avatarScale') ?? '1'),
    sceneScaleOverride: Number(query.get('sceneScale')),
    sceneSpanAvatars: Number(query.get('sceneSpanAvatars') ?? '72'),
    embodyOffset: Number(query.get('embodyOffset') ?? '0'),
    avatarForwardOffset: Number(query.get('avatarForwardOffset') ?? `${Math.PI}`),
    handTrackPitchDeg: Number(query.get('handTrackPitchDeg') ?? '0'),
    handTrackYawDeg: Number(query.get('handTrackYawDeg') ?? '180'),
    handTrackRollDeg: Number(query.get('handTrackRollDeg') ?? '0'),
    handTrackInwardYawDeg: Number(query.get('handTrackInwardYawDeg') ?? '30'),
    handFingerCurlGain: Number(query.get('handFingerCurlGain') ?? '1.0'),
    handRetargetMode,
    controllerTrackPitchDeg: Number(query.get('controllerTrackPitchDeg') ?? '0'),
    controllerTrackYawDeg: Number(query.get('controllerTrackYawDeg') ?? '180'),
    controllerTrackRollDeg: Number(query.get('controllerTrackRollDeg') ?? '0'),
    mockVrEnabledFromQuery: query.get('mockVr') === '1',
    arCameraAuthor: query.get('arCamera') === '1'
  };
}
