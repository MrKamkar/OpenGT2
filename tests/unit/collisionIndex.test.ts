import { describe, expect, it } from 'vitest';
import {
  buildCollisionMesh,
  parseTro,
  raycastCollisionMesh,
} from '../../src/formats/track';
import { CollisionIndex } from '../../src/physics/collisionIndex';
import { quatFromAxisAngle, quatIdentity } from '../../src/physics/math';
import { buildSyntheticTro, type SyntheticSegmentSpec } from '../fixtures/buildTro';

function buildMultiSegmentTestMesh() {
  const segments: SyntheticSegmentSpec[] = [];
  // 5x5 grid of 10 m x 10 m segments (640 raw units = 10 m) with slight slope and subBlock98 barriers
  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 5; col += 1) {
      const x0 = col * 640;
      const x1 = (col + 1) * 640;
      const y0 = row * 640;
      const y1 = (row + 1) * 640;
      const z0 = col * 32; // gradual climb in +X
      const z1 = (col + 1) * 32;

      segments.push({
        centerRaw: [x0 + 320, y0 + 320, Math.round((z0 + z1) * 0.5)],
        subMesh0: {
          localVertices: [
            [x0, y0, z0],
            [x0, y1, z0],
            [x1, y1, z1],
            [x1, y0, z1],
          ],
          polygons: [{ listIndex: 2, vertices: [0, 1, 2, 3], colors: [{ r: 120, g: 120, b: 120 }] }],
        },
        subMesh1: { localVertices: [], polygons: [] },
        walls2D:
          row === 0
            ? [{ v0: 0, v1: 3, nxFixed12: 0, nyFixed12: 4096 }]
            : [],
      });
    }
  }

  return buildCollisionMesh(parseTro(buildSyntheticTro({ uvEntries: [], segments })));
}

