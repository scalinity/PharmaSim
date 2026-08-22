// Placeholder store: sage ground, cream slab, low flat-shaded walls with a
// walnut hint (Gen 1), door gap on the south face (SPEC §27).

import { BoxGeometry, Group, Mesh, MeshLambertMaterial, PlaneGeometry, Scene } from "three";

const GROUND_SAGE = 0x8fae8b;
const CREAM = 0xf1ead8;
const WALNUT = 0x6b4a32;

const STORE_W = 10;
const STORE_D = 7;
const SLAB_H = 0.12;
const WALL_H = 1.1;
const WALL_T = 0.16;
const CAP_H = 0.05;
const DOOR_W = 1.8;

export function createStoreScene(): Scene {
  const scene = new Scene();

  const groundMat = new MeshLambertMaterial({ color: GROUND_SAGE, flatShading: true });
  const creamMat = new MeshLambertMaterial({ color: CREAM, flatShading: true });
  const walnutMat = new MeshLambertMaterial({ color: WALNUT, flatShading: true });

  const ground = new Mesh(new PlaneGeometry(80, 80), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const store = new Group();
  scene.add(store);

  const slab = new Mesh(new BoxGeometry(STORE_W, SLAB_H, STORE_D), creamMat);
  slab.position.y = SLAB_H / 2;
  slab.castShadow = true;
  slab.receiveShadow = true;
  store.add(slab);

  // Walls sit on the slab, centered half a thickness inside each footprint edge.
  const wallY = SLAB_H + WALL_H / 2;
  const capY = SLAB_H + WALL_H + CAP_H / 2;
  const hx = STORE_W / 2;
  const hz = STORE_D / 2;

  function wall(width: number, depth: number, x: number, z: number): void {
    const body = new Mesh(new BoxGeometry(width, WALL_H, depth), creamMat);
    body.position.set(x, wallY, z);
    body.castShadow = true;
    body.receiveShadow = true;
    store.add(body);

    const cap = new Mesh(new BoxGeometry(width, CAP_H, depth), walnutMat);
    cap.position.set(x, capY, z);
    cap.castShadow = true;
    store.add(cap);
  }

  // Back (north) wall, full width.
  wall(STORE_W, WALL_T, 0, -hz + WALL_T / 2);
  // Side walls butt against the front/back walls.
  wall(WALL_T, STORE_D - 2 * WALL_T, -hx + WALL_T / 2, 0);
  wall(WALL_T, STORE_D - 2 * WALL_T, hx - WALL_T / 2, 0);
  // Front (south) wall, split around a centered door gap.
  const frontSegW = (STORE_W - DOOR_W) / 2;
  const frontSegX = DOOR_W / 2 + frontSegW / 2;
  const frontZ = hz - WALL_T / 2;
  wall(frontSegW, WALL_T, -frontSegX, frontZ);
  wall(frontSegW, WALL_T, frontSegX, frontZ);

  // Walnut door posts, slightly taller and prouder than the wall.
  const postH = WALL_H + 0.2;
  for (const side of [-1, 1]) {
    const post = new Mesh(new BoxGeometry(0.14, postH, WALL_T + 0.1), walnutMat);
    post.position.set(side * (DOOR_W / 2 + 0.07), SLAB_H + postH / 2, frontZ);
    post.castShadow = true;
    store.add(post);
  }

  return scene;
}
