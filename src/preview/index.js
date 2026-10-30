// Main-thread side of the 3D preview (spec B1, B3): starts the compute worker,
// renders its triangle buffers with three.js and reports lifecycle events.
//
//   const preview = createPreview(el, { bbox: [S, W, N, E], config, room, onProgress, onWarning, onError, onReady });
//   preview.setView('room' | 'model');
//   await preview.setFrame('oak' | 'black' | 'white' | null);
//   preview.dispose();
//
// `room` hangs the piece on a wall above a sideboard:
//   { size: 'small' | 'medium' | 'large' | null,   frame range (frames.json)
//     colour: 'oak' | 'black' | 'white' | null,     null = no frame
//     bareMm: [w, h],                               the piece's own size, unframed
//     rotated: bool }                               landscape (A4 turned on the map)
// A framed piece fills its mount opening; an unframed one hangs bare at
// bareMm. Without `room`, only the close-up model view is shown.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { buildRoom, SIDEBOARD_HEIGHT } from './room.js';
import { PROFILE, validateBbox, maxPreviewDegrees } from './config.js';
import FRAMES from './frames.json';

/* global __PREVIEW_WORKER_URL__ */
const WORKER_URL = typeof __PREVIEW_WORKER_URL__ !== 'undefined' ? __PREVIEW_WORKER_URL__ : './preview-worker.js';

// Share of the overall bar each stage fills.
const STAGE_WEIGHTS = { terrain: 0.35, buildings: 0.3, water: 0.1, footprints: 0.05, mesh: 0.2 };

// The sculpture prints in one matte white, so every layer shares it.
const SCULPTURE_COLOR = 0xeee8dd;

// Shadow map size for the room light; phones get a smaller one.
const SHADOW_MAP = typeof matchMedia === 'function' && matchMedia('(max-width: 640px)').matches ? 2048 : 4096;

const ROOM = {
  background: 0xd6cdc0, // beyond the wall's edges, rarely seen
  hangGap: 0.24, // sideboard top to frame bottom, metres
};

