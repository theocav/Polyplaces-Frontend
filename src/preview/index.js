// Main-thread side of the 3D preview (spec B1, B3): starts the compute worker,
// renders its triangle buffers with three.js and reports lifecycle events.
//
//   const preview = createPreview(el, { bbox: [S, W, N, E], config, onProgress, onWarning, onError, onReady });
//   preview.dispose();

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PROFILE, validateBbox } from './config.js';

/* global __PREVIEW_WORKER_URL__ */
const WORKER_URL = typeof __PREVIEW_WORKER_URL__ !== 'undefined' ? __PREVIEW_WORKER_URL__ : './preview-worker.js';

// Share of the overall bar each stage fills.
const STAGE_WEIGHTS = { terrain: 0.35, buildings: 0.3, water: 0.1, footprints: 0.05, mesh: 0.2 };

const LAYER_STYLE = {
  terrain: { color: 0xeee8dd },
  base: { color: 0x8a8a8a },
  buildings: { vertexColors: true },
  waterFloor: { color: 0x6495ed },
  waterWalls: { color: 0x4a73b8 },
};

export function hasWebGL2() {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

export function createPreview(container, opts) {
  const { bbox, config = {}, onProgress, onWarning, onError, onReady } = opts;
  let disposed = false;
  let finished = false;
  let worker = null;
  let timer = null;
  let renderer = null;
  let controls = null;
  let resizeObs = null;
  const disposables = [];
  const stageProgress = {};

  const fail = (code, message) => {
    if (finished || disposed) return;
    finished = true;
    cleanupWorker();
    onError?.(code, message);
  };

  function cleanupWorker() {
    clearTimeout(timer);
    if (worker) { worker.terminate(); worker = null; }
  }

  if (!validateBbox(bbox, PROFILE.maxBboxDegrees)) {
    queueMicrotask(() => fail('bad_bbox', 'This area is too large to preview.'));
    return { dispose() { disposed = true; } };
  }
  if (!hasWebGL2()) {
    queueMicrotask(() => fail('no_webgl', 'Your browser cannot show 3D previews.'));
    return { dispose() { disposed = true; } };
  }

  try {
    worker = new Worker(WORKER_URL);
  } catch (err) {
    queueMicrotask(() => fail('failed', err?.message || 'Preview could not start.'));
    return { dispose() { disposed = true; } };
  }

  timer = setTimeout(() => fail('timeout', 'The preview took too long to build.'), PROFILE.timeoutMs);
  worker.onerror = (e) => { e.preventDefault?.(); fail('oom', 'The preview ran out of memory. Try a smaller area.'); };
  worker.onmessage = (e) => {
    const msg = e.data;
    if (disposed || finished) return;
    if (msg.type === 'progress') {
      stageProgress[msg.stage] = msg.value;
      let overall = 0;
      for (const [k, w] of Object.entries(STAGE_WEIGHTS)) overall += w * (stageProgress[k] || 0);
      onProgress?.(msg.stage, msg.value, Math.min(overall, 1));
    } else if (msg.type === 'warning') {
      onWarning?.(msg.code, msg.message);
    } else if (msg.type === 'error') {
      fail(msg.code, msg.message);
    } else if (msg.type === 'ready') {
      finished = true;
      cleanupWorker();
      try {
        render(msg);
        onReady?.({ size: msg.size, stats: msg.stats, attribution: msg.attribution });
      } catch (err) {
        finished = false;
        fail('no_webgl', err?.message || 'The preview could not be drawn.');
      }
    }
  };
  worker.postMessage({ type: 'run', bbox, config });

  function render(msg) {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.touchAction = 'none';

    const scene = new THREE.Scene();
    // Print space is Z up with Y north; three is Y up, so north becomes -Z.
    const model = new THREE.Group();
    model.rotation.x = -Math.PI / 2;
    scene.add(model);

    for (const [name, layer] of Object.entries(msg.layers)) {
      if (!layer.positions.length) continue;
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(layer.positions, 3));
      if (layer.colors) geom.setAttribute('color', new THREE.BufferAttribute(layer.colors, 3));
      geom.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({
        ...LAYER_STYLE[name],
        roughness: 0.92,
        metalness: 0,
        flatShading: true,
        side: THREE.DoubleSide,
      });
      disposables.push(geom, mat);
      model.add(new THREE.Mesh(geom, mat));
    }

    scene.add(new THREE.HemisphereLight(0xffffff, 0xb9a98f, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2.0);
    sun.position.set(-0.6, 1, 0.45);
    scene.add(sun);

    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.z);

    const aspect = (container.clientWidth || 1) / (container.clientHeight || 1);
    const camera = new THREE.PerspectiveCamera(35, aspect, span / 200, span * 20);
    // Fit the model to the narrower of the two fields of view.
    const halfV = THREE.MathUtils.degToRad(35 / 2);
    const halfFit = Math.min(halfV, Math.atan(Math.tan(halfV) * aspect));
    const dist = (span / 2 / Math.tan(halfFit)) * 1.15;
    // North-up, looking north from the south at a top-oblique angle.
    camera.position.set(center.x, center.y + dist * 0.78, center.z + dist * 0.62);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(center);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = span * 0.15;
    controls.maxDistance = span * 4;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.screenSpacePanning = true;
    controls.update();

    let dirty = true;
    controls.addEventListener('change', () => { dirty = true; });
    const resize = () => {
      const w = container.clientWidth || 1, h = container.clientHeight || 1;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      dirty = true;
    };
    resize();
    resizeObs = new ResizeObserver(resize);
    resizeObs.observe(container);

    renderer.setAnimationLoop(() => {
      const moved = controls.update();
      if (moved || dirty) {
        dirty = false;
        renderer.render(scene, camera);
      }
    });
  }

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      cleanupWorker();
      resizeObs?.disconnect();
      controls?.dispose();
      for (const d of disposables) d.dispose();
      if (renderer) {
        renderer.setAnimationLoop(null);
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
      }
    },
  };
}
