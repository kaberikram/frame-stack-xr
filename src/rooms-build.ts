/**
 * Rooms' geometry and shaders: the glass boxes (a video room inside a frosted shell with bright
 * edges) and the grid frame with its vault arch.
 * Everything that moves is driven by uniforms the system writes from the song clock.
 *
 * Same conventions as sorang-materials.ts: three compiles these as GLSL ES 3.00 with its
 * WebGL1-style defines, and every fragment shader ends in `colorspace_fragment` so its twin
 * (the copy drawn into the linear bloom targets) converts correctly.
 */
import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  BufferGeometry,
  EdgesGeometry,
  Float32BufferAttribute,
  FrontSide,
  NoBlending,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  type Texture,
} from '@iwsdk/core';
import { CELLS, FLOOR, SLAB, WALL, boxHeight, type BoxSpec } from './rooms-layout.js';

/** Uniform objects shared by reference across Rooms' materials. */
export function createRoomsUniforms() {
  return {
    /** Song seconds: everything that drifts reads it, so a frozen moment always looks the same. */
    uSong: { value: 0 },
    uKick: { value: 0 },
    uEnergy: { value: 0 },
    /** Seconds since the latest beat, and how hard the floor ring pulses from it. */
    uBeatAge: { value: 1 },
    uRing: { value: 0 },
    uFrameShow: { value: 0 },
    /** A band of light rising up the walls: height (metres), strength. */
    uScan: { value: new Vector2(-10, 0) },
    /** The drawing buffer's height, px: the bloom swaps in its own while it draws. */
    uViewportH: { value: 1000 },
    /** 0..1 flare on a cut. */
    uFlash: { value: 0 },
  };
}
export type RoomsUniforms = ReturnType<typeof createRoomsUniforms>;

const NOISE = /* glsl */ `
  float hash3(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float vnoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }
  float fbm(vec3 p) {
    float a = 0.5;
    float s = 0.0;
    for (int i = 0; i < 4; i++) {
      s += a * vnoise(p);
      p = p * 2.03 + vec3(1.7, 9.2, 3.1);
      a *= 0.5;
    }
    return s;
  }`;

// ---------------------------------------------------------------- boxes

export interface BoxUniforms {
  uSong: { value: number };
  uKick: { value: number };
  uVideo: { value: Texture };
  /** Cover fit: uv scale (xy) and offset (zw), so a clip of any shape fills the back wall. */
  uCover: { value: Vector4 };
  /** 1 once a real clip plays; 0 shows the test card's sweep. */
  uLive: { value: number };
  uSize: { value: Vector3 };
  uTint: { value: Vector3 };
  /** Presence × focus × occluder fade. */
  uBright: { value: number };
  uGlass: { value: number };
  uHaze: { value: number };
  uEdge: { value: number };
}

export function createBoxUniforms(U: RoomsUniforms, box: BoxSpec, video: Texture): BoxUniforms {
  return {
    uSong: U.uSong,
    uKick: U.uKick,
    uVideo: { value: video },
    uCover: { value: new Vector4(1, 1, 0, 0) },
    uLive: { value: 0 },
    uSize: { value: new Vector3(box.w, boxHeight(box), box.d) },
    uTint: { value: new Vector3(box.tint[0], box.tint[1], box.tint[2]) },
    uBright: { value: 0 },
    uGlass: { value: 0.6 },
    uHaze: { value: 1 },
    uEdge: { value: 0 },
  };
}

/** A box's size, for its interior, shell and edges. The shell sits a hair outside the room. */
export function boxGeometry(box: BoxSpec, grow = 1): BoxGeometry {
  return new BoxGeometry(box.w * grow, boxHeight(box) * grow, box.d * grow);
}

/**
 * The room inside a box, seen through its open glass: the clip on the back wall, a soft
 * reflection of it on the floor and ceiling, and its outer columns streaked along the side walls.
 * Drawn from inside (back faces), so the near walls never cover the room. `glowGain` scales it in
 * the bloom twin, so only the brightest parts of a clip glow.
 */