export function hasWebGL2() {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

export function createPreview(container, opts) {
  const { bbox, config = {}, room = null, onProgress, onWarning, onError, onReady } = opts;
  const rotated = !!room?.rotated;
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

  const stub = { setView() {}, async setFrame() { return null; }, dispose() { disposed = true; } };
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

  // Frame models load on demand, once per colour; the initial one starts
  // alongside the compute so it is ready together.
  const frameRange = room?.size ? FRAMES[room.size] || null : null;
  const loader = new GLTFLoader();
  const frameLoads = {};
  const loadFrame = (colour) => {
    if (!frameRange?.[colour]) return Promise.resolve(null);
    frameLoads[colour] ||= loader.loadAsync(frameRange[colour].url).then((gltf) => {
      disposables.push({ dispose: () => gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry.dispose();
        for (const m of [].concat(o.material)) {
          for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
          m.dispose();
        }
      }) });
      return gltf;
    }).catch(() => null);
    return frameLoads[colour];
  };
  const framePromise = loadFrame(room?.colour);

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
        if (room?.colour && !gltf) onWarning?.('frame_missing', 'The frame could not be loaded.');
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

  function modelView(msg, material, env) {
    const scene = new THREE.Scene();
    scene.environment = env;
    scene.environmentIntensity = 0.45;
    const sculpture = buildSculpture(msg, material);
    scene.add(sculpture);
    scene.add(new THREE.HemisphereLight(0xffffff, 0xb9a98f, 0.5));

    const box = new THREE.Box3().setFromObject(sculpture);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.z);

    // Raking light from the front left (south-west), with shadows, so streets
    // and building edges read the way they do on the printed piece.
    const sun = new THREE.DirectionalLight(0xfffaf2, 3.8);
    sun.position.copy(center).add(new THREE.Vector3(-0.75, 0.9, 0.5).multiplyScalar(span * 2));
    sun.target.position.copy(center);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = span * 0.0008;
    Object.assign(sun.shadow.camera, {
      left: -span * 0.8, right: span * 0.8, top: span * 0.8, bottom: -span * 0.8, near: span * 0.5, far: span * 5,
    });
    scene.add(sun, sun.target);

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
    return { scene, camera, controls, sculpture, aoPerDistance: (span * 0.02) / camera.position.distanceTo(center) };
  }

  function roomView(msg, material, env) {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(ROOM.background);
    buildRoom(scene, renderer, disposables);
    scene.environment = env;
    scene.environmentIntensity = 0.45;

    // Hang height and camera are fixed by the size's largest frame (or the
    // bare piece when the size has no frames), so swapping frames never
    // moves the view.
    const outers = Object.values(frameRange || {}).map((f) => f.outer);
    const bare = room.bareMm.map((v) => v / 1000);
    const [bareW, bareH] = rotated ? [bare[1], bare[0]] : bare;
    const hangW = outers.length ? Math.max(...outers.map((o) => (rotated ? o.h : o.w))) : bareW;
    const hangH = outers.length ? Math.max(...outers.map((o) => (rotated ? o.w : o.h))) : bareH;
    const centre = new THREE.Vector3(0, SIDEBOARD_HEIGHT + ROOM.hangGap + hangH / 2, 0);

    // Sculpture scaled to w x h metres, north up, its up axis turned to +Y
    // of the returned group and its base at Y = 0. Each axis is scaled to
    // its side (the IKEA openings differ from the product shapes by a few
    // percent, which a stretch hides better than a margin); height takes the
    // mean of the two.
    function fitted(w, h) {
      const sw = w / msg.size.widthMm;
      const sh = h / msg.size.depthMm;
      const sv = (sw + sh) / 2;
      const sculpture = buildSculpture(msg, material);
      sculpture.name = 'sculpture';
      // Sculpture axes before its own rotation: x east, y north, z up.
      sculpture.scale.set(sw, sh, sv);
      sculpture.position.y = msg.size.baseMm * sv;
      const wrap = new THREE.Group();
      wrap.add(sculpture);
      return wrap;
    }

    // Framed: the frame lies face up in its file (+Y front, Y = 0 back), so
    // it is stood on the wall with its -Z edge at the top, turned 90 degrees
    // for a landscape selection. The sculpture fills the mount opening, base
    // on the backing board. Glass is hidden: a raised sculpture would sit
    // proud of where it is.
    function framed(gltf, info) {
      const frameRoot = gltf.scene;
      frameRoot.rotation.x = Math.PI / 2;
      for (const c of frameRoot.children.filter((o) => o.userData.sculpture)) frameRoot.remove(c);
      frameRoot.traverse((o) => {
        if (!o.isMesh) return;
        const mats = [].concat(o.material);
        if (mats.some((m) => m.transparent)) { o.visible = false; return; }
        // Keep dark finishes dark under the room's environment light.
        for (const m of mats) m.envMapIntensity = 0.35;
        o.castShadow = true;
        o.receiveShadow = true;
      });
      const hanger = new THREE.Group();
      hanger.add(frameRoot);
      if (rotated) hanger.rotation.z = Math.PI / 2;
      hanger.position.set(centre.x, centre.y, 0.002);

      const { opening, backY } = info;
      const openX = opening.xmax - opening.xmin;
      const openZ = opening.zmax - opening.zmin;
      const [openW, openH] = rotated ? [openZ, openX] : [openX, openZ];
      const holder = fitted(openW, openH);
      holder.userData.sculpture = true;
      holder.position.set((opening.xmin + opening.xmax) / 2, backY, (opening.zmin + opening.zmax) / 2);
      if (rotated) holder.rotation.y = -Math.PI / 2; // keep north up
      frameRoot.add(holder);
      return hanger;
    }

    // Unframed: the bare piece lies flat on the sideboard between the books
    // and the vase, north towards the wall, as it would on a desk.
    const deskSpot = new THREE.Vector3(0, SIDEBOARD_HEIGHT, 0.2);
    function unframed() {
      const piece = fitted(bareW, bareH);
      piece.position.copy(deskSpot);
      return piece;
    }

    let current = null;
    let shown = false;
    let request = 0;
    // `from` is the close-up view when a frame is picked there: the room
    // camera starts where the close-up camera sits relative to the piece,
    // then pulls back to the wall, so the piece appears to settle into its
    // frame rather than the view cutting away.
    async function hang(colour, from) {
      const ticket = ++request;
      const gltf = colour ? await loadFrame(colour) : null;
      // A later choice wins if the user clicks quickly through colours.
      if (disposed || ticket !== request) return null;
      const next = gltf ? framed(gltf, frameRange[colour]) : unframed();
      if (current) scene.remove(current);
      current = next;
      scene.add(current);
      if (from && shown && !reducedMotion()) {
        current.updateMatrixWorld(true);
        from.sculpture.updateMatrixWorld(true);
        const toRoom = current.getObjectByName('sculpture').matrixWorld.clone()
          .multiply(from.sculpture.matrixWorld.clone().invert());
        cancelAnimationFrame(glide);
        camera.position.copy(from.camera.position).applyMatrix4(toRoom);
        controls.target.copy(from.controls.target).applyMatrix4(toRoom);
        camera.lookAt(controls.target);
        enterFrom(from);
        frameView('wall', false, 1200);
      } else {
        frameView(gltf ? 'wall' : 'desk', !shown);
      }
      shown = true;
      dirty = true;
      return gltf ? colour : null;
    }

    // Daylight from a window off to the left: a wide, soft-edged spot that
    // leaves a gentle pool of light on the wall, plus a dim warm bounce.
    scene.add(new THREE.HemisphereLight(0xfff8ee, 0x8a7258, 0.35));
    const sun = new THREE.SpotLight(0xfff0dc, 5.5, 0, 0.62, 0.95, 0);
    sun.position.set(-2.4, 2.6, 1.7);
    sun.target.position.copy(centre).add(new THREE.Vector3(0.1, -0.3, 0.1));
    sun.castShadow = true;
    // The shadow map covers only the middle of the cone (the sideboard top
    // and the hung piece) rather than the whole wall: about 0.5 mm per texel
    // instead of 2.5 mm, so small buildings cast clean shadows up close.
    sun.shadow.focus = 0.35;
    sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    sun.shadow.bias = -0.0002;
    sun.shadow.normalBias = 0.003;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 7;
    scene.add(sun, sun.target);

    const aspect = (container.clientWidth || 1) / (container.clientHeight || 1);
    const camera = new THREE.PerspectiveCamera(40, aspect, 0.01, 30);
    const halfV = THREE.MathUtils.degToRad(20);
    const halfFit = Math.min(halfV, Math.atan(Math.tan(halfV) * aspect));

    // Two camera poses. Wall: the frame about a third of the view with the
    // sideboard top below it, seen slightly from one side. Desk: looking
    // down at the piece on the sideboard, wall and grasses behind it.
    const wallTarget = new THREE.Vector3(centre.x, centre.y - hangH * 0.45, 0.03);
    const wallDist = Math.max(0.42, hangH * 1.45) / Math.tan(halfFit);
    const deskTarget = deskSpot.clone().add(new THREE.Vector3(0, 0.03, 0));
    const deskDist = Math.max(0.5, Math.max(bareW, bareH) * 1.8) / Math.tan(halfFit);
    const poses = {
      wall: {
        target: wallTarget,
        position: wallTarget.clone().add(new THREE.Vector3(0.22, 0.02, 1).multiplyScalar(wallDist)),
        polar: [Math.PI * 0.3, Math.PI * 0.62],
        reach: new THREE.Vector3(hangW * 0.75, hangH * 0.75, 0.05),
      },
      desk: {
        target: deskTarget,
        position: deskTarget.clone().add(new THREE.Vector3(0.18, 0.62, 0.78).normalize().multiplyScalar(deskDist)),
        polar: [Math.PI * 0.12, Math.PI * 0.47],
        reach: new THREE.Vector3(Math.max(bareW, bareH) * 0.75, 0.08, Math.max(bareW, bareH) * 0.6),
      },
    };

    const controls = new OrbitControls(camera, renderer.domElement);
    const minDistance = Math.max(hangW, hangH) * 0.35;
    controls.minDistance = minDistance;
    controls.maxDistance = 3.2;
    controls.minAzimuthAngle = -Math.PI * 0.38;
    controls.maxAzimuthAngle = Math.PI * 0.38;
    controls.screenSpacePanning = true;

    // Panning is on a leash: the target may wander a little way from the
    // current pose's target (enough to inspect any corner of the piece) and
    // the camera moves with it, so the scene can't be lost.
    const leash = { centre: new THREE.Vector3(), reach: new THREE.Vector3() };
    controls.addEventListener('change', () => {
      const t = controls.target;
      const min = leash.centre.clone().sub(leash.reach);
      const max = leash.centre.clone().add(leash.reach);
      const clamped = t.clone().clamp(min, max);
      if (!clamped.equals(t)) {
        camera.position.add(clamped.clone().sub(t));
        t.copy(clamped);
      }
    });

    // Glides between poses when a frame is added or removed; instant the
    // first time. Orbit limits and the pan leash switch once the move lands.
    let glide = 0;
    function frameView(name, instant, duration = 700) {
      const pose = poses[name];
      const fromPos = camera.position.clone();
      const fromTarget = controls.target.clone();
      const land = () => {
        [controls.minPolarAngle, controls.maxPolarAngle] = pose.polar;
        leash.centre.copy(pose.target);
        leash.reach.copy(pose.reach);
        controls.minDistance = minDistance;
        controls.enabled = active === 'room';
        dirty = true;
      };
      cancelAnimationFrame(glide);
      if (instant) {
        camera.position.copy(pose.position);
        controls.target.copy(pose.target);
        camera.lookAt(pose.target);
        land();
        return;
      }
      controls.enabled = false;
      controls.minPolarAngle = 0;
      controls.maxPolarAngle = Math.PI;
      leash.reach.setScalar(Infinity);
      controls.minDistance = 0;
      const start = performance.now();
      const step = (now) => {
        const t = Math.min((now - start) / duration, 1);
        const k = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        camera.position.lerpVectors(fromPos, pose.position, k);
        controls.target.lerpVectors(fromTarget, pose.target, k);
        camera.lookAt(controls.target);
        dirty = true;
        if (t < 1) glide = requestAnimationFrame(step);
        else land();
      };
      glide = requestAnimationFrame(step);
    }
    return { scene, camera, controls, aoPerDistance: 0.004, hang };
  }

  function render(msg, gltf) {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.toneMappingExposure = 1.1;
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

    // Soft image-based light for fill and reflections, shared by both views.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new RoomEnvironment();
    const env = pmrem.fromScene(envScene, 0.04).texture;
    envScene.dispose();
    pmrem.dispose();
    disposables.push(env);

    views.model = modelView(msg, material, env);
    if (room?.bareMm) {
      views.room = roomView(msg, material, env);
      views.room.hang(gltf ? room.colour : null);
    }
    // Ambient occlusion darkens the ground at each building's foot, so the
    // buildings stay distinct from the streets even when seen head-on, where
    // tops and ground otherwise catch identical light. Its reach follows the
    // viewing distance (aoPerDistance), so it stays a tight edge shade at any
    // zoom instead of smearing into blotches up close.
    for (const v of Object.values(views)) {
      v.composer = new EffectComposer(renderer);
      v.composer.addPass(new RenderPass(v.scene, v.camera));
      const ao = new GTAOPass(v.scene, v.camera, 1, 1);
      // The sculpture's faces aren't consistently wound (it renders
      // double-sided), so the AO depth/normal prepass must draw both sides
      // too. Front-only, it drops inward-wound walls and shades buildings
      // with the depth of whatever stands behind them, which reads as the
      // buildings being see-through.
      ao.normalMaterial.side = THREE.DoubleSide;
      ao.updateGtaoMaterial({ distanceFallOff: 1, samples: 16 });
      ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
      ao.blendIntensity = 1;
      v.ao = ao;
      v.aoRadius = -1;
      v.composer.addPass(ao);
      v.composer.addPass(new OutputPass());
      disposables.push(v.composer, ao);
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
        v.composer.setPixelRatio(renderer.getPixelRatio());
        v.composer.setSize(w, h);
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
        const r = v.camera.position.distanceTo(v.controls.target) * v.aoPerDistance;
        if (Math.abs(r - v.aoRadius) > v.aoRadius * 0.02) {
          v.ao.updateGtaoMaterial({ radius: r, thickness: r });
          v.aoRadius = r;
        }
        v.composer.render();
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

  const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Switches to the room under a fading still of the view being left, so
  // the change of scene, light and background dissolves instead of cutting.
  function enterFrom(from) {
    from.composer.render();
    const still = document.createElement('canvas');
    still.width = renderer.domElement.width;
    still.height = renderer.domElement.height;
    still.getContext('2d').drawImage(renderer.domElement, 0, 0);
    Object.assign(still.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' });
    container.appendChild(still);
    setView('room');
    still.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 450, easing: 'ease-out', fill: 'forwards' })
      .finished.finally(() => still.remove());
  }

  return {
    setView,
    // Resolves to the colour actually hung (null if unframed or it failed).
    // Picking a frame from the close-up carries the view into the room.
    async setFrame(colour) {
      if (!views.room) return null;
      const from = colour && active === 'model' ? views.model : null;
      const hung = await views.room.hang(colour || null, from);
      if (from && hung && active !== 'room') setView('room');
      return hung;
    },
    get view() { return active; },
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
