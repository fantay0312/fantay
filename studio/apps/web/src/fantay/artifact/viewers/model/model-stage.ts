// SPDX-License-Identifier: AGPL-3.0-only
// The 3D stage: one model in a neutral studio, drawn with three.js. It frames the model from its
// bounding box, lights it with an environment built in code (three's RoomEnvironment, so no image
// file is fetched) plus a soft key light that follows the camera, and gives surfaces without a
// material of their own a quiet clay one. The camera orbits, zooms and pans through OrbitControls.
// It draws on demand: a frame is rendered when the camera moves, the size changes or the model
// does, and the loop stops as soon as nothing is moving. Loaded on demand (ModelViewer.tsx), so
// three.js is in no bundle until a model opens.
import {
  Box3,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  LineBasicMaterial,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NeutralToneMapping,
  PMREMGenerator,
  PerspectiveCamera,
  PointsMaterial,
  SRGBColorSpace,
  Scene,
  Sphere,
  Spherical,
  Texture,
  Vector3,
  WebGLRenderer,
  type Object3D,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const FOV = 35;
/** The view a model opens in: a little to the right of the front, a little above. */
const HOME_AZIMUTH = (35 * Math.PI) / 180;
const HOME_ELEVATION = (20 * Math.PI) / 180;
const RESET_MS = 240;

export type StageFailure = 'no-webgl' | 'empty';

export class StageError extends Error {
  constructor(readonly code: StageFailure) {
    super(code);
  }
}

/** sRGB colour components, 0 to 1. */
export type Rgb = readonly [number, number, number];

export interface StageColors {
  /** Surfaces with no material of their own. */
  clay: Rgb;
  /** Wireframe lines, plain lines and points without colours. */
  line: Rgb;
}

export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
}

export interface ModelStats {
  vertices: number;
  faces: number;
  /** Vertices of point clouds. */
  points: number;
  /** Width, height, depth of the bounding box in the file's own axes and units. */
  size: [number, number, number];
}

export interface StageCallbacks {
  /** The reader moved the camera; null means "back to the framed view". */
  onPose(pose: CameraPose | null): void;
  /** The reader touched the stage for the first time in this gesture. */
  onInteract(): void;
}

type Drawable = Object3D & { geometry?: BufferGeometry; material?: Material | Material[] };

function isMesh(object: Object3D): object is Mesh {
  return (object as Mesh).isMesh === true;
}

function materialsOf(object: Drawable): Material[] {
  if (!object.material) return [];
  return Array.isArray(object.material) ? object.material : [object.material];
}

/** glTF's stand-in for "this surface has no material": white, fully metallic, fully rough. It reads as a dark blob. */
function isPlaceholderMaterial(material: Material): boolean {
  const standard = material as MeshStandardMaterial;
  return (
    standard.isMeshStandardMaterial === true &&
    material.name === '' &&
    standard.map === null &&
    standard.metalness === 1 &&
    standard.roughness === 1 &&
    standard.color.getHex() === 0xffffff &&
    !material.vertexColors
  );
}

function disposeMaterial(material: Material): void {
  for (const value of Object.values(material)) {
    if (value instanceof Texture) value.dispose();
  }
  material.dispose();
}

function easeOutQuint(progress: number): number {
  return 1 - (1 - progress) ** 5;
}

export class ModelStage {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(FOV, 1, 0.1, 100);
  private readonly controls: OrbitControls;
  private readonly observer: ResizeObserver | null;
  private readonly clay: MeshStandardMaterial;
  private readonly clayColored: MeshStandardMaterial;
  private readonly wire: MeshBasicMaterial;
  private readonly lineMaterial: LineBasicMaterial;
  private readonly pointsMaterial: PointsMaterial;
  private readonly pointsColored: PointsMaterial;
  private environment: Texture | null = null;
  /** Holds the model; turned so that the model's up axis is the stage's. */
  private pivot: Group | null = null;
  /** What each mesh is drawn with when the wireframe is off. */
  private readonly shaded = new Map<Mesh, Material | Material[]>();
  private wireframe = false;
  /** The model's bounding sphere on the stage (after the up-axis turn). */
  private bounds: Sphere | null = null;
  private home: CameraPose | null = null;
  /** True while the camera sits in the framed view: a resize then frames the model again. */
  private atHome = true;
  private frame = 0;
  private active = true;
  private disposed = false;
  private tween: { start: number; fromOffset: Spherical; toOffset: Spherical; fromTarget: Vector3; toTarget: Vector3 } | null = null;
  private readonly reducedMotion: boolean;

