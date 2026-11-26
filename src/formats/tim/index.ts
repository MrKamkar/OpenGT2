export {
  TIM_ALLOWED_FLAGS_MASK,
  TIM_BLOCK_HEADER_BYTES,
  TIM_HAS_CLUT_FLAG,
  TIM_HEADER_BYTES,
  TIM_MAGIC,
  TIM_PMODE_MASK,
  TimError,
  type TimBpp,
  type TimClutBlock,
  type TimErrorCode,
  type TimImage,
  type TimImageBlock,
  type TimPixelMode,
} from './types';
export { decodeTimToRgba, isTimMagic, parseTim, timToIndexedImage } from './parser';
