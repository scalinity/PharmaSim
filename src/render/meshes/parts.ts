// Builder that merges primitive parts into one vertex-colored BufferGeometry,
// so each furniture piece renders as a single mesh (SPEC §30 draw-call budget).

import { BufferAttribute, BufferGeometry, Color } from "three";

const scratchColor = new Color();

export class PartsBuilder {
  private parts: BufferGeometry[] = [];

  /**
   * Add a primitive tinted with a flat color. Rotate the geometry yourself
   * before adding (geometry.rotateX/Y/Z); position is applied here.
   */
  add(geometry: BufferGeometry, color: number, x = 0, y = 0, z = 0): this {
    const part = geometry.toNonIndexed();
    part.translate(x, y, z);
    const count = part.getAttribute("position").count;
    const colors = new Float32Array(count * 3);
    scratchColor.set(color);
    for (let i = 0; i < count; i++) {
      colors[i * 3] = scratchColor.r;
      colors[i * 3 + 1] = scratchColor.g;
      colors[i * 3 + 2] = scratchColor.b;
    }
    part.setAttribute("color", new BufferAttribute(colors, 3));
    this.parts.push(part);
    return this;
  }

  build(): BufferGeometry {
    let vertexCount = 0;
    for (const part of this.parts) vertexCount += part.getAttribute("position").count;

    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);
    let offset = 0;
    for (const part of this.parts) {
      positions.set(part.getAttribute("position").array as Float32Array, offset);
      normals.set(part.getAttribute("normal").array as Float32Array, offset);
      colors.set(part.getAttribute("color").array as Float32Array, offset);
      offset += part.getAttribute("position").count * 3;
    }

    const merged = new BufferGeometry();
    merged.setAttribute("position", new BufferAttribute(positions, 3));
    merged.setAttribute("normal", new BufferAttribute(normals, 3));
    merged.setAttribute("color", new BufferAttribute(colors, 3));
    return merged;
  }
}
