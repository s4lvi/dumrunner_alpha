// Minimal column-major 4×4 matrix used by the camera. We don't
// pull a math library — the v2 renderer only ever needs to build
// a view*projection matrix once per frame and bind it as a
// shader uniform. The Float32Array exposed by `.m` is what gets
// uploaded; PixiJS uniform groups copy from it directly.

export class Matrix4 {
  readonly m = new Float32Array(16);

  constructor() {
    // Identity-initialize so a Matrix4 that's never been built()
    // doesn't render garbage in tests / debug paths.
    this.m[0] = 1;
    this.m[5] = 1;
    this.m[10] = 1;
    this.m[15] = 1;
  }
}