  /** Throws `StageError('no-webgl')` when the device cannot give a WebGL context. */
  constructor(
    private readonly host: HTMLElement,
    private readonly callbacks: StageCallbacks,
  ) {
    try {
      this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      throw new StageError('no-webgl');
    }
    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const { renderer, camera, scene } = this;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = NeutralToneMapping;
    renderer.setClearColor(0x000000, 0);
    const canvas = renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.touchAction = 'none';
    canvas.setAttribute('aria-hidden', 'true');
    host.appendChild(canvas);

    this.buildEnvironment();
    // The key light rides with the camera, so the model is lit from the reader's upper left
    // whichever way it is turned.
    const key = new DirectionalLight(0xffffff, 1.8);
    key.position.set(-1.2, 1.8, 2);
    camera.add(key);
    scene.add(camera);

    this.clay = new MeshStandardMaterial({ roughness: 0.62, metalness: 0, side: DoubleSide });
    this.clayColored = new MeshStandardMaterial({ roughness: 0.62, metalness: 0, side: DoubleSide, vertexColors: true });
    this.wire = new MeshBasicMaterial({ wireframe: true });
    this.lineMaterial = new LineBasicMaterial();
    this.pointsMaterial = new PointsMaterial({ sizeAttenuation: true });
    this.pointsColored = new PointsMaterial({ sizeAttenuation: true, vertexColors: true });

    this.controls = new OrbitControls(camera, canvas);
    this.controls.enableDamping = !this.reducedMotion;
    this.controls.dampingFactor = 0.14;
    this.controls.rotateSpeed = 0.9;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', this.invalidate);
    this.controls.addEventListener('start', this.onControlStart);
    this.controls.addEventListener('end', this.onControlEnd);

    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);

