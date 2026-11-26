import type { Mat4 } from './math';
import type { CarMeshDrawBatch, CarMeshPrimitive } from './meshData';

/**
 * Draw ordering mode:
 * - `'zbuffer'` (default for both HD and PS1)
 * - `'ordering-table-experimental'`: CPU back-to-front painter's sort in view space (M7.6).
 */
export type DrawOrderMode = 'zbuffer' | 'ordering-table-experimental';

export interface OrderingTableOptions {
  /**
   * @evidence E1 — When `true` inside experimental mode, uses CDO's 5-bit `renderOrder` field
   * as an optional tie-breaker / small depth bias. Off by default.
   */
  readonly useRenderOrderHint?: boolean;
  /** Optional meters-per-unit bias applied to `renderOrder` when `useRenderOrderHint` is true. */
  readonly renderOrderWeight?: number;
}

export interface OrderingTableResult {
  readonly indices: Uint16Array;
  readonly batches: readonly CarMeshDrawBatch[];
}

interface SortablePrimitive {
  readonly primitive: CarMeshPrimitive;
  readonly originalIndex: number;
  readonly sortKey: number;
}

/**
 * Deterministically sorts car mesh primitives from farthest to nearest in right-handed
 * view space (`-Z` forward, so smaller `viewZ` is farther and drawn first), packing
 * the sorted triangle indices and merging consecutive primitives with identical culling
 * state into minimal `CarMeshDrawBatch[]` runs (`M7.6`).
 */
export function sortPrimitivesOrderingTable(
  primitives: readonly CarMeshPrimitive[],
  viewMatrix: Mat4,
  options: OrderingTableOptions = {},
): OrderingTableResult {
  const count = primitives.length;
  if (count === 0) {
    return {
      indices: new Uint16Array(0),
      batches: [],
    };
  }

  const m02 = viewMatrix[2] ?? 0;
  const m12 = viewMatrix[6] ?? 0;
  const m22 = viewMatrix[10] ?? 0;
  const m32 = viewMatrix[14] ?? 0;

  const useHint = options.useRenderOrderHint === true;
  const hintWeight =
    useHint && options.renderOrderWeight !== undefined && Number.isFinite(options.renderOrderWeight)
      ? options.renderOrderWeight
      : 0;

  const entries: SortablePrimitive[] = new Array<SortablePrimitive>(count);
  for (let i = 0; i < count; i += 1) {
    const prim = primitives[i]!;
    const viewZ =
      m02 * prim.centroidX +
      m12 * prim.centroidY +
      m22 * prim.centroidZ +
      m32;
    const sortKey = useHint ? viewZ + prim.renderOrder * hintWeight : viewZ;
    entries[i] = {
      primitive: prim,
      originalIndex: i,
      sortKey,
    };
  }

  entries.sort((a, b) => {
    const dz = a.sortKey - b.sortKey;
    if (dz !== 0) {
      return dz;
    }
    if (useHint) {
      const dro = a.primitive.renderOrder - b.primitive.renderOrder;
      if (dro !== 0) {
        return dro;
      }
    }
    return a.originalIndex - b.originalIndex;
  });

  const indices = new Uint16Array(count * 3);
  const batches: CarMeshDrawBatch[] = [];

  let runSingleSided = entries[0]!.primitive.singleSided;
  let runStartIndex = 0;

  for (let i = 0; i < count; i += 1) {
    const prim = entries[i]!.primitive;
    const outBase = i * 3;
    indices[outBase] = prim.i0;
    indices[outBase + 1] = prim.i1;
    indices[outBase + 2] = prim.i2;

    if (prim.singleSided !== runSingleSided) {
      batches.push({
        singleSided: runSingleSided,
        indexOffset: runStartIndex,
        indexCount: outBase - runStartIndex,
      });
      runSingleSided = prim.singleSided;
      runStartIndex = outBase;
    }
  }

  batches.push({
    singleSided: runSingleSided,
    indexOffset: runStartIndex,
    indexCount: count * 3 - runStartIndex,
  });

  return {
    indices,
    batches,
  };
}
