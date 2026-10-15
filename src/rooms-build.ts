/**
 * Rooms' geometry and shaders: the grid frame, and for each room the parts
 * of its frame stack that Frame stack's own materials (`stack-materials.ts`) don't cover: the
 * sharp frame (the clip itself, travelling through the stack).
 * Everything that moves is driven by uniforms the system writes from the song clock.
 *
 * Same conventions as sorang-materials.ts: three compiles these as GLSL ES 3.00 with its
 * WebGL1-style defines, and every fragment shader ends in `colorspace_fragment` so its twin
 * (the copy drawn into the linear bloom targets) converts correctly.
 */
import {
  AdditiveBlending,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  NormalBlending,
  ShaderMaterial,
  Vector2,
  type Texture,
} from '@iwsdk/core';
import { CELLS, FLOOR, SLAB, WALL } from './rooms-layout.js';
import { FEATHER } from './stack-materials.js';

/** Uniform objects shared by reference across Rooms' materials. */
export function createRoomsUniforms() {
  return {
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

// ---------------------------------------------------------------- stacks

/** Per room: what the sharp frame reads besides the stack's own uniforms. */
export interface FrameUniforms {
  uVideo: { value: Texture };
  /** Presence × focus × occluder fade: the sharp frame's opacity. */
  uBright: { value: number };
  /** Lit like Frame stack's current frame: 0 flat, 1 glowing. */
  uGlow: { value: number };
  /** Shared with the stack: how soft the frame's edges are. */
  uFeather: { value: number };
}

/**
 * The sharp frame: the clip itself at full resolution, lit and feathered like Frame stack's
 * current frame, drawn with premultiplied alpha over the ghost layers behind it.
 */
export function currentFrameMaterial(u: FrameUniforms): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uVideo: u.uVideo, uBright: u.uBright, uGlow: u.uGlow, uFeather: u.uFeather },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uVideo;
      uniform float uBright;
      uniform float uGlow;
      uniform float uFeather;
      varying vec2 vUv;
      ${FEATHER}
      void main() {
        vec3 rgb = texture(uVideo, vUv).rgb;
        float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
        // Gentler than Frame stack's: a bright clip (a sky, a lit carriage) must not burn out face on.
        vec3 lit = rgb * (1.0 + uGlow * 0.25) + rgb * smoothstep(0.5, 0.9, luma) * (uGlow * 0.25);
        float a = edgeFeather(vUv, uFeather) * uBright;
        if (a < 0.003) discard;
        gl_FragColor = vec4(lit, a);
        #include <colorspace_fragment>
        gl_FragColor.rgb *= gl_FragColor.a;
      }`,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: NormalBlending,
    premultipliedAlpha: true,
  });
}

// ---------------------------------------------------------------- frame

/** The grid floor and its slab, and the two grid walls. */
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
