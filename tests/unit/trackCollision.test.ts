import { describe, expect, it } from 'vitest';
import {
  COLLISION_SURFACE_CEILING,
  COLLISION_SURFACE_GROUND,
  COLLISION_SURFACE_WALL,
  TRO_SURFACE_ASPHALT,
  TRO_SURFACE_GRASS,
  TRO_SURFACE_KERB,
  buildCollisionMesh,
  buildTrackModel,
  classifySurfaceNormalY,
  parseTro,
  raycastCollisionMesh,
} from '../../src/formats/track';
import { buildSyntheticTro } from '../fixtures/buildTro';

describe('track CollisionMesh builder & raycaster (M8.5)', () => {
  it('classifies ground, wall, and ceiling normals accurately', () => {
    expect(classifySurfaceNormalY(1)).toBe('ground');
    expect(classifySurfaceNormalY(0.5)).toBe('ground');
    expect(classifySurfaceNormalY(0.49)).toBe('wall');
    expect(classifySurfaceNormalY(-0.49)).toBe('wall');
    expect(classifySurfaceNormalY(-0.5)).toBe('ceiling');
    expect(classifySurfaceNormalY(-1)).toBe('ceiling');
  });

  it('derives CollisionMesh from active render geometry, skips degenerate triangles, converts subBlock98 barriers, and supports segment-filtered raycasts', () => {
    const tro = parseTro(
      buildSyntheticTro({
        uvEntries: [],
        segments: [
          {
            centerRaw: [0, 0, 0],
            subMesh0: {
              localVertices: [
                // Horizontal road quad at Z=0 (CW in raw +Z up)
                [0, 0, 0],
                [0, 64, 0],
                [128, 64, 0],
                [128, 0, 0],
                // Vertical wall facing -Y in raw +Z up (after engine transform: +Z wall)
                [0, 0, 64],
                [128, 0, 64],
                // Degenerate zero-area vertex duplicate
                [0, 0, 0],
              ],
              polygons: [
                { listIndex: 2, vertices: [0, 1, 2, 3], colors: [{ r: 100, g: 100, b: 100 }] },
                // Wall quad: raw (0, 3, 5, 4) -> CCW in engine after (0,2,1)+(0,3,2)
                { listIndex: 2, vertices: [0, 3, 5, 4], colors: [{ r: 180, g: 180, b: 180 }] },
                // Degenerate zero-area triangle -> skipped
                { listIndex: 1, vertices: [0, 0, 6], colors: [{ r: 255, g: 0, b: 0 }] },
              ],
            },
            subMesh1: { localVertices: [], polygons: [] },
            walls2D: [{ v0: 0, v1: 3, nxFixed12: 0, nyFixed12: 4096 }],
          },
          {
            // Segment 1: lod1-fallback (subMesh0 empty, subMesh1 CCW ceiling facing -Z raw => -Y engine)
            centerRaw: [192, 0, 0],
            subMesh0: { localVertices: [], polygons: [] },
            subMesh1: {
              localVertices: [
                [128, 0, 128],
                [128, 64, 128],
                [256, 64, 128],
              ],
              polygons: [{ listIndex: 1, vertices: [0, 1, 2], colors: [{ r: 200, g: 200, b: 200 }] }],
            },
          },
        ],
      }),
    );

    const mesh = buildCollisionMesh(tro);
    expect(mesh.source).toBe('render-geometry');
    // Seg 0: 2 ground tris + 2 wall tris (degenerate skipped); Seg 1: 1 ceiling tri => 5 tris
    expect(mesh.triangleCount).toBe(5);
    expect(mesh.segments).toHaveLength(2);
    expect(mesh.segments[0]!.triangleStart).toBe(0);
    expect(mesh.segments[0]!.triangleCount).toBe(4);
    expect(mesh.segments[1]!.triangleStart).toBe(4);
    expect(mesh.segments[1]!.triangleCount).toBe(1);

    expect(mesh.surfaceTypes[0]).toBe(COLLISION_SURFACE_GROUND);
    expect(mesh.surfaceTypes[1]).toBe(COLLISION_SURFACE_GROUND);
    expect(mesh.surfaceTypes[2]).toBe(COLLISION_SURFACE_WALL);
    expect(mesh.surfaceTypes[3]).toBe(COLLISION_SURFACE_WALL);
    expect(mesh.surfaceTypes[4]).toBe(COLLISION_SURFACE_CEILING);
    expect(Array.from(mesh.groundMaterials ?? [])).toEqual([0, 0, 0, 0, 0]);

    // Check subBlock98 barrier conversion: raw (0, 1) normal -> engine (0, 0, -1)
    expect(mesh.wallBarriers).toHaveLength(1);
    expect(mesh.wallBarriers[0]!.start).toEqual({ x: 0, y: 0, z: -0 });
    expect(mesh.wallBarriers[0]!.end).toEqual({ x: 2, y: 0, z: -0 });
    expect(mesh.wallBarriers[0]!.normal).toEqual({ x: 0, y: 0, z: -1 });

    // Downward wheel raycast onto Segment 0 road surface (X=1, Z=-0.5)
    const groundHit = raycastCollisionMesh(mesh, { x: 1, y: 5, z: -0.5 }, { x: 0, y: -1, z: 0 }, 20);
    expect(groundHit).not.toBeNull();
    expect(groundHit!.distance).toBeCloseTo(5, 5);
    expect(groundHit!.point.y).toBeCloseTo(0, 5);
    expect(groundHit!.normal.y).toBeCloseTo(1, 5);
    expect(groundHit!.surfaceType).toBe('ground');
    expect(groundHit!.segmentIndex).toBe(0);

    // Filtered out when only 'wall' requested
    expect(
      raycastCollisionMesh(
        mesh,
        { x: 1, y: 5, z: -0.5 },
        { x: 0, y: -1, z: 0 },
        20,
        { surfaceFilter: ['wall'] },
      ),
    ).toBeNull();

    // Upward raycast hits Segment 1 ceiling at y=2 when doubleSided=false (since ceiling faces -Y!)
    const ceilingHit = raycastCollisionMesh(mesh, { x: 2.5, y: 0, z: -0.5 }, { x: 0, y: 1, z: 0 }, 10);
    expect(ceilingHit).not.toBeNull();
    expect(ceilingHit!.surfaceType).toBe('ceiling');
    expect(ceilingHit!.segmentIndex).toBe(1);
    expect(ceilingHit!.point.y).toBeCloseTo(2, 5);

    // Raycast from below ground upward misses front-facing ground when doubleSided=false, hits when true
    expect(raycastCollisionMesh(mesh, { x: 1, y: -2, z: -0.5 }, { x: 0, y: 1, z: 0 }, 10)).toBeNull();
    const backHit = raycastCollisionMesh(
      mesh,
      { x: 1, y: -2, z: -0.5 },
      { x: 0, y: 1, z: 0 },
      10,
      { doubleSided: true },
    );
    expect(backHit).not.toBeNull();
    expect(backHit!.distance).toBeCloseTo(2, 5);

    // TrackModel integration when includeCollision=true
    const withCollision = buildTrackModel(tro, undefined, { includeCollision: true });
    expect(withCollision.collision?.triangleCount).toBe(5);
  });

  it('handles empty tracks cleanly without NaNs or hits', () => {
    const emptyTro = parseTro(buildSyntheticTro({ uvEntries: [], segments: [] }));
    const mesh = buildCollisionMesh(emptyTro);
    expect(mesh.triangleCount).toBe(0);
    expect(mesh.segments).toHaveLength(0);
    expect(mesh.wallBarriers).toHaveLength(0);
    expect(raycastCollisionMesh(mesh, { x: 0, y: 10, z: 0 }, { x: 0, y: -1, z: 0 }, 50)).toBeNull();
  });

  it('propagates E3 polygon surfaceCode values into CollisionMesh.groundMaterials', () => {
    const tro = parseTro(
      buildSyntheticTro({
        uvEntries: [],
        segments: [
          {
            centerRaw: [0, 0, 0],
            subMesh0: {
              localVertices: [
                [0, 0, 0],
                [0, 64, 0],
                [64, 64, 0],
                [64, 0, 0],
                [128, 64, 0],
                [128, 0, 0],
                [192, 64, 0],
                [192, 0, 0],
              ],
              polygons: [
                { listIndex: 2, vertices: [0, 1, 2, 3], colors: [{ r: 100, g: 100, b: 100 }], surfaceCode: TRO_SURFACE_ASPHALT },
                { listIndex: 2, vertices: [3, 2, 4, 5], colors: [{ r: 200, g: 50, b: 50 }], surfaceCode: TRO_SURFACE_KERB },
                { listIndex: 2, vertices: [5, 4, 6, 7], colors: [{ r: 40, g: 150, b: 40 }], surfaceCode: TRO_SURFACE_GRASS },
              ],
            },
            subMesh1: { localVertices: [], polygons: [] },
          },
        ],
      }),
    );
    const mesh = buildCollisionMesh(tro);
    expect(Array.from(mesh.groundMaterials ?? [])).toEqual([
      TRO_SURFACE_ASPHALT,
      TRO_SURFACE_ASPHALT,
      TRO_SURFACE_KERB,
      TRO_SURFACE_KERB,
      TRO_SURFACE_GRASS,
      TRO_SURFACE_GRASS,
    ]);
  });
});