describe('CollisionIndex spatial acceleration & wall collisions (M9.2)', () => {
  it('matches brute-force raycastCollisionMesh identically across 100+ rays while pruning triangles', () => {
    const mesh = buildMultiSegmentTestMesh();
    const index = new CollisionIndex(mesh, { cellSizeMeters: 8 });

    let hitCount = 0;
    let totalTested = 0;
    for (let i = 0; i < 120; i += 1) {
      const ox = ((i * 17) % 52) - 1 + 0.13;
      const oz = -((i * 23) % 52) + 1 - 0.17;
      const origin = { x: ox, y: 15, z: oz };
      const dir = { x: 0.05 * ((i % 3) - 1), y: -1, z: -0.05 * (((i + 1) % 3) - 1) };

      const brute = raycastCollisionMesh(mesh, origin, dir, 50, { surfaceFilter: ['ground'] });
      const fast = index.raycastWheelDown(origin, dir, 50);
      totalTested += index.trianglesTestedLastQuery;

      if (brute === null) {
        expect(fast).toBeNull();
      } else {
        hitCount += 1;
        expect(fast).not.toBeNull();
        expect(fast!.distance).toBeCloseTo(brute.distance, 6);
        expect(fast!.triangleIndex).toBe(brute.triangleIndex);
        expect(fast!.segmentIndex).toBe(brute.segmentIndex);
        expect(fast!.point.x).toBeCloseTo(brute.point.x, 5);
        expect(fast!.point.y).toBeCloseTo(brute.point.y, 5);
        expect(fast!.point.z).toBeCloseTo(brute.point.z, 5);
        expect(fast!.normal).toEqual(brute.normal);
        expect(fast!.surfaceType).toBe('asphalt');
      }
    }

    expect(hitCount).toBeGreaterThan(80);
    // Average triangles tested per ray must be well below total triangle count (50)
    expect(totalTested / 120).toBeLessThan(12);
  });

  it('filters subBlock98 2D barriers vertically so bridges/overpasses never collide across decks', () => {
    // Stacked two-deck mesh: lower deck at y=0 m with barrier at z=0 (+Z inward normal),
    // upper deck at y=12 m with barrier at z=-10 (-Z? No, +Z inward at z=-10 -> let's place upper barrier at z=-4).
    const tro = parseTro(
      buildSyntheticTro({
        uvEntries: [],
        segments: [
          {
            // Lower deck at raw Z=0 (0 m)
            centerRaw: [320, 320, 0],
            subMesh0: {
              localVertices: [
                [0, 0, 0],
                [0, 640, 0],
                [640, 640, 0],
                [640, 0, 0],
              ],
              polygons: [{ listIndex: 2, vertices: [0, 1, 2, 3], colors: [{ r: 100, g: 100, b: 100 }] }],
            },
            subMesh1: { localVertices: [], polygons: [] },
            // Wall along raw Y=0 (engine Z=0), inward normal raw +Y -> engine -Z
            walls2D: [{ v0: 0, v1: 3, nxFixed12: 0, nyFixed12: 4096 }],
          },
          {
            // Upper deck at raw Z=768 (12 m), wall along raw Y=320 (engine Z=-5)
            centerRaw: [320, 320, 768],
            subMesh0: {
              localVertices: [
                [0, 320, 768],
                [0, 640, 768],
                [640, 640, 768],
                [640, 320, 768],
              ],
              polygons: [{ listIndex: 2, vertices: [0, 1, 2, 3], colors: [{ r: 150, g: 150, b: 150 }] }],
            },
            subMesh1: { localVertices: [], polygons: [] },
            walls2D: [{ v0: 0, v1: 3, nxFixed12: 0, nyFixed12: 4096 }],
          },
        ],
      }),
    );

    const index = new CollisionIndex(buildCollisionMesh(tro));

    // Car on lower deck (y=0.6 m) crossing z=-5 must NOT hit the upper deck's barrier at y=12 m
    const lowerAtUpperZ = index.resolveChassisWallCollisions({
      position: { x: 5, y: 0.6, z: -4.8 },
      orientation: quatIdentity(),
      linearVelocity: { x: 0, y: 0, z: -10 },
      angularVelocity: { x: 0, y: 0, z: 0 },
      halfExtents: { x: 0.9, y: 0.6, z: 2.0 },
      massKg: 1200,
      inertiaY: 1800,
    });
    expect(lowerAtUpperZ.collided).toBe(false);

    // Car on upper deck (y=12.6 m) penetrating upper barrier at z=-5 DOES collide
    const upperAtUpperZ = index.resolveChassisWallCollisions({
      position: { x: 5, y: 12.6, z: -3.5 },
      orientation: quatIdentity(),
      linearVelocity: { x: 0, y: 0, z: 8 },
      angularVelocity: { x: 0, y: 0, z: 0 },
      halfExtents: { x: 0.9, y: 0.6, z: 2.0 },
      massKg: 1200,
      inertiaY: 1800,
    });
    expect(upperAtUpperZ.collided).toBe(true);
    expect(upperAtUpperZ.positionCorrection.z).toBeLessThan(0);
    expect(upperAtUpperZ.linearVelocityDelta.z).toBeLessThan(0);
  });

  it('pushes angled chassis out of barrier and produces smooth sliding impulse without NaN', () => {
    const mesh = buildMultiSegmentTestMesh();
    const index = new CollisionIndex(mesh);

    // Wall at z=0 with inward normal (0, 0, -1). Car angled 30 deg approaching wall at +Z.
    const res = index.resolveChassisWallCollisions({
      position: { x: 10, y: 0.6, z: -1.4 },
      orientation: quatFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 6),
      linearVelocity: { x: 12, y: 0, z: 6 },
      angularVelocity: { x: 0, y: 0, z: 0 },
      halfExtents: { x: 0.9, y: 0.6, z: 2.0 },
      massKg: 1250,
      inertiaY: 2100,
    });

    expect(res.collided).toBe(true);
    expect(res.positionCorrection.z).toBeLessThan(0);
    expect(res.linearVelocityDelta.z).toBeLessThan(-6); // reverses inward Z component via restitution
    expect(Number.isFinite(res.angularVelocityDelta.y)).toBe(true);
    // Sliding velocity along X remains positive
    expect(12 + res.linearVelocityDelta.x).toBeGreaterThan(8);
  });

  it('handles dense grids efficiently with bounded query work', () => {
    // 2,000 triangles across a 400 m track
    const segments: SyntheticSegmentSpec[] = [];
    for (let i = 0; i < 1000; i += 1) {
      const y0 = i * 25;
      const y1 = (i + 1) * 25;
      segments.push({
        centerRaw: [320, y0 + 12, 0],
        subMesh0: {
          localVertices: [
            [0, y0, 0],
            [0, y1, 0],
            [640, y1, 0],
            [640, y0, 0],
          ],
          polygons: [{ listIndex: 2, vertices: [0, 1, 2, 3], colors: [{ r: 90, g: 90, b: 90 }] }],
        },
        subMesh1: { localVertices: [], polygons: [] },
      });
    }
    const mesh = buildCollisionMesh(parseTro(buildSyntheticTro({ uvEntries: [], segments })));
    expect(mesh.triangleCount).toBe(2000);

    const index = new CollisionIndex(mesh, { cellSizeMeters: 4 });
    const hit = index.raycastWheelDown({ x: 5, y: 3, z: -10 }, { x: 0, y: -1, z: 0 }, 10);
    expect(hit).not.toBeNull();
    expect(hit!.point.y).toBeCloseTo(0, 5);
    expect(index.trianglesTestedLastQuery).toBeLessThan(30);
  });

  it('auto-flips outward subBlock98 normals inward without invisible pre-wall boundaries', () => {
    const tro = parseTro(
      buildSyntheticTro({
        uvEntries: [],
        segments: [
          {
            centerRaw: [320, 320, 0],
            subMesh0: {
              localVertices: [
                [0, 0, 0],
                [0, 640, 0],
                [640, 640, 0],
                [640, 0, 0],
              ],
              polygons: [{ listIndex: 2, vertices: [0, 1, 2, 3], colors: [{ r: 100, g: 100, b: 100 }] }],
            },
            subMesh1: { localVertices: [], polygons: [] },
            // Deliberately inverted outward normal: raw -Y -> engine +Z (pointing away from road z < 0)
            walls2D: [{ v0: 0, v1: 3, nxFixed12: 0, nyFixed12: -4096 }],
          },
        ],
      }),
    );

    const mesh = buildCollisionMesh(tro);
    expect(mesh.wallBarriers[0]!.normal.z).toBeLessThan(-0.9);
    const index = new CollisionIndex(mesh);

    // 1.5 m inside the track (z = -3.0 with hl = 1.4 -> front bumper at z = -1.6) must NOT collide!
    const insideRoad = index.resolveChassisWallCollisions({
      position: { x: 5, y: 0.6, z: -3.0 },
      orientation: quatIdentity(),
      linearVelocity: { x: 0, y: 0, z: 15 },
      angularVelocity: { x: 0, y: 0, z: 0 },
      halfExtents: { x: 0.85, y: 0.6, z: 1.4 },
      massKg: 1200,
      inertiaY: 1800,
    });
    expect(insideRoad.collided).toBe(false);

    // Penetrating z = 0 wall pushes car inward (-Z), never outward (+Z)
    const hitWall = index.resolveChassisWallCollisions({
      position: { x: 5, y: 0.6, z: -0.9 },
      orientation: quatIdentity(),
      linearVelocity: { x: 0, y: 0, z: 15 },
      angularVelocity: { x: 0, y: 0, z: 0 },
      halfExtents: { x: 0.85, y: 0.6, z: 1.4 },
      massKg: 1200,
      inertiaY: 1800,
    });
    expect(hitWall.collided).toBe(true);
    expect(hitWall.contactNormal.z).toBeLessThan(-0.9);
    expect(hitWall.positionCorrection.z).toBeLessThan(0);
    expect(hitWall.linearVelocityDelta.z).toBeLessThan(-15);
  });

  it('prevents high-speed oblique tunneling across zero-thickness barriers via swept CCD', () => {
    const mesh = buildMultiSegmentTestMesh();
    const index = new CollisionIndex(mesh);

    // 80 m/s oblique strike crossing wall z = 0 from z = -2.2 (inward) to z = +3.2 (far beyond 2.5 m static band)
    const prevPos = { x: 10, y: 0.6, z: -2.2 };
    const nextPos = { x: 14, y: 0.6, z: 3.2 };
    const res = index.resolveChassisWallCollisions({
      position: nextPos,
      prevPosition: prevPos,
      orientation: quatFromAxisAngle({ x: 0, y: 1, z: 0 }, -Math.PI / 6),
      linearVelocity: { x: 40, y: 0, z: 69.28 },
      angularVelocity: { x: 0, y: 0, z: 0 },
      halfExtents: { x: 0.9, y: 0.6, z: 2.0 },
      massKg: 1250,
      inertiaY: 2000,
    });

    expect(res.collided).toBe(true);
    const resolvedZ = nextPos.z + res.positionCorrection.z;
    // Chassis center & corners must be pushed strictly back onto inward side (z < 0)
    expect(resolvedZ).toBeLessThan(-0.5);
    expect(res.linearVelocityDelta.z).toBeLessThan(-69);
  });

  it('resolves V-corner consecutive barrier joins cleanly without gaps or snagging', () => {
    const tro = parseTro(
      buildSyntheticTro({
        uvEntries: [],
        segments: [
          {
            centerRaw: [320, 320, 0],
            subMesh0: {
              localVertices: [
                [0, 0, 0],
                [0, 640, 0],
                [640, 640, 0],
                [640, 0, 0],
              ],
              polygons: [{ listIndex: 2, vertices: [0, 1, 2, 3], colors: [{ r: 100, g: 100, b: 100 }] }],
            },
            subMesh1: { localVertices: [], polygons: [] },
            // V-corner at (10 m, 0 m): bottom wall along z=0 (v0->v3) and right wall along x=10 (v3->v2)
            walls2D: [
              { v0: 0, v1: 3, nxFixed12: 0, nyFixed12: -4096 },
              { v0: 3, v1: 2, nxFixed12: 4096, nyFixed12: 0 },
            ],
          },
        ],
      }),
    );

    const index = new CollisionIndex(buildCollisionMesh(tro));
    const res = index.resolveChassisWallCollisions({
      position: { x: 9.8, y: 0.6, z: -0.2 },
      prevPosition: { x: 7.5, y: 0.6, z: -2.5 },
      orientation: quatIdentity(),
      linearVelocity: { x: 18, y: 0, z: 18 },
      angularVelocity: { x: 0, y: 0, z: 0 },
      halfExtents: { x: 0.85, y: 0.6, z: 1.8 },
      massKg: 1200,
      inertiaY: 1800,
    });

    expect(res.collided).toBe(true);
    const finalX = 9.8 + res.positionCorrection.x;
    const finalZ = -0.2 + res.positionCorrection.z;
    // Pushed back inside BOTH corner walls (x < 10 - hw, z < -hl)
    expect(finalX).toBeLessThan(9.2);
    expect(finalZ).toBeLessThan(-1.7);
  });

  it('prevents back-face suction on thin 1.4 m double-sided pit-divider barriers', () => {
    const tro = parseTro(
      buildSyntheticTro({
        uvEntries: [],
        segments: [
          {
            centerRaw: [0, 320, 0],
            subMesh0: {
              // Main road x >= -5 m (rawX >= -320), pit lane x <= -6.4 m (rawX <= -410), divider thickness 1.406 m
              localVertices: [
                [-320, 0, 0],
                [-320, 640, 0],
                [320, 640, 0],
                [320, 0, 0],
                [-640, 0, 0],
                [-640, 640, 0],
                [-410, 640, 0],
                [-410, 0, 0],
              ],
              polygons: [
                { listIndex: 2, vertices: [0, 1, 2, 3], colors: [{ r: 100, g: 100, b: 100 }] },
                { listIndex: 2, vertices: [4, 5, 6, 7], colors: [{ r: 100, g: 100, b: 100 }] },
              ],
            },
            subMesh1: { localVertices: [], polygons: [] },
            walls2D: [
              // Main-track side at x = -5 m facing +X
              { v0: 0, v1: 1, nxFixed12: 4096, nyFixed12: 0 },
              // Pit-lane side at x = -6.406 m facing -X
              { v0: 7, v1: 6, nxFixed12: -4096, nyFixed12: 0 },
            ],
          },
        ],
      }),
    );

    const index = new CollisionIndex(buildCollisionMesh(tro));
    const prevPos = { x: -4.0, y: 0.6, z: -5.0 };
    const nextPos = { x: -5.2, y: 0.6, z: -5.0 };
    const res = index.resolveChassisWallCollisions({
      position: nextPos,
      prevPosition: prevPos,
      orientation: quatIdentity(),
      linearVelocity: { x: -18, y: 0, z: 0 },
      angularVelocity: { x: 0, y: 0, z: 0 },
      halfExtents: { x: 0.85, y: 0.6, z: 1.8 },
      massKg: 1200,
      inertiaY: 1800,
    });

    expect(res.collided).toBe(true);
    expect(res.contactNormal.x).toBeGreaterThan(0.9);
    expect(res.positionCorrection.x).toBeGreaterThan(0);
    expect(nextPos.x + res.positionCorrection.x).toBeGreaterThan(-4.3);
  });
});