export function interiorMaterial(u: BoxUniforms, glowGain = 1): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { ...u, uGlowGain: { value: glowGain } },
    vertexShader: /* glsl */ `
      varying vec3 vLocal;
      varying vec3 vN;
      void main() {
        vLocal = position;
        vN = normal;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uVideo;
      uniform vec4 uCover;
      uniform float uLive;
      uniform vec3 uSize;
      uniform vec3 uTint;
      uniform float uBright;
      uniform float uGlowGain;
      uniform float uSong;
      varying vec3 vLocal;
      varying vec3 vN;
      vec3 clip(vec2 uv) { return texture(uVideo, clamp(uv, 0.002, 0.998) * uCover.xy + uCover.zw).rgb; }
      vec3 soft(vec2 uv, float r) {
        return 0.2 * (clip(uv) + clip(uv + vec2(r, 0.0)) + clip(uv - vec2(r, 0.0)) + clip(uv + vec2(0.0, r)) + clip(uv - vec2(0.0, r)));
      }
      void main() {
        vec3 h = 0.5 * uSize;
        // From the back wall toward the open front, metres.
        float dz = vLocal.z + h.z;
        float depth01 = dz / uSize.z;
        vec3 col;
        if (vN.z > 0.5) {
          // The front, seen only from inside the box.
          col = uTint * 0.02;
        } else if (vN.z < -0.5) {
          vec2 uv = vLocal.xy / uSize.xy + 0.5;
          col = clip(uv);
          // A test card: a slow bright sweep, so it reads as a placeholder at a glance.
          if (uLive < 0.5) col *= 0.8 + 0.4 * smoothstep(0.96, 1.0, fract(uv.y - uSong * 0.18));
        } else if (vN.y < -0.5) {
          vec2 uv = vec2(vLocal.x / uSize.x + 0.5, dz / uSize.y);
          col = soft(uv, 0.015 + 0.04 * depth01) * 0.33 * exp(-2.4 * depth01) + uTint * 0.025;
        } else if (vN.y > 0.5) {
          vec2 uv = vec2(vLocal.x / uSize.x + 0.5, 1.0 - dz / uSize.y);
          col = soft(uv, 0.04) * 0.16 * exp(-3.0 * depth01) + uTint * 0.02;
        } else {
          // Side walls: the clip's outer column, drawn out toward the front like light spilling.
          float edge = vN.x > 0.0 ? 0.995 : 0.005;
          vec2 uv = vec2(edge, vLocal.y / uSize.y + 0.5);
          col = soft(uv, 0.01) * 0.3 * exp(-1.6 * depth01) + uTint * 0.025;
        }
        gl_FragColor = vec4(col * uBright * uGlowGain, 1.0);
        #include <colorspace_fragment>
      }`,
    side: BackSide,
    blending: NoBlending,
    depthWrite: true,
    depthTest: true,
    // Behind the edge lines that run along its corners.
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
}

/** The frosted glass: bright at grazing angles, misty toward the top, nearly clear head on. */
export function glassMaterial(u: BoxUniforms): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: u as unknown as Record<string, { value: unknown }>,
    vertexShader: /* glsl */ `
      varying vec3 vLocal;
      varying vec3 vWorldN;
      varying vec3 vView;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vLocal = position;
        vWorldN = normalize(mat3(modelMatrix) * normal);
        vView = cameraPosition - wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      ${NOISE}
      uniform vec3 uSize;
      uniform vec3 uTint;
      uniform float uBright;
      uniform float uGlass;
      uniform float uHaze;
      uniform float uSong;
      uniform float uKick;
      varying vec3 vLocal;
      varying vec3 vWorldN;
      varying vec3 vView;
      void main() {
        float ndv = abs(dot(normalize(vWorldN), normalize(vView)));
        float graze = max(1.0 - ndv, 0.0);
        float fres = graze * graze * graze;
        vec3 q = vLocal / uSize + 0.5;
        float top = smoothstep(0.1, 1.0, q.y);
        float mist = fbm(vec3(vLocal.xy * 2.2, vLocal.z * 2.2 + uSong * 0.08));
        float haze = (0.025 + 0.09 * top * mist) * uHaze;
        vec3 col = uTint * (0.45 * fres + haze) * uGlass * (1.0 + 0.6 * uKick);
        gl_FragColor = vec4(col * uBright, 1.0);
        #include <colorspace_fragment>
      }`,
    side: FrontSide,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: true,
  });
}

