/**
 * Game-controller operator mapping (face / shoulder / d-pad → camera actions, which stick drives
 * the gimbal). Source of truth: OpenCine `OpenCineCameraVocabulary/GamepadOperator.swift`
 * (shutter-angle sync helpers not ported: they need ShutterAngle, owned by the assists port).
 */
export type GamepadOperatorAction =
  | 'record'
  | 'recenter'
  | 'flip'
  | 'track'
  | 'zoomChipIn'
  | 'zoomChipOut'
  | 'isoUp'
  | 'isoDown'
  | 'shutterOpen'
  | 'shutterClose';
export type GamepadFaceButton = 'a' | 'b' | 'x' | 'y';
export type GamepadShoulder = 'left' | 'right';
export type GamepadDpad = 'up' | 'down' | 'left' | 'right';
export type GamepadGimbalStick = 'left' | 'right';

export const GamepadOperatorMap = {
  face: (b: GamepadFaceButton): GamepadOperatorAction => ({ a: 'record', b: 'recenter', x: 'flip', y: 'track' }) as const satisfies Record<GamepadFaceButton, GamepadOperatorAction>)[b],
  shoulder: (b: GamepadShoulder): GamepadOperatorAction => (b === 'left' ? 'zoomChipOut' : 'zoomChipIn'),
  dpad: (d: GamepadDpad): GamepadOperatorAction => ({ up: 'isoUp', down: 'isoDown', left: 'shutterOpen', right: 'shutterClose' }) as const)[d],
};

export const GamepadGimbalSticks = {
  default: 'left' as GamepadGimbalStick,
  label: (s: GamepadGimbalStick) => (s === 'right' ? 'Right' : 'Left'),
  parse: (raw: string | null | undefined): GamepadGimbalStick => (raw?.toLowerCase() === 'right' ? 'right' : 'left'),
  fromLabel: (label: string): GamepadGimbalStick => (label === 'Right' ? 'right' : 'left'),
  axes(s: GamepadGimbalStick, leftX: number, leftY: number, rightX: number, rightY: number): { x: number; y: number } {
    return s === 'left' ? { x: leftX, y: leftY } : { x: rightX, y: rightY };
  },
  /** Switching sticks while driving must rest the held motion first. */
  restHeldMotion: (previous: GamepadGimbalStick, current: GamepadGimbalStick, driving: boolean) => previous !== current && driving,
};
