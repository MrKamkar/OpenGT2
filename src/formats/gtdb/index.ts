export {
  GTMODE_DATA_TABLE_COUNT,
  GTMODE_RACE_TABLE_COUNT,
  GTDT_HEADER_SIZE,
  GTDT_MAGIC_BYTES,
  GTDT_MAGIC_LE,
  GTDT_OBSERVED_FORMAT_FLAG,
  GTDT_PAIR_SIZE,
  GtdbError,
  type GtdbArchiveEntries,
  type GtdbErrorCode,
  type GtdbFileKind,
  type GtdbLayout,
  type GtdbMatchedEntry,
  type GtdbRawPair,
  type GtdbTableSlice,
  type GtdbTableSpec,
} from './types';

export {
  GTMODE_DATA_TABLE_SPECS,
  GTMODE_RACE_TABLE_SPECS,
  findGtdbEntries,
  getGtdbTable,
  isGtdtMagic,
  parseGtdbLayout,
} from './layout';

export {
  CAR_DIMENSIONS_SIZE,
  decodeCarDimensions,
  decodeCarDimensionsTable,
  type CarDimensions,
} from './carDimensions';

export {
  CAR_ENGINE_BAND_COUNT,
  CAR_ENGINE_BASE_UNITS_LENGTH,
  CAR_ENGINE_DATA_SIZE,
  decodeCarEngineData,
  decodeCarEngineDataTable,
  type CarEngineData,
} from './carEngineData';

export {
  CAR_GEARBOX_SIZE,
  CAR_GEARBOX_UNK_0X0A_LENGTH,
  decodeCarGearbox,
  decodeCarGearboxTable,
  type CarGearbox,
} from './carGearbox';

export {
  CAR_SUSPENSION_SIZE,
  CAR_SUSPENSION_UNK_0X0C_LENGTH,
  decodeCarSuspension,
  decodeCarSuspensionTable,
  type CarSuspension,
} from './carSuspension';

export {
  CAR_REAR_TYRES_SIZE,
  CAR_TYRES_SIZE,
  decodeCarRearTyres,
  decodeCarRearTyresTable,
  decodeCarTyres,
  decodeCarTyresTable,
  type CarRearTyres,
  type CarTyres,
} from './carTyres';

export {
  CAR_DATA_SIZE,
  decodeCarData,
  decodeCarDataTable,
  type CarData,
} from './carData';

export {
  CAR_RACING_MODIFICATION_SIZE,
  CAR_RACING_MODIFICATION_UNK_0X0C_LENGTH,
  decodeCarRacingModification,
  decodeCarRacingModificationTable,
  type CarRacingModification,
} from './carRacingModification';

export {
  WSDB_HEADER_SIZE,
  WSDB_MAGIC_BYTES,
  WSDB_MAGIC_LE,
  WSDB_MAGIC_OFFSET,
  getUnistrdbString,
  isWsdbMagic,
  parseUnistrdb,
  type UnistrdbTable,
} from './unistrdb';

export {
  CarCatalog,
  buildCarCatalogFromBuffers,
  formatCarIdHex,
  pairGtdbRegionVariants,
  selectDefaultGtdbVariant,
  type CarCatalogEngineSummary,
  type CarCatalogEntry,
  type CarCatalogInput,
  type CarCatalogName,
  type GtdbRegionVariant,
} from './carCatalog';

export {
  CAR_ID_BITS_PER_CHAR,
  CAR_ID_CHARSET,
  CAR_ID_CODE_LENGTH,
  CAR_ID_MAX_VALUE,
  CarAssetIndex,
  buildCarAssetIndex,
  decodeCarId,
  encodeCarId,
  resolveCarAssets,
  tryDecodeCarId,
  type ResolvedCarAssets,
  type ResolvedCarWithBodies,
} from './carId';
