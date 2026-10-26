import type { Page } from "@playwright/test";

export type PhoneVec3 = [number, number, number];
export type PhoneQuat = [number, number, number, number];

export function emulatePhone(page: Page, options?: { interactionMode?: "screen-space" | "unset" }): Promise<void>;
export function phoneTap(page: Page, point: PhoneVec3): Promise<void>;
export function phoneHold(page: Page, point: PhoneVec3, ms: number, options?: { screenLocked?: boolean }): Promise<void>;
export function phoneFingerDown(page: Page, point: PhoneVec3, options?: { headPose?: { position: PhoneVec3; quaternion: PhoneQuat } }): Promise<void>;
export function phoneFingerMove(page: Page, point: PhoneVec3): Promise<void>;
export function phoneFingerUp(page: Page): Promise<void>;
export function phoneScreenPoint(page: Page, x: number, y: number, distance?: number): Promise<PhoneVec3>;
export function phoneDrag(page: Page, from: PhoneVec3, to: PhoneVec3, frames: number, holdMs?: number): Promise<void>;
export function phonePinch(page: Page, centre: PhoneVec3, fromPx: number, toPx: number, frames: number): Promise<void>;
export function setHeadPose(page: Page, position: PhoneVec3, quaternion: PhoneQuat): Promise<void>;
export function phoneViewOffset(page: Page, yawDeg: number): Promise<void>;
export function phoneViewerSpaceUnavailable(page: Page, unavailable: boolean): Promise<void>;
