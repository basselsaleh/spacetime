// Per-pixel camera rays for full-screen ray-marching / ray-tracing shaders.

import * as THREE from "three";

/**
 * Maps (ndc.x, ndc.y, 1) to the world direction of the ray through that point
 * of a perspective camera's view: in GLSL, `normalize(u_rayBasis * vec3(ndc, 1.0))`
 * with `ndc = gl_FragCoord.xy / u_resolution * 2.0 - 1.0`.
 *
 * Built from the camera's basis and field of view, not by unprojecting with the
 * inverse view-projection matrix: in float32 that loses ~1e-2 rad when the near
 * plane is close to the camera and the camera is far from the origin.
 */
export function rayMatrix(camera: THREE.PerspectiveCamera): THREE.Matrix3 {
  camera.updateMatrixWorld();
  const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).multiplyScalar(tanY * camera.aspect);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).multiplyScalar(tanY);
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  return new THREE.Matrix3().set(right.x, up.x, forward.x, right.y, up.y, forward.y, right.z, up.z, forward.z);
}
