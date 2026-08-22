// WebGLRenderer setup + window resize handling.

import { PCFSoftShadowMap, WebGLRenderer, type Camera, type Scene } from "three";

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderer;
  private resizeCallbacks: ((width: number, height: number) => void)[] = [];

  constructor() {
    this.gl = new WebGLRenderer({ antialias: true });
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = PCFSoftShadowMap;

    this.canvas = this.gl.domElement;
    this.canvas.className = "scene-canvas";
    document.body.prepend(this.canvas);

    window.addEventListener("resize", () => this.resize());
    this.resize();
  }

  get aspect(): number {
    return window.innerWidth / window.innerHeight;
  }

  onResize(callback: (width: number, height: number) => void): void {
    this.resizeCallbacks.push(callback);
  }

  render(scene: Scene, camera: Camera): void {
    this.gl.render(scene, camera);
  }

  private resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.gl.setSize(width, height);
    for (const callback of this.resizeCallbacks) callback(width, height);
  }
}
