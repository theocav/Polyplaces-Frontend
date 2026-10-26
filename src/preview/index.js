// Main-thread side of the 3D preview (spec B1, B3): starts the compute worker,
// renders its triangle buffers with three.js and reports lifecycle events.
//
//   const preview = createPreview(el, { bbox: [S, W, N, E], config, frame, rotated, onProgress, onWarning, onError, onReady });
//   preview.setView('room' | 'model');
//   preview.dispose();
//
// `frame` ('small' | 'medium' | 'large') hangs the sculpture in that IKEA
// frame, fitted to its mount opening, on a room wall. Without it, or if the
// frame fails to load, only the bare model view is shown. `rotated` hangs it
// landscape, for a frame turned 90 degrees on the map.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PROFILE, validateBbox, maxPreviewDegrees } from './config.js';
import FRAMES from './frames.json';

/* global __PREVIEW_WORKER_URL__ */
const WORKER_URL = typeof __PREVIEW_WORKER_URL__ !== 'undefined' ? __PREVIEW_WORKER_URL__ : './preview-worker.js';

// Share of the overall bar each stage fills.
const STAGE_WEIGHTS = { terrain: 0.35, buildings: 0.3, water: 0.1, footprints: 0.05, mesh: 0.2 };

// The sculpture prints in one matte white, so every layer shares it.
const SCULPTURE_COLOR = 0xeee8dd;

const ROOM = {
  wall: 0xe9e2d6,
  floor: 0xa98564,
  skirting: 0xf4f1ec,
  sideboard: 0x8a6a4f,
  sideboardHeight: 0.72, // metres
  hangGap: 0.24, // sideboard top to frame bottom
};

