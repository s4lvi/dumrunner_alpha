// Camera math for the v2 sector renderer. Owns the
// view * projection matrix that turns world-space (x_w, y_w, z_w)
// positions into NDC clip-space coordinates for the vertex
// shader.
//
// Coordinate system (matches v1):
//   World X — east (positive screen-right when looking north)
//   World Y — south (positive screen-forward when yaw=0)
//   World Z — up; floor=0, ceiling=WALL_HEIGHT_WORLD * biomeHeight
//
// Yaw and pitch use the same conventions and sensitivity as the
// v1 raycaster so the existing input plumbing (mouse, touch
// joystick, applyLookDelta) keeps working without translation.
//   yaw=0     → looking along +Y
//   yaw=+PI/2 → looking along -X (right turn)
//   pitch>0   → looking up
//
// Pitch is a real rotation here, not the v1 horizon-shift hack —
// vertical look will feel cleaner once Phase 2 lays geometry.
// We keep the v1 PITCH_LIMIT clamp so the camera never gimbal-
// locks; that's enough for FPS gameplay.

import { Matrix4 } from './matrix4';

export const POINTER_SENSITIVITY = 0.0025;
export const PITCH_LIMIT = 1.2;

// Vertical FOV in radians. ~75° matches v1's effective FOV after
// the raycaster's plane scaling (we don't store v1's exact value
// because v1 uses a 2D plane vector instead of a vFOV scalar).
const V_FOV = Math.PI * (75 / 180);
// Far plane: max ray distance the renderer cares about. Anything
// beyond drops into fog colour.
const Z_NEAR = 4;
const Z_FAR = 4000;

// Eye height above floor. Half a wall, mirroring v1's
// (WALL_HEIGHT_WORLD = 32; camHeight = 16). Eye sits in the
// middle of the room so the player sees walls above AND floor
// below at pitch=0. Sector floor heights move the eye with the
// floor, so this is relative to the player's current sector's
// floorZ.
export const EYE_HEIGHT = 16;
// Crouch eye height. Drop ~6 wu (1/5 of a wall) — enough to
// drag the silhouette below head-height shots without making
// the world feel tiny.
export const EYE_HEIGHT_CROUCH = 10;

export class Camera {
  yaw = 0;
  pitch = 0;
  selfX = 0;
  selfY = 0;
  floorZ = 0;
  // Phase 7 vertical-movement state. jumpZ rides above floorZ;
  // crouching swaps eye height to the crouch value. Renderer
  // writes these every frame from the server-broadcast values.
  jumpZ = 0;
  crouching = false;
  // Smoothed eye height for the crouch lerp — snaps when not
  // animating, lerps when crouching state changes.
  eyeHeightSmoothed = EYE_HEIGHT;
  // Aspect ratio is set per frame from the canvas size.
  aspect = 1;

  // Output: 4x4 view * projection matrix in column-major order
  // (GL convention). Re-computed every frame in build(), bound
  // to the shader as a single mat4 uniform.
  readonly viewProj = new Matrix4();

  // Forward + right unit vectors in world space, computed in
  // build(). Used by the sprite layer to build billboard quads
  // facing the camera. Z components are zero — billboards stand
  // vertically regardless of pitch.
  fwdX = 0;
  fwdY = 1;
  rightX = 1;
  rightY = 0;

  applyLookDelta(dxPx: number, dyPx: number): void {
    this.yaw = (this.yaw + dxPx * POINTER_SENSITIVITY) % (Math.PI * 2);
    this.pitch = Math.max(
      -PITCH_LIMIT,
      Math.min(PITCH_LIMIT, this.pitch - dyPx * POINTER_SENSITIVITY),
    );
  }

  setSelfPosition(x: number, y: number, floorZ: number): void {
    this.selfX = x;
    this.selfY = y;
    this.floorZ = floorZ;
  }

  setVertical(jumpZ: number, crouching: boolean): void {
    this.jumpZ = jumpZ;
    this.crouching = crouching;
  }

  // Rebuild the matrix from current state. Cheap (~30 mul); call
  // every frame.
  build(viewportW: number, viewportH: number): void {
    this.aspect = viewportW / Math.max(1, viewportH);
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);
    this.fwdX = cy;
    this.fwdY = sy;
    // World is y-down (screen +Y goes south). Right = up × forward
    // gives the correct screen-right vector: at yaw=0 with forward
    // (+X), right is (0, +1, 0) — south of the player, which is
    // "right" when their head points north. Matches v1's
    // (-sin(yaw), cos(yaw)) plane vector.
    this.rightX = -sy;
    this.rightY = cy;

