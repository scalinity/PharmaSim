// Hemisphere ambient + directional key light. The key follows a warm→cool→warm
// arc across the 08:00–20:00 day, driven by sim clock events (SPEC §27).

import { Color, DirectionalLight, HemisphereLight, MathUtils, type Scene } from "three";
import { dayProgress } from "../core/clock";

const KEY_WARM = new Color(0xffc182);
const KEY_NOON = new Color(0xf3f8fc);
const SKY_WARM = new Color(0xffe3bd);
const SKY_NOON = new Color(0xdcebf2);
const BG_WARM = new Color(0xe8dac3);
const BG_NOON = new Color(0xd7e4e4);
const HEMI_GROUND = new Color(0x6e8a6b);

const ARC_RADIUS = 30;

export class Lighting {
  private key: DirectionalLight;
  private hemi: HemisphereLight;
  private background = new Color();

  constructor(private scene: Scene) {
    this.hemi = new HemisphereLight(SKY_WARM, HEMI_GROUND, 0.9);
    scene.add(this.hemi);

    this.key = new DirectionalLight(KEY_WARM, 1.9);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(1024, 1024);
    this.key.shadow.normalBias = 0.03;
    const cam = this.key.shadow.camera;
    cam.near = 4;
    cam.far = 70;
    scene.add(this.key);
    scene.add(this.key.target);
    this.fitFloor(10, 7);

    this.scene.background = this.background;
  }

  /** Size the shadow box to the floor — a §6 expansion outgrows a fixed one
   *  (the box is light-aligned, so it must cover the floor's half-diagonal). */
  fitFloor(cols: number, rows: number): void {
    const radius = Math.ceil(Math.hypot(cols, rows) / 2) + 1;
    const cam = this.key.shadow.camera;
    cam.left = -radius;
    cam.right = radius;
    cam.top = radius;
    cam.bottom = -radius;
    cam.updateProjectionMatrix();
  }

  /** Position and tint the lights for an in-game minute of day. */
  setTime(igm: number): void {
    const t = dayProgress(igm); // 0 at 08:00 → 1 at 20:00
    const noon = Math.sin(t * Math.PI); // 0 at the edges, 1 at 14:00

    this.key.color.lerpColors(KEY_WARM, KEY_NOON, noon);
    this.key.intensity = 1.9 + 0.45 * noon;
    this.hemi.color.lerpColors(SKY_WARM, SKY_NOON, noon);
    this.hemi.intensity = 1.5 + 0.35 * noon;
    this.background.lerpColors(BG_WARM, BG_NOON, noon);

    // Sun slides east → west while its elevation rises and falls.
    const azimuth = MathUtils.degToRad(MathUtils.lerp(75, -75, t));
    const elevation = MathUtils.degToRad(MathUtils.lerp(24, 62, noon));
    this.key.position.set(
      ARC_RADIUS * Math.cos(elevation) * Math.sin(azimuth),
      ARC_RADIUS * Math.sin(elevation),
      ARC_RADIUS * Math.cos(elevation) * Math.cos(azimuth),
    );
  }
}
