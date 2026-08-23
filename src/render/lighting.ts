// Hemisphere ambient + directional key light. The key follows a warm→cool→warm
// arc across the 08:00–20:00 day, driven by sim clock events (SPEC §27).
// Winter days sag darker at their edges, and a §16 power outage drops the key
// to 20% with a cold cast — both are plain retints of the same two lights.

import { Color, DirectionalLight, HemisphereLight, MathUtils, type Scene } from "three";
import { dayProgress } from "../core/clock";

const KEY_WARM = new Color(0xffc182);
const KEY_NOON = new Color(0xf3f8fc);
const SKY_WARM = new Color(0xffe3bd);
const SKY_NOON = new Color(0xdcebf2);
const BG_WARM = new Color(0xe8dac3);
const BG_NOON = new Color(0xd7e4e4);
const HEMI_GROUND = new Color(0x6e8a6b);

// §27 outage look: the key drops to 20% with a cold tint; the sky and the
// glass behind the store go flat and gray with it.
const KEY_OUTAGE = new Color(0x8fa7c0);
const SKY_OUTAGE = new Color(0x9db4c6);
const BG_OUTAGE = new Color(0x99a6ab);
const OUTAGE_KEY_LEVEL = 0.2;

// §27 winter edges: mornings and evenings dim toward a cold dusk.
const BG_WINTER_DUSK = new Color(0xb7c2c8);
const WINTER_EDGE_LEVEL = 0.62;

// One outage-easing step per clock minute: ~2.4 minutes/s at 1×, so the
// drop lands in a bit over a real second — visibly a cut, never a hitch.
const OUTAGE_EASE_PER_MINUTE = 0.34;

const ARC_RADIUS = 30;

export class Lighting {
  private key: DirectionalLight;
  private hemi: HemisphereLight;
  private background = new Color();
  private winter = false;
  /** 0 = grid up, 1 = full outage; eased toward the target per clock
   *  minute so the drop reads as a power cut, not a scene reload. */
  private outageMix = 0;
  private outageTarget = 0;
  private lastIgm: number | null = null;

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

  /** §27: winter days render darker at the edges. Set at each morning. */
  setSeason(winter: boolean): void {
    this.winter = winter;
    if (this.lastIgm !== null) this.setTime(this.lastIgm);
  }

  /** §16 outage: ease toward the 20% cold look (or back). `immediate` snaps
   *  — mornings use it, since the easing rides clock minutes that a closed
   *  store never ticks. */
  setOutage(on: boolean, immediate = false): void {
    this.outageTarget = on ? 1 : 0;
    if (immediate) this.outageMix = this.outageTarget;
    if (this.lastIgm !== null) this.setTime(this.lastIgm);
  }

  /** Position and tint the lights for an in-game minute of day. */
  setTime(igm: number): void {
    this.lastIgm = igm;
    if (this.outageMix < this.outageTarget) {
      this.outageMix = Math.min(this.outageTarget, this.outageMix + OUTAGE_EASE_PER_MINUTE);
    } else if (this.outageMix > this.outageTarget) {
      this.outageMix = Math.max(this.outageTarget, this.outageMix - OUTAGE_EASE_PER_MINUTE);
    }
    const mix = this.outageMix;

    const t = dayProgress(igm); // 0 at 08:00 → 1 at 20:00
    const noon = Math.sin(t * Math.PI); // 0 at the edges, 1 at 14:00
    // §27 winter: the arc sags where it meets the doors — full at noon,
    // dimmest at open and close.
    const seasonDim = this.winter ? WINTER_EDGE_LEVEL + (1 - WINTER_EDGE_LEVEL) * noon : 1;

    this.key.color.lerpColors(KEY_WARM, KEY_NOON, noon).lerp(KEY_OUTAGE, mix);
    this.key.intensity = (1.9 + 0.45 * noon) * seasonDim * (1 - (1 - OUTAGE_KEY_LEVEL) * mix);
    this.hemi.color.lerpColors(SKY_WARM, SKY_NOON, noon).lerp(SKY_OUTAGE, mix);
    this.hemi.intensity = (1.5 + 0.35 * noon) * seasonDim * (1 - 0.55 * mix);
    this.background.lerpColors(BG_WARM, BG_NOON, noon);
    if (this.winter) this.background.lerp(BG_WINTER_DUSK, (1 - noon) * 0.35);
    this.background.lerp(BG_OUTAGE, mix * 0.5);

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