    this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.resize());
    this.observer?.observe(host);
    this.resize();
  }

  // ── the model ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Puts a model on the stage, replacing the one before it. `bare` gives every surface the neutral
   * material; otherwise the file's own materials stay. `pose` restores where the reader left the
   * camera; null frames the model. Throws `StageError('empty')` when there is nothing to draw.
   */
  setModel(root: Object3D, options: { bare: boolean; upAxis: 'y' | 'z'; pose: CameraPose | null }): ModelStats {
    const stats: ModelStats = { vertices: 0, faces: 0, points: 0, size: [0, 0, 0] };
    root.updateMatrixWorld(true);
    const own = new Box3().setFromObject(root);
    if (own.isEmpty()) throw new StageError('empty');
    const extent = own.getSize(new Vector3());
    stats.size = [extent.x, extent.y, extent.z];

    this.clearModel();
    root.traverse((object) => {
      const item = object as Drawable & { isPoints?: boolean; isLine?: boolean };
      const geometry = item.geometry;
      const position = geometry?.getAttribute('position');
      if (!geometry || !position) return;
      const colored = geometry.getAttribute('color') !== undefined;
      if (isMesh(item)) {
        stats.vertices += position.count;
        const index = geometry.getIndex();
        stats.faces += Math.floor((index ? index.count : position.count) / 3);
        if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
        if (options.bare || materialsOf(item).length === 0) item.material = colored ? this.clayColored : this.clay;
        else if (Array.isArray(item.material)) item.material = item.material.map((material) => (isPlaceholderMaterial(material) ? this.clay : material));
        else if (isPlaceholderMaterial(item.material)) item.material = this.clay;
        this.shaded.set(item, item.material);
      } else if (item.isPoints) {
        stats.points += position.count;
        if (options.bare || materialsOf(item).length === 0) item.material = colored ? this.pointsColored : this.pointsMaterial;
      } else if (item.isLine && (options.bare || materialsOf(item).length === 0)) {
        item.material = this.lineMaterial;
      }
    });

    this.pivot = new Group();
    this.pivot.add(root);
    this.scene.add(this.pivot);
    this.applyUpAxis(options.upAxis);
    this.applyWireframe();
    this.measureModel();
    this.atHome = options.pose === null;
    if (options.pose) this.applyPose(options.pose);
    this.renderNow();
    return stats;
  }

  /** Turns the model so that its `axis` points up, and frames it again. */
  setUpAxis(axis: 'y' | 'z'): void {
    if (!this.pivot) return;
    this.applyUpAxis(axis);
    this.measureModel();
    this.atHome = true;
    this.callbacks.onPose(null);
    this.invalidate();
  }

  setWireframe(on: boolean): void {
    if (this.wireframe === on) return;
    this.wireframe = on;
    this.applyWireframe();
    this.invalidate();
  }

  setColors(colors: StageColors): void {
    const set = (color: Color, rgb: Rgb): void => {
      color.setRGB(rgb[0], rgb[1], rgb[2], SRGBColorSpace);
    };
    set(this.clay.color, colors.clay);
    set(this.wire.color, colors.line);
    set(this.lineMaterial.color, colors.line);
    set(this.pointsMaterial.color, colors.line);
    this.invalidate();
  }

  // ── the camera ────────────────────────────────────────────────────────────────────────────────

  /** Back to the framed view. Eased, unless the reader asked for reduced motion. */
  resetView(): void {
    if (!this.home) return;
    const toTarget = new Vector3(...this.home.target);
    const toOffset = new Spherical().setFromVector3(new Vector3(...this.home.position).sub(toTarget));
    this.callbacks.onPose(null);
    this.atHome = true;
    if (this.reducedMotion) {
      this.applyPose(this.home);
      this.invalidate();
      return;
    }
    const fromTarget = this.controls.target.clone();
    const fromOffset = new Spherical().setFromVector3(this.camera.position.clone().sub(fromTarget));
    // The short way round.
    let turn = toOffset.theta - fromOffset.theta;
    turn = ((turn + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    toOffset.theta = fromOffset.theta + turn;
    this.tween = { start: performance.now(), fromOffset, toOffset, fromTarget, toTarget };
    this.invalidate();
  }

  /** Turns the camera around the model: `azimuth` to the side, `elevation` up and over, in radians. */
  orbit(azimuth: number, elevation: number): void {
    const offset = new Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    offset.theta += azimuth;
    offset.phi = Math.min(Math.PI - 0.02, Math.max(0.02, offset.phi + elevation));
    this.moveCamera(offset);
  }

  /** Moves the camera towards the model (`factor` below 1) or away from it. */
  dolly(factor: number): void {
    const offset = new Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    offset.radius = Math.min(this.controls.maxDistance, Math.max(this.controls.minDistance, offset.radius * factor));
    this.moveCamera(offset);
  }

  // ── lifetime ──────────────────────────────────────────────────────────────────────────────────

  /** A hidden tab draws nothing; coming back draws once. */
  setActive(active: boolean): void {
    this.active = active;
    if (!active) {
      if (this.frame) cancelAnimationFrame(this.frame);
      this.frame = 0;
      return;
    }
    this.resize();
    this.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.observer?.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('webglcontextlost', this.onContextLost);
    canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.controls.dispose();
    this.clearModel();
    this.environment?.dispose();
    for (const material of [this.clay, this.clayColored, this.wire, this.lineMaterial, this.pointsMaterial, this.pointsColored]) material.dispose();
    this.renderer.dispose();
    // The browser allows a handful of live WebGL contexts per page: give this one back now.
    this.renderer.forceContextLoss();
    canvas.remove();
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────

  private buildEnvironment(): void {
    const generator = new PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.environment?.dispose();
    this.environment = generator.fromScene(room, 0.04).texture;
    this.scene.environment = this.environment;
    this.scene.environmentIntensity = 0.75;
    room.dispose();
    generator.dispose();
  }

  private clearModel(): void {
    const pivot = this.pivot;
    if (!pivot) return;
    this.scene.remove(pivot);
    const shared = new Set<Material>([this.clay, this.clayColored, this.wire, this.lineMaterial, this.pointsMaterial, this.pointsColored]);
    const materials = new Set<Material>();
    for (const material of this.shaded.values()) for (const item of Array.isArray(material) ? material : [material]) materials.add(item);
    pivot.traverse((object) => {
      const item = object as Drawable;
      item.geometry?.dispose();
      for (const material of materialsOf(item)) materials.add(material);
    });
    for (const material of materials) if (!shared.has(material)) disposeMaterial(material);
    this.shaded.clear();
    this.pivot = null;
    this.bounds = null;
    this.home = null;
  }

  private applyUpAxis(axis: 'y' | 'z'): void {
    if (!this.pivot) return;
    this.pivot.rotation.set(axis === 'z' ? -Math.PI / 2 : 0, 0, 0);
    this.pivot.updateMatrixWorld(true);
  }

  private applyWireframe(): void {
    for (const [mesh, material] of this.shaded) mesh.material = this.wireframe ? this.wire : material;
  }

  /** Measures the model as it stands on the stage, then frames it. */
  private measureModel(): void {
    if (!this.pivot) return;
    this.bounds = new Box3().setFromObject(this.pivot).getBoundingSphere(new Sphere());
    const radius = Math.max(this.bounds.radius, 1e-6);
    this.camera.near = radius / 200;
    this.camera.far = radius * 400;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = radius * 0.05;
    this.controls.maxDistance = radius * 40;
    this.pointsMaterial.size = radius * 0.012;
    this.pointsColored.size = radius * 0.012;
    this.frameModel();
  }

  /** Works out the view that shows the whole model at the stage's current shape, and goes there. */
  private frameModel(): void {
    const home = this.homePose();
    if (!home) return;
    this.home = home;
    this.applyPose(home);
  }

  private homePose(): CameraPose | null {
    const bounds = this.bounds;
    if (!bounds) return null;
    const radius = Math.max(bounds.radius, 1e-6);
    const vertical = (FOV * Math.PI) / 180;
    // In a tall, narrow panel the horizontal angle is the tighter one.
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * this.camera.aspect);
    const distance = (radius / Math.sin(Math.min(vertical, horizontal) / 2)) * 1.12;
    const offset = new Vector3().setFromSpherical(new Spherical(distance, Math.PI / 2 - HOME_ELEVATION, HOME_AZIMUTH));
    return {
      position: bounds.center.clone().add(offset).toArray() as [number, number, number],
      target: bounds.center.toArray() as [number, number, number],
    };
  }

  private applyPose(pose: CameraPose): void {
    this.tween = null;
    this.camera.position.set(...pose.position);
    this.controls.target.set(...pose.target);
    this.controls.update();
  }

  private pose(): CameraPose {
    return {
      position: this.camera.position.toArray() as [number, number, number],
      target: this.controls.target.toArray() as [number, number, number],
    };
  }

  private moveCamera(offset: Spherical): void {
    this.tween = null;
    this.atHome = false;
    this.camera.position.copy(this.controls.target).add(new Vector3().setFromSpherical(offset));
    this.controls.update();
    this.callbacks.onPose(this.pose());
    this.invalidate();
  }

  private resize(): void {
    if (this.disposed) return;
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    // The framed view depends on the stage's shape. A camera the reader placed is left alone.
    if (this.atHome && !this.tween) this.frameModel();
    else this.home = this.homePose() ?? this.home;
    // Drawn before the browser paints the new size, so resizing never shows a stretched frame.
    this.renderNow();
  }

  private renderNow(): void {
    if (this.disposed || !this.pivot) return;
    this.renderer.render(this.scene, this.camera);
  }

  /** Asks for one frame. Safe to call many times before it is drawn. */
  private readonly invalidate = (): void => {
    if (!this.active || this.disposed || this.frame) return;
    this.frame = requestAnimationFrame(this.tick);
  };

  private readonly tick = (now: number): void => {
    this.frame = 0;
    if (this.disposed) return;
    const tween = this.tween;
    if (tween) {
      const progress = Math.min(1, (now - tween.start) / RESET_MS);
      const eased = easeOutQuint(progress);
      const offset = new Spherical(
        tween.fromOffset.radius + (tween.toOffset.radius - tween.fromOffset.radius) * eased,
        tween.fromOffset.phi + (tween.toOffset.phi - tween.fromOffset.phi) * eased,
        tween.fromOffset.theta + (tween.toOffset.theta - tween.fromOffset.theta) * eased,
      );
      this.controls.target.lerpVectors(tween.fromTarget, tween.toTarget, eased);
      this.camera.position.copy(this.controls.target).add(new Vector3().setFromSpherical(offset));
      if (progress >= 1) this.tween = null;
      else this.invalidate();
    }
    // While the camera is still gliding to a stop, `update` reports a change, which asks for the
    // next frame through the 'change' listener; once it has settled, the loop ends by itself.
    this.controls.update();
    this.renderNow();
  };

  private readonly onControlStart = (): void => {
    this.tween = null;
    this.atHome = false;
    this.callbacks.onInteract();
  };

  private readonly onControlEnd = (): void => {
    this.callbacks.onPose(this.pose());
  };

  private readonly onContextLost = (event: Event): void => {
    // Without this the browser never offers the context back.
    event.preventDefault();
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  };

  private readonly onContextRestored = (): void => {
    if (this.disposed) return;
    this.buildEnvironment();
    this.invalidate();
  };
}
