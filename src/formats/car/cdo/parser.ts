import { parseCdoNormals, parseCdoVertices } from './geometry';
import { parseCdoHeader } from './header';
import { parseCdoLodHeader, parseCdoLodTable } from './lod';
import { parseCdoPolygonLists } from './polygons';
import { parseCdoShadowBlock } from './shadow';
import { CDO_MAX_FILE_SIZE, CdoError, type CdoLod, type CdoModel } from './types';
import { validateCdo } from './validate';

/**
 * Parses and validates a complete uncompressed `.cdo` / `.cno` GT2 car model buffer.
 * Reads all LODs and the trailing shadow block sequentially and enforces exact EOF.
 */
export function parseCdo(data: Uint8Array): CdoModel {
  if (data.byteLength > CDO_MAX_FILE_SIZE) {
    throw new CdoError(
      CdoError.FileTooLarge,
      `CDO size ${String(data.byteLength)} bytes exceeds maximum ${String(CDO_MAX_FILE_SIZE)} (0x5000) bytes.`,
    );
  }

  const header = parseCdoHeader(data);
  const lodTable = parseCdoLodTable(data);

  const lods: CdoLod[] = [];
  let cursor = lodTable.nextOffset;

  for (let i = 0; i < lodTable.lodCount; i += 1) {
    const tableEntry = lodTable.entries[i]!;
    const lodHeader = parseCdoLodHeader(data, cursor);
    const vertices = parseCdoVertices(
      data,
      lodHeader.dataOffset,
      lodHeader.vertexCount,
      lodHeader.scale,
    );
    const normals = parseCdoNormals(data, vertices.nextOffset, lodHeader.normalCount);
    const polygons = parseCdoPolygonLists(data, normals.nextOffset, {
      triCount: lodHeader.triCount,
      quadCount: lodHeader.quadCount,
      uvTriCount: lodHeader.uvTriCount,
      uvQuadCount: lodHeader.uvQuadCount,
    });

    cursor = polygons.nextOffset;
    lods.push({
      index: i,
      tableEntry,
      header: lodHeader,
      vertices,
      normals,
      polygons,
      endOffset: cursor,
    });
  }

  const shadow = parseCdoShadowBlock(data, cursor);
  const baseModel: Omit<CdoModel, 'warnings'> = {
    byteLength: data.byteLength,
    header,
    lodTable,
    lods,
    shadow,
  };

  const { warnings } = validateCdo(baseModel);

  return {
    ...baseModel,
    warnings,
  };
}