    // View matrix: translate world so camera sits at origin,
    // then rotate yaw around Z, then rotate pitch around the
    // camera's right axis.
    // Lerp eye height toward the standing / crouching target so
    // crouch transitions read as a smooth bob rather than a snap.
    // 120 ms time constant matches the v2 plan; jumpZ rides on
    // top (the server reports it, so no smoothing needed here).
    const eyeTarget = this.crouching ? EYE_HEIGHT_CROUCH : EYE_HEIGHT;
    this.eyeHeightSmoothed += (eyeTarget - this.eyeHeightSmoothed) * 0.18;
    if (Math.abs(eyeTarget - this.eyeHeightSmoothed) < 0.05) {
      this.eyeHeightSmoothed = eyeTarget;
    }
    const eyeZ = this.floorZ + this.eyeHeightSmoothed + this.jumpZ;
    // Compose in column-major order. Conceptually:
    //   view = R_pitch * R_yaw * T(-eye)
    // R_yaw rotates world so that looking +Y is straight ahead;
    // R_pitch tilts the view up / down around the right axis.
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);

    // Combined view rotation columns. After R_pitch * R_yaw:
    //   row 0 = right axis      = ( cy,  sy,  0 )   actually ( sy, -cy, 0 )
    //   row 1 = up axis (tilted) = ( -sp*sy, sp*cy, cp )
    //   row 2 = forward (into screen, negated for GL) = ( cp*sy*?, ... )
    //
    // Rebuilt from first principles below so the sign discipline
    // matches the shader's gl_Position convention (OpenGL: camera
    // looks down -Z in view space).
    //
    // World axes (y-down screen convention):
    //   forward = ( cy,  sy, 0 )
    //   right   = (-sy,  cy, 0 )    // up × forward
    //   worldUp = ( 0,   0,  1 )
    //
    // View space (right, up, -forward):
    //   x_v = right · (p - eye)
    //   y_v = up_tilted · (p - eye)
    //   z_v = -forward_tilted · (p - eye)
    //
    // Tilt forward + up by pitch about the right axis:
    //   forward_tilted = cos(p) * forward + sin(p) * worldUp
    //   up_tilted      = -sin(p) * forward + cos(p) * worldUp
    //
    // Expanded:
    //   forward_tilted = ( cp*cy, cp*sy, sp )
    //   up_tilted      = ( -sp*cy, -sp*sy, cp )
    //   right          = ( -sy,    cy,    0  )
    //
    // The view matrix is then:
    //   V = | right_x   right_y   right_z   -right·eye   |
    //       | up_x      up_y      up_z      -up·eye      |
    //       | -fwd_x    -fwd_y    -fwd_z    fwd·eye      |
    //       |  0         0         0         1            |
    //
    // Stored column-major (GL): m[0..3] is the first column.
    const rX = -sy,    rY = cy,    rZ = 0;
    const uX = -sp * cy, uY = -sp * sy, uZ = cp;
    const fX = cp * cy,  fY = cp * sy,  fZ = sp;
    const eyeX = this.selfX;
    const eyeYw = this.selfY;
    const tx = -(rX * eyeX + rY * eyeYw + rZ * eyeZ);
    const ty = -(uX * eyeX + uY * eyeYw + uZ * eyeZ);
    const tz = fX * eyeX + fY * eyeYw + fZ * eyeZ;

    // Perspective projection (GL, right-handed, looking down -Z):
    //   P = | f/aspect  0   0                              0                          |
    //       |   0       f   0                              0                          |
    //       |   0       0   (zFar+zNear)/(zNear-zFar)      (2*zFar*zNear)/(zNear-zFar)|
    //       |   0       0   -1                             0                          |
    // where f = 1 / tan(vfov/2).
    const f = 1 / Math.tan(V_FOV / 2);
    const nf = 1 / (Z_NEAR - Z_FAR);
    const pA = f / this.aspect;
    const pB = f;
    const pC = (Z_FAR + Z_NEAR) * nf;
    const pD = 2 * Z_FAR * Z_NEAR * nf;

    // Combined VP = P * V, column-major (GL).
    //
    // Derivation:
    //   PV[row 0] = pA * V[row 0]                  (right row)
    //   PV[row 1] = pB * V[row 1]                  (up row)
    //   PV[row 2] = pC * V[row 2] + pD * V[row 3]  (-forward row + projection translation)
    //   PV[row 3] = -1 * V[row 2]                  (perspective divide picks up -z_view as w)
    //
    // V[row 2] = (-fX, -fY, -fZ, tz)   where tz = fwd·eye
    // V[row 3] = (0, 0, 0, 1)
    //
    // So:
    //   PV[2][col] = pC * V[2][col]  for col 0..2,  pC*tz + pD  for col 3.
    //   PV[3][col] = -V[2][col]      → ( fX, fY, fZ, -tz ).
    //
    // The w-row sign discipline is what makes w_clip = +(fwd·(p-eye)) >0
    // for points in front of the camera; an inverted sign clips
    // every fragment and the screen goes black.
    const m = this.viewProj.m;
    // Column 0 (acts on world x_w):
    m[0]  = pA * rX;
    m[1]  = pB * uX;
    m[2]  = pC * -fX;
    m[3]  = fX;
    // Column 1 (world y_w):
    m[4]  = pA * rY;
    m[5]  = pB * uY;
    m[6]  = pC * -fY;
    m[7]  = fY;
    // Column 2 (world z_w):
    m[8]  = pA * rZ;
    m[9]  = pB * uZ;
    m[10] = pC * -fZ;
    m[11] = fZ;
    // Column 3 (translation):
    m[12] = pA * tx;
    m[13] = pB * ty;
    m[14] = pC * tz + pD;
    m[15] = -tz;
  }
}