/** The box's twelve edges, white with a little of its tint. */
export function edgeGeometry(box: BoxSpec): EdgesGeometry {
  const solid = boxGeometry(box, 1.004);
  const edges = new EdgesGeometry(solid);
  solid.dispose();
  return edges;
}

export function edgeMaterial(u: BoxUniforms): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: u as unknown as Record<string, { value: unknown }>,
    vertexShader: /* glsl */ `
      void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uTint;
      uniform float uEdge;
      void main() {
        gl_FragColor = vec4(mix(vec3(1.0), uTint, 0.35) * uEdge, 1.0);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: true,
  });
}

// ---------------------------------------------------------------- frame

/** The grid floor and its slab, the two grid walls, the vault arch over them and its chord. */
export function frameGeometry(): BufferGeometry {
  const pos: number[] = [];
  const weight: number[] = [];
  const line = (a: readonly number[], b: readonly number[], w: number) => {
    pos.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    weight.push(w, w);
  };
  const h = FLOOR / 2;
  const cell = FLOOR / CELLS;
  const rows = Math.round(WALL / cell);
  for (let i = 0; i <= CELLS; i++) {
    const c = -h + i * cell;
    const edge = i === 0 || i === CELLS;
    // Floor, both ways.
    line([c, 0, -h], [c, 0, h], edge ? 1 : 0.35);
    line([-h, 0, c], [h, 0, c], edge ? 1 : 0.35);
    // The left wall (x = -h) and the right wall (z = -h): verticals.
    line([-h, 0, c], [-h, WALL, c], i === CELLS ? 1 : 0.3);
    line([c, 0, -h], [c, WALL, -h], i === CELLS ? 1 : 0.3);
  }
  for (let j = 1; j <= rows; j++) {
    const y = Math.min(WALL, j * cell);
    const top = j === rows;
    line([-h, y, -h], [-h, y, h], top ? 1 : 0.3);
    line([-h, y, -h], [h, y, -h], top ? 1 : 0.3);
  }
  // The slab under the floor: its two front edges and three visible corners.
  line([h, -SLAB, -h], [h, -SLAB, h], 0.8);
  line([-h, -SLAB, h], [h, -SLAB, h], 0.8);
  line([h, 0, h], [h, -SLAB, h], 0.8);
  line([-h, 0, h], [-h, -SLAB, h], 0.8);
  line([h, 0, -h], [h, -SLAB, -h], 0.8);
  // The vault: a half circle on the diagonal from the left wall's front top to the right wall's.
  const r = h * Math.SQRT2;
  const steps = 72;
  const R2 = Math.SQRT1_2;
  const arch = (t: number) => [-Math.cos(t) * r * R2, WALL + Math.sin(t) * r, Math.cos(t) * r * R2];
  for (let i = 0; i < steps; i++) line(arch((i / steps) * Math.PI), arch(((i + 1) / steps) * Math.PI), 0.85);
  line([-h, WALL, h], [h, WALL, -h], 0.6);
  line([0, WALL, 0], [0, WALL + r, 0], 0.25);
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('aW', new Float32BufferAttribute(weight, 1));
  return geo;
}

export function frameMaterial(U: RoomsUniforms): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: U,
    vertexShader: /* glsl */ `
      attribute float aW;
      varying vec3 vP;
      varying float vW;
      void main() {
        vP = position;
        vW = aW;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uFrameShow;
      uniform float uEnergy;
      uniform vec2 uScan;
      uniform float uBeatAge;
      uniform float uRing;
      uniform float uFlash;
      varying vec3 vP;
      varying float vW;
      void main() {
        float g = vW * (0.5 + 0.2 * uEnergy);
        // A band of light climbing the walls through each bar.
        // Squared by hand: pow() of a negative base is undefined.
        float db = (vP.y - uScan.x) / 0.35;
        float band = exp(-db * db) * step(0.01, vP.y);
        // A ring running out across the floor from the centre on the beat.
        float dr = (length(vP.xz) - uBeatAge * 9.0) / 0.45;
        float ring = exp(-dr * dr) * step(vP.y, 0.01) * step(-0.01, vP.y);
        g += uScan.y * band * 0.9 + uRing * ring * 0.8;
        g *= 1.0 + 0.8 * uFlash;
        gl_FragColor = vec4(vec3(0.86, 0.89, 1.0) * g * uFrameShow, 1.0);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: true,
  });
}
