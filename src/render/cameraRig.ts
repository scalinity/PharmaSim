// Orthographic eagle-eye camera rig (SPEC §27): left-drag orbit (pitch
// clamped 35°–65°, yaw free), right-drag/WASD pan, wheel zoom clamped to a
// 3.5–30 m viewport height, everything smooth-damped.

import { MathUtils, OrthographicCamera, Vector3 } from "three";

const TAU = Math.PI * 2;
const PITCH_MIN = MathUtils.degToRad(35);
const PITCH_MAX = MathUtils.degToRad(65);
// §27 says "~8 m". That leaves an Rx bin name about sixteen pixels of type in
// a short window — enough to see that a label exists, not enough to tell
// Amlodipine from Lisinopril. The floor sits under the fill glide (main.ts)
// so the wheel can lean in until a name is a readable line of Plex Mono.
const VIEW_MIN = 2;
const VIEW_MAX = 30;
const CAMERA_DIST = 45;
const ORBIT_SPEED = 0.006; // rad per px
const ZOOM_SPEED = 0.0014;
const KEY_PAN_SPEED = 0.9; // viewport heights per second
const DAMPING = 9; // 1/s

const PAN_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD"]);

export class CameraRig {
  readonly camera: OrthographicCamera;

  private target = new Vector3();
  private goalTarget = new Vector3();
  private yaw = MathUtils.degToRad(-28);
  private goalYaw = this.yaw;
  private pitch = MathUtils.degToRad(50);
  private goalPitch = this.pitch;
  private viewHeight = 14;
  private goalViewHeight = this.viewHeight;
  private aspect = 1;

  private heldKeys = new Set<string>();
  private dragButton = -1;
  private lastX = 0;
  private lastY = 0;
  /** Where the player had the camera before a fill glide (§8), or null. */
  private saved: {
    target: Vector3;
    viewHeight: number;
    yaw: number;
    pitch: number;
  } | null = null;
  /** Ambient yaw drift, rad/s — the title screen's slow orbit (§23). */
  private autoOrbit = 0;

  // Scratch vectors — no per-frame allocations.
  private fwd = new Vector3();
  private right = new Vector3();
  private offset = new Vector3();

  constructor(private canvas: HTMLCanvasElement) {
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 1, 150);

    canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
    canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    window.addEventListener("keydown", (e) => {
      if (PAN_KEYS.has(e.code)) this.heldKeys.add(e.code);
    });
    window.addEventListener("keyup", (e) => this.heldKeys.delete(e.code));
    window.addEventListener("blur", () => this.heldKeys.clear());

    this.apply();
  }

  setAspect(aspect: number): void {
    this.aspect = aspect;
    this.updateProjection();
  }

  /**
   * Fill glide (§8): frame a world point tightly, remembering where we were.
   * The aim point carries a height because the thing being read is a metre up
   * a wall, not on the floor. `faceYaw` swings round to look at that wall
   * square-on and drops to the shallowest legal pitch — a bin label is a
   * vertical card, so every degree of extra tilt is height off its type.
   */
  glideTo(aim: Vector3, viewHeight = 9, faceYaw?: number): void {
    if (!this.saved) {
      this.saved = {
        target: this.goalTarget.clone(),
        viewHeight: this.goalViewHeight,
        yaw: this.goalYaw,
        pitch: this.goalPitch,
      };
    }
    this.goalTarget.copy(aim);
    this.goalViewHeight = MathUtils.clamp(viewHeight, VIEW_MIN, VIEW_MAX);
    if (faceYaw !== undefined) {
      // Take the short way round from wherever the player left the camera.
      const turn = MathUtils.euclideanModulo(faceYaw - this.yaw + Math.PI, TAU) - Math.PI;
      this.goalYaw = this.yaw + turn;
      this.goalPitch = PITCH_MIN;
    }
  }

  /** Glide back to wherever the player had the camera before the fill. */
  glideBack(): void {
    if (!this.saved) return;
    this.goalTarget.copy(this.saved.target);
    this.goalViewHeight = this.saved.viewHeight;
    this.goalYaw = this.saved.yaw;
    this.goalPitch = this.saved.pitch;
    this.saved = null;
  }

  /** Drift the yaw on its own, in rad/s; 0 stops it. */
  setAutoOrbit(radPerSecond: number): void {
    this.autoOrbit = radPerSecond;
  }

  update(dtMs: number): void {
    const dt = dtMs / 1000;

    if (this.autoOrbit !== 0) this.goalYaw += this.autoOrbit * dt;

    if (this.heldKeys.size > 0) {
      this.groundAxes();
      const step = KEY_PAN_SPEED * this.viewHeight * dt;
      if (this.heldKeys.has("KeyW")) this.goalTarget.addScaledVector(this.fwd, step);
      if (this.heldKeys.has("KeyS")) this.goalTarget.addScaledVector(this.fwd, -step);
      if (this.heldKeys.has("KeyA")) this.goalTarget.addScaledVector(this.right, -step);
      if (this.heldKeys.has("KeyD")) this.goalTarget.addScaledVector(this.right, step);
    }

    const k = 1 - Math.exp(-DAMPING * dt);
    this.yaw += (this.goalYaw - this.yaw) * k;
    this.pitch += (this.goalPitch - this.pitch) * k;
    this.viewHeight += (this.goalViewHeight - this.viewHeight) * k;
    this.target.lerp(this.goalTarget, k);

    this.apply();
  }

  private apply(): void {
    this.offset.set(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch),
    );
    this.camera.position.copy(this.target).addScaledVector(this.offset, CAMERA_DIST);
    this.camera.lookAt(this.target);
    this.updateProjection();
  }

  private updateProjection(): void {
    const halfH = this.viewHeight / 2;
    const halfW = halfH * this.aspect;
    this.camera.left = -halfW;
    this.camera.right = halfW;
    this.camera.top = halfH;
    this.camera.bottom = -halfH;
    this.camera.updateProjectionMatrix();
  }

  /** Camera-relative ground-plane axes into this.fwd / this.right. */
  private groundAxes(): void {
    this.fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 && e.button !== 2) return;
    this.dragButton = e.button;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.canvas.setPointerCapture(e.pointerId);
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.dragButton === -1) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;

    if (this.dragButton === 0) {
      this.goalYaw -= dx * ORBIT_SPEED;
      this.goalPitch = MathUtils.clamp(this.goalPitch + dy * ORBIT_SPEED, PITCH_MIN, PITCH_MAX);
    } else {
      // Grab-the-ground pan: world units per screen pixel at current zoom.
      const upp = this.viewHeight / this.canvas.clientHeight;
      this.groundAxes();
      this.goalTarget.addScaledVector(this.right, -dx * upp);
      this.goalTarget.addScaledVector(this.fwd, dy * upp);
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.dragButton === -1) return;
    this.dragButton = -1;
    this.canvas.releasePointerCapture(e.pointerId);
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.goalViewHeight = MathUtils.clamp(
      this.goalViewHeight * Math.exp(e.deltaY * ZOOM_SPEED),
      VIEW_MIN,
      VIEW_MAX,
    );
  }
}
