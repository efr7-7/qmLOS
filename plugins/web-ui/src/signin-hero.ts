import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";

const FALLBACK_ACCENT = "#34d9ab";

function resolveAccent(): THREE.Color {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--qm-accent").trim();
    if (/^#[0-9a-fA-F]{3,8}$/.test(raw)) return new THREE.Color(raw);
    if (raw) {
      const probe = document.createElement("span");
      probe.style.color = raw;
      document.body.appendChild(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      if (resolved) return new THREE.Color(resolved);
    }
  } catch {
    void 0;
  }
  return new THREE.Color(FALLBACK_ACCENT);
}

function shellGeometry(count: number, inner: number, outer: number): THREE.BufferGeometry {
  const positions = new Float32Array(count * 3);
  const golden = Math.PI * (1 + Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const phi = Math.acos(1 - (2 * (i + 0.5)) / count);
    const theta = golden * i;
    const wobble = 0.5 + 0.5 * Math.sin(i * 12.9898 + 78.233);
    const r = inner + (outer - inner) * wobble;
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return geometry;
}

export function mountSigninHero(host: HTMLElement): () => void {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
  } catch {
    return () => undefined;
  }
  renderer.setClearColor(0x000000, 0);
  host.appendChild(renderer.domElement);

  const accent = resolveAccent();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 40);
  camera.position.set(0, 0, 5.4);

  const lineMat = (opacity: number) =>
    new THREE.LineBasicMaterial({
      color: accent,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
  const pointMat = (size: number, opacity: number) =>
    new THREE.PointsMaterial({
      color: accent,
      size,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });

  const latticeGeo = new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1.5, 1));
  const nucleusGeo = new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(0.5, 0));
  const vertexGeo = mergeVertices(new THREE.IcosahedronGeometry(1.5, 1));
  const haloGeo = shellGeometry(200, 2, 3.1);

  const lattice = new THREE.LineSegments(latticeGeo, lineMat(0.15));
  const nucleus = new THREE.LineSegments(nucleusGeo, lineMat(0.32));
  const vertexPoints = new THREE.Points(vertexGeo, pointMat(0.05, 0.55));
  const halo = new THREE.Points(haloGeo, pointMat(0.028, 0.24));

  const core = new THREE.Group();
  core.add(lattice, nucleus, vertexPoints, halo);
  scene.add(core);

  const geometries = [latticeGeo, nucleusGeo, vertexGeo, haloGeo];
  const materials = [lattice.material, nucleus.material, vertexPoints.material, halo.material];

  const pose = (t: number) => {
    core.rotation.y = t * 0.05;
    core.rotation.x = 0.4 + 0.04 * Math.sin(t * 0.21);
    core.rotation.z = 0.02 * Math.sin(t * 0.13);
    nucleus.rotation.y = -t * 0.11;
    nucleus.rotation.x = t * 0.07;
    halo.rotation.y = -t * 0.018;
    const breath = 1 + 0.025 * Math.sin(t * 0.4);
    lattice.scale.setScalar(breath);
    vertexPoints.scale.setScalar(breath);
  };

  const resize = () => {
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const halfW = Math.tan((camera.fov * Math.PI) / 360) * camera.position.z * camera.aspect;
    core.position.set(camera.aspect > 1 ? -halfW * 0.42 : 0, 0.1, 0);
    renderer.render(scene, camera);
  };

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let t = 46;
  let last = performance.now();
  let frame = 0;
  let disposed = false;

  const tick = () => {
    frame = requestAnimationFrame(tick);
    const now = performance.now();
    t += Math.min(now - last, 100) / 1000;
    last = now;
    pose(t);
    renderer.render(scene, camera);
  };

  const onVisibility = () => {
    if (disposed || reduced) return;
    cancelAnimationFrame(frame);
    if (!document.hidden) {
      last = performance.now();
      frame = requestAnimationFrame(tick);
    }
  };

  const observer = new ResizeObserver(resize);
  observer.observe(host);
  pose(t);
  resize();
  if (!reduced) {
    document.addEventListener("visibilitychange", onVisibility);
    frame = requestAnimationFrame(tick);
  }

  return () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    document.removeEventListener("visibilitychange", onVisibility);
    observer.disconnect();
    for (const g of geometries) g.dispose();
    for (const m of materials) m.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  };
}