export function hasWebGL2() {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

export function createPreview(container, opts) {
  const { bbox, config = {}, frame, rotated = false, onProgress, onWarning, onError, onReady } = opts;
  let disposed = false;
  let finished = false;
  let worker = null;
  let timer = null;
  let renderer = null;
  let resizeObs = null;
  let views = {};
  let active = null;
  let dirty = true;
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

  const stub = { setView() {}, dispose() { disposed = true; } };
  if (!validateBbox(bbox, maxPreviewDegrees(config.includeBuildings))) {
    queueMicrotask(() => fail('bad_bbox', 'This area is too large to preview.'));
    return stub;
  }
  if (!hasWebGL2()) {
    queueMicrotask(() => fail('no_webgl', 'Your browser cannot show 3D previews.'));
    return stub;
  }

  try {
    worker = new Worker(WORKER_URL);
  } catch (err) {
    queueMicrotask(() => fail('failed', err?.message || 'Preview could not start.'));
    return stub;
  }

  // Start the frame download alongside the compute so it is ready together.
  const frameInfo = frame ? FRAMES[frame] : null;
  const framePromise = frameInfo
    ? new GLTFLoader().loadAsync(frameInfo.url).catch(() => null)
    : Promise.resolve(null);

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
      framePromise.then((gltf) => {
        if (disposed) return;
        if (frameInfo && !gltf) onWarning?.('frame_missing', 'The frame could not be loaded.');
        try {
          render(msg, gltf);
          onReady?.({ size: msg.size, stats: msg.stats, attribution: msg.attribution, views: Object.keys(views), view: active });
        } catch (err) {
          finished = false;
          fail('no_webgl', err?.message || 'The preview could not be drawn.');
        }
      });
    }
  };
  worker.postMessage({ type: 'run', bbox, config });

  // One sculpture mesh set per view; geometry and material are shared.
  function buildSculpture(msg, material) {
    // Print space is Z up with Y north; three is Y up, so north becomes -Z.
    const group = new THREE.Group();
    group.rotation.x = -Math.PI / 2;
    for (const layer of Object.values(msg.layers)) {
      if (!layer.geometry) continue;
      const mesh = new THREE.Mesh(layer.geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    return group;
  }

  function modelView(msg, material) {
    const scene = new THREE.Scene();
    const sculpture = buildSculpture(msg, material);
    scene.add(sculpture);
    scene.add(new THREE.HemisphereLight(0xffffff, 0xb9a98f, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2.0);
    sun.position.set(-0.6, 1, 0.45);
    scene.add(sun);

    const box = new THREE.Box3().setFromObject(sculpture);
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

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(center);
    controls.minDistance = span * 0.15;
    controls.maxDistance = span * 4;
    controls.maxPolarAngle = Math.PI * 0.49;
    return { scene, camera, controls };
  }

  function roomView(msg, material, gltf) {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(ROOM.wall);
    const flat = (color, roughness = 0.95) => {
      const m = new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 });
      disposables.push(m);
      return m;
    };
    const box = (w, h, d, mat) => {
      const g = new THREE.BoxGeometry(w, h, d);
      disposables.push(g);
      const mesh = new THREE.Mesh(g, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      return mesh;
    };

    // Wall at z = 0 facing +z, floor at y = 0, skirting and a low sideboard.
    const wallGeom = new THREE.PlaneGeometry(8, 4);
    const floorGeom = new THREE.PlaneGeometry(8, 6);
    disposables.push(wallGeom, floorGeom);
    const wall = new THREE.Mesh(wallGeom, flat(ROOM.wall));
    wall.position.set(0, 2, 0);
    wall.receiveShadow = true;
    const floor = new THREE.Mesh(floorGeom, flat(ROOM.floor, 0.8));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, 3);
    floor.receiveShadow = true;
    const skirting = box(8, 0.1, 0.018, flat(ROOM.skirting));
    skirting.position.set(0, 0.05, 0.009);
    const sideboard = box(1.4, ROOM.sideboardHeight, 0.42, flat(ROOM.sideboard, 0.7));
    sideboard.position.set(0, ROOM.sideboardHeight / 2, 0.22);
    scene.add(wall, floor, skirting, sideboard);

    // A vase and a few books on the sideboard, for scale.
    const ceramic = flat(0xf3efe8, 0.6);
    const vaseProfile = [[0, 0], [0.055, 0], [0.075, 0.06], [0.07, 0.15], [0.035, 0.22], [0.032, 0.26], [0.04, 0.27]]
      .map(([r, h]) => new THREE.Vector2(r, h));
    const vaseGeom = new THREE.LatheGeometry(vaseProfile, 40);
    disposables.push(vaseGeom);
    const vase = new THREE.Mesh(vaseGeom, ceramic);
    vase.castShadow = true;
    vase.position.set(0.48, ROOM.sideboardHeight, 0.2);
    scene.add(vase);
    [[0x5b6b5a, 0.035], [0xc9b79c, 0.028], [0x2f3b4a, 0.04]].reduce((y, [color, h], k) => {
      const book = box(0.22 - k * 0.015, h, 0.16, flat(color, 0.85));
      book.position.set(-0.48 + k * 0.006, y + h / 2, 0.2);
      book.rotation.y = (k - 1) * 0.08;
      scene.add(book);
      return y + h;
    }, ROOM.sideboardHeight);

    // The frame lies face up in its file (+Y front, Y = 0 back); stand it on
    // the wall so its front faces the room and its -Z edge is the top, hung
    // a hand's width above the sideboard. A rotated selection (the A4 frame
    // turned on the map) hangs the frame landscape.
    const frameRoot = gltf.scene;
    const fileSize = new THREE.Box3().setFromObject(frameRoot).getSize(new THREE.Vector3());
    const frameHeight = rotated ? fileSize.x : fileSize.z;
    frameRoot.rotation.x = Math.PI / 2;
    const hanger = new THREE.Group();
    hanger.add(frameRoot);
    if (rotated) hanger.rotation.z = Math.PI / 2;
    hanger.position.set(0, ROOM.sideboardHeight + ROOM.hangGap + frameHeight / 2, 0.002);
    frameRoot.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      // No glass: a raised sculpture sits proud of where it would be.
      if (mats.some((m) => m.transparent)) { o.visible = false; return; }
      o.castShadow = true;
      o.receiveShadow = true;
    });
    scene.add(hanger);

    // Fit the sculpture inside the mount opening (frame-local metres) at one
    // uniform scale, so a shape mismatch leaves a margin rather than
    // stretching the map. Its base rests on the backing board behind the
    // mount. In a landscape-hung frame the holder turns back so north stays up.
    const { opening, backY } = frameInfo;
    const openX = opening.xmax - opening.xmin;
    const openZ = opening.zmax - opening.zmin;
    const [openW, openH] = rotated ? [openZ, openX] : [openX, openZ];
    const s = Math.min(openW / msg.size.widthMm, openH / msg.size.depthMm);
    const holder = new THREE.Group();
    holder.position.set((opening.xmin + opening.xmax) / 2, backY, (opening.zmin + opening.zmax) / 2);
    if (rotated) holder.rotation.y = -Math.PI / 2;
    const sculpture = buildSculpture(msg, material);
    sculpture.scale.setScalar(s);
    sculpture.position.y = msg.size.baseMm * s;
    holder.add(sculpture);
    frameRoot.add(holder);

    // Soft window light from the front left; a broad fill keeps shadows gentle.
    scene.add(new THREE.HemisphereLight(0xfffaf2, 0x9a8670, 1.7));
    const sun = new THREE.DirectionalLight(0xfff4e6, 1.3);
    sun.position.set(-1.6, 2.6, 3.2);
    sun.target.position.copy(hanger.position);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.radius = 6;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.002;
    Object.assign(sun.shadow.camera, { left: -1.2, right: 1.2, top: 1.2, bottom: -1.6, near: 0.5, far: 8 });
    scene.add(sun, sun.target);

    hanger.updateMatrixWorld(true);
    const frameBox = new THREE.Box3().setFromObject(hanger);
    const frameSize = frameBox.getSize(new THREE.Vector3());
    const frameCenter = frameBox.getCenter(new THREE.Vector3());
    const aspect = (container.clientWidth || 1) / (container.clientHeight || 1);
    const camera = new THREE.PerspectiveCamera(40, aspect, 0.01, 30);
    // Frame about a third of the view, the sideboard top in shot below it so
    // it reads as a room; seen from slightly to one side.
    const target = new THREE.Vector3(frameCenter.x, frameCenter.y - frameSize.y * 0.45, frameCenter.z);
    const halfV = THREE.MathUtils.degToRad(20);
    const halfFit = Math.min(halfV, Math.atan(Math.tan(halfV) * aspect));
    const dist = Math.max(0.42, frameSize.y * 1.45) / Math.tan(halfFit);
    camera.position.set(target.x + dist * 0.22, target.y + dist * 0.02, dist);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(target);
    controls.minDistance = Math.max(frameSize.x, frameSize.y) * 0.35;
    controls.maxDistance = 3.2;
    controls.minAzimuthAngle = -Math.PI * 0.38;
    controls.maxAzimuthAngle = Math.PI * 0.38;
    controls.minPolarAngle = Math.PI * 0.3;
    controls.maxPolarAngle = Math.PI * 0.62;
    controls.enablePan = false;
    return { scene, camera, controls };
  }

  function render(msg, gltf) {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.touchAction = 'none';

    for (const layer of Object.values(msg.layers)) {
      if (!layer.positions.length) continue;
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(layer.positions, 3));
      geom.computeVertexNormals();
      layer.geometry = geom;
      disposables.push(geom);
    }
    const material = new THREE.MeshStandardMaterial({
      color: SCULPTURE_COLOR,
      roughness: 0.92,
      metalness: 0,
      flatShading: true,
      side: THREE.DoubleSide,
    });
    disposables.push(material);

    views.model = modelView(msg, material);
    if (gltf && frameInfo) {
      views.room = roomView(msg, material, gltf);
      disposables.push({ dispose: () => gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry.dispose();
        for (const m of [].concat(o.material)) {
          for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
          m.dispose();
        }
      }) });
    }
    for (const v of Object.values(views)) {
      v.controls.enableDamping = true;
      v.controls.dampingFactor = 0.08;
      v.controls.enabled = false;
      v.controls.update();
      v.controls.addEventListener('change', () => { dirty = true; });
    }
    setView(views.room ? 'room' : 'model');

    const resize = () => {
      const w = container.clientWidth || 1, h = container.clientHeight || 1;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      for (const v of Object.values(views)) {
        v.camera.aspect = w / h;
        v.camera.updateProjectionMatrix();
      }
      dirty = true;
    };
    resize();
    resizeObs = new ResizeObserver(resize);
    resizeObs.observe(container);

    renderer.setAnimationLoop(() => {
      const v = views[active];
      if (!v) return;
      const moved = v.controls.update();
      if (moved || dirty) {
        dirty = false;
        renderer.render(v.scene, v.camera);
      }
    });
  }

  function setView(name) {
    if (!views[name]) return;
    if (views[active]) views[active].controls.enabled = false;
    active = name;
    views[name].controls.enabled = true;
    dirty = true;
  }

  return {
    setView,
    dispose() {
      if (disposed) return;
      disposed = true;
      cleanupWorker();
      resizeObs?.disconnect();
      for (const v of Object.values(views)) v.controls.dispose();
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
