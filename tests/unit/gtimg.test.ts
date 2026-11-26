import { describe, expect, it } from 'vitest';
import {
  GTIMG_CANVAS_HEIGHT,
  GTIMG_CANVAS_WIDTH,
  GtImgError,
  composeGmToRgba,
  composeGtmpToRgba,
  gmColor15ToRgba,
  gtmpColor15ToRgba,
  isGmMagic,
  isGtmpMagic,
  parseGm,
  parseGtmp,
  parseIdxTable,
  readGmContainerEntry,
  readGtmpContainerEntry,
} from '../../src/formats/gtimg';
import { BufferByteSource } from '../../src/io';
import { buildGm, buildGtmp, buildIdxContainer } from '../fixtures/buildGtimg';

function getRgbaAt(rgba: Uint8ClampedArray, x: number, y: number): [number, number, number, number] {
  const off = (y * GTIMG_CANVAS_WIDTH + x) * 4;
  return [rgba[off] ?? 0, rgba[off + 1] ?? 0, rgba[off + 2] ?? 0, rgba[off + 3] ?? 0];
}

describe('GT2 menu image formats: GM, GTMP, and IDX (M4.4)', () => {
  it('decodes GM and GTMP 15-bit colors with GTVolTools transparency conventions', () => {
    // GM: 0x0000 -> transparent; 0x8000 -> opaque black; non-zero bit15=0 -> opaque; bit15=1 -> transparent
    expect(gmColor15ToRgba(0x0000)).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(gmColor15ToRgba(0x8000)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    expect(gmColor15ToRgba(0x001f)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(gmColor15ToRgba(0x801f)).toEqual({ r: 255, g: 0, b: 0, a: 0 });

    // GTMP: bit15=1 -> opaque, bit15=0 -> transparent unless forceOpaque is true (solid tiles)
    expect(gtmpColor15ToRgba(0x0000)).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(gtmpColor15ToRgba(0x8000)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    expect(gtmpColor15ToRgba(0x83e0)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(gtmpColor15ToRgba(0x03e0)).toEqual({ r: 0, g: 255, b: 0, a: 0 });
    expect(gtmpColor15ToRgba(0x7c00, { forceOpaque: true })).toEqual({
      r: 0,
      g: 0,
      b: 255,
      a: 255,
    });
  });

  it('parses aligned-2048 and mangled-4 IDX tables and rejects malformed tables', () => {
    const rawIdx4 = new Uint8Array(4 + 4 * 4);
    const dv = new DataView(rawIdx4.buffer);
    dv.setUint32(0, 3, true);
    dv.setUint32(4, 0, true); // off=0, tail=0 -> size = 100 - 0 - 0 = 100
    dv.setUint32(8, 103, true); // off=100, tail=3 -> size = 200 - 100 - 3 = 97
    dv.setUint32(12, 201, true); // off=200, tail=1 -> size = 300 - 200 - 1 = 99
    dv.setUint32(16, 300, true); // sentinel totalDataSize=300

    const parsed4 = parseIdxTable(rawIdx4, 'mangled-4');
    expect(parsed4.count).toBe(3);
    expect(parsed4.totalDataSize).toBe(300);
    expect(parsed4.entries).toEqual([
      { index: 0, offset: 0, tail: 0, size: 100 },
      { index: 1, offset: 100, tail: 3, size: 97 },
      { index: 2, offset: 200, tail: 1, size: 99 },
    ]);

    expect(() => parseIdxTable(new Uint8Array(4), 'aligned-2048')).toThrow(GtImgError);
    const nonMonotonic = rawIdx4.slice();
    new DataView(nonMonotonic.buffer).setUint32(12, 50, true);
    expect(() => parseIdxTable(nonMonotonic, 'mangled-4')).toThrow(GtImgError);
  });

  it('parses GM\\x03\\x00 with groups, boxes, metadata, 4 bpp tiles, 32 palettes, and solid tiles', () => {
    // Prepare 2 rows of tiles (tileCount = 34 -> tile 0 in row 0, tile 33 in row 1 col 1)
    const packed = new Uint8Array(2 * 2048);
    // Tile 0 (row 0, x=0): pixel (0,0)=1, pixel (1,0)=2 -> byte 0x21
    packed[0] = 0x21;
    // Tile 33 (row 1 = byte offset 2048, col 1 = byte offset +8): pixel (0,0)=3, pixel (1,0)=0 -> byte 0x03
    packed[2048 + 8] = 0x03;

    const pal0 = new Array<number>(16).fill(0x0000);
    pal0[1] = 0x001f; // red
    pal0[2] = 0x03e0; // green
    const pal19 = new Array<number>(16).fill(0x0000);
    pal19[3] = 0x7c00; // blue

    const palettes = new Array<number[]>(32).fill([]);
    palettes[0] = pal0;
    palettes[19] = pal19;

    const rawGm = buildGm({
      groups: [
        {
          iconBoxes: [
            {
              screenX: 16,
              screenY: 24,
              imgMapX: 1,
              imgMapY: 2,
              width: 32,
              height: 16,
              unk_0x08: 11,
              drawModifier1: 4,
              drawModifier2: 5,
            },
          ],
          infoBoxes: [
            {
              x1: 10,
              y1: 20,
              x2: 110,
              y2: 60,
              contents: 0x0002,
              queryType: 0x10,
              attributes: 0x03,
              extraData: new Uint8Array([0x2a, 0x00, 0x00, 0x00]),
            },
          ],
        },
      ],
      mainInfoBoxes: [
        {
          x1: 0,
          y1: 0,
          x2: 512,
          y2: 40,
          contents: 0x004d,
          queryType: 0,
          attributes: 0x80,
        },
      ],
      manufacturerId: 12,
      screenBehaviour: 3,
      music: 4,
      backLink: 77,
      backgroundIndex: 15,
      positions: [
        { kind: 'tile', tileX: 1, tileY: 2, tileIndexOrColor: 0, paletteIndex: 0 },
        { kind: 'tile', tileX: 3, tileY: 4, tileIndexOrColor: 33, paletteIndex: 19 },
        { kind: 'solid', tileX: 5, tileY: 6, tileIndexOrColor: 0x03ff, solidFlags: 1 }, // yellow
      ],
      palettes,
      tileCount: 34,
      packedPixelBytes: packed,
      trailingBytes: new Uint8Array([0xaa, 0xbb]),
    });

    // Test non-zero byteOffset slice
    const padded = new Uint8Array(rawGm.byteLength + 3);
    padded.set(rawGm, 3);
    const gmSlice = padded.subarray(3);

    expect(isGmMagic(gmSlice)).toBe(true);
    const gm = parseGm(gmSlice);
    expect(gm.subBlockSets).toBe(1);
    expect(gm.iconBoxes).toHaveLength(1);
    expect(gm.iconBoxes[0]?.unk_0x08).toBe(11);
    expect(gm.infoBoxes).toHaveLength(2);
    expect(gm.infoBoxes[0]?.group).toBe(0);
    expect(gm.infoBoxes[1]?.group).toBe(-1);
    expect(gm.metadata).toEqual({
      manufacturerId: 12,
      screenBehaviour: 3,
      backLinkToPreviousScreen: true,
      music: 4,
      backLink: 77,
      backgroundIndex: 15,
    });
    expect(gm.tileCount).toBe(34);
    expect(gm.tileSheet.bpp).toBe(4);
    expect(gm.tileSheet.width).toBe(512);
    expect(gm.tileSheet.height).toBe(16);
    expect(gm.tileSheet.palettes).toHaveLength(32);
    expect(gm.trailingBytes).toBe(2);

    const rgba = composeGmToRgba(gm);
    expect(rgba.width).toBe(GTIMG_CANVAS_WIDTH);
    expect(rgba.height).toBe(GTIMG_CANVAS_HEIGHT);
    expect(rgba.rgba.byteLength).toBe(512 * 504 * 4);

    // Unplaced background stays transparent black
    expect(getRgbaAt(rgba.rgba, 0, 0)).toEqual([0, 0, 0, 0]);
    // Tile 0 placed at (1*16=16, 2*8=16) with pal0
    expect(getRgbaAt(rgba.rgba, 16, 16)).toEqual([255, 0, 0, 255]);
    expect(getRgbaAt(rgba.rgba, 17, 16)).toEqual([0, 255, 0, 255]);
    // Tile 33 placed at (3*16=48, 4*8=32) with pal19
    expect(getRgbaAt(rgba.rgba, 48, 32)).toEqual([0, 0, 255, 255]);
    expect(getRgbaAt(rgba.rgba, 49, 32)).toEqual([0, 0, 0, 0]);
    // Solid yellow tile placed at (5*16=80, 6*8=48)
    expect(getRgbaAt(rgba.rgba, 80, 48)).toEqual([255, 255, 0, 255]);
    expect(getRgbaAt(rgba.rgba, 95, 55)).toEqual([255, 255, 0, 255]);
  });

  it('parses GTMP 8 bpp tiles, 16 palettes, solid tiles, and unk_0x3f84 metadata', () => {
    const pixelBytes = new Uint8Array(2 * 4096);
    // Tile 0 (row 0, x=0): (0,0) = index 5, (15,7) = index 200
    pixelBytes[0] = 5;
    pixelBytes[7 * 512 + 15] = 200;
    // Tile 33 (row 1 = 4096, col 1 = +16): (0,0) = index 99
    pixelBytes[4096 + 16] = 99;

    const pal0 = new Array<number>(256).fill(0x0000);
    pal0[5] = 0x801f; // opaque red
    pal0[200] = 0x8000; // opaque black
    const pal7 = new Array<number>(256).fill(0x0000);
    pal7[99] = 0x83e0; // opaque green

    const palettes = new Array<number[]>(16).fill([]);
    palettes[0] = pal0;
    palettes[7] = pal7;

    const rawGtmp = buildGtmp({
      positions: [
        { kind: 'tile', tileX: 2, tileY: 1, tileIndexOrColor: 0, paletteIndex: 0 },
        { kind: 'tile', tileX: 4, tileY: 3, tileIndexOrColor: 33, paletteIndex: 7 },
        // Solid tile without bit 15 set: must still compose opaque!
        { kind: 'solid', tileX: 6, tileY: 5, tileIndexOrColor: 0x7c00, solidFlags: 1 },
      ],
      palettes,
      tileRows: 2,
      pixelBytes,
      unk_0x3f84_tileHint: 42,
      unk_0x3f88_tileHint: 42,
    });

    const padded = new Uint8Array(rawGtmp.byteLength + 7);
    padded.set(rawGtmp, 7);
    const gtmpSlice = padded.subarray(7);

    expect(isGtmpMagic(gtmpSlice)).toBe(true);
    const gtmp = parseGtmp(gtmpSlice);
    expect(gtmp.tileCount).toBe(64);
    expect(gtmp.tileSheet.bpp).toBe(8);
    expect(gtmp.tileSheet.width).toBe(512);
    expect(gtmp.tileSheet.height).toBe(16);
    expect(gtmp.tileSheet.palettes).toHaveLength(16);
    expect(gtmp.positions).toHaveLength(2016);
    expect(gtmp.unk_0x3f84.byteLength).toBe(0x7c);
    expect(gtmp.unk_0x3f84_tileHint).toBe(42);
    expect(gtmp.unk_0x3f88_tileHint).toBe(42);

    const rgba = composeGtmpToRgba(gtmp);
    // Unplaced area in GTMP initializes to opaque black (0,0,0,255)
    expect(getRgbaAt(rgba.rgba, 400, 400)).toEqual([0, 0, 0, 255]);
    // Tile 0 at (2*16=32, 1*8=8)
    expect(getRgbaAt(rgba.rgba, 32, 8)).toEqual([255, 0, 0, 255]);
    expect(getRgbaAt(rgba.rgba, 47, 15)).toEqual([0, 0, 0, 255]);
    // Tile 33 at (4*16=64, 3*8=24) with palette 7
    expect(getRgbaAt(rgba.rgba, 64, 24)).toEqual([0, 255, 0, 255]);
    // Solid blue tile at (6*16=96, 5*8=40) forced opaque
    expect(getRgbaAt(rgba.rgba, 96, 40)).toEqual([0, 0, 255, 255]);
  });

  it('streams GM and GTMP entries from ByteSource via IDX tables (both fflate and auto gunzip)', async () => {
    const gm0 = buildGm({
      positions: [{ kind: 'tile', tileX: 0, tileY: 0, tileIndexOrColor: 0, paletteIndex: 0 }],
      palettes: [[0x0000, 0x001f]],
      tileCount: 1,
      packedPixelBytes: new Uint8Array([0x01]),
    });
    const gm1 = buildGm({
      positions: [{ kind: 'solid', tileX: 1, tileY: 1, tileIndexOrColor: 0x03e0, solidFlags: 1 }],
      tileCount: 1,
    });

    const gmPack = buildIdxContainer([gm0, gm1], 'mangled-4', { gzipMembers: true });
    const gmIdx = parseIdxTable(gmPack.idx, 'mangled-4');
    const gmSource = new BufferByteSource(gmPack.dat);

    const read0 = await readGmContainerEntry(gmSource, gmIdx, 0, { backend: 'fflate' });
    const read1 = await readGmContainerEntry(gmSource, gmIdx, 1, { backend: 'auto' });
    expect(getRgbaAt(composeGmToRgba(read0).rgba, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(getRgbaAt(composeGmToRgba(read1).rgba, 16, 8)).toEqual([0, 255, 0, 255]);

    const gtmp0 = buildGtmp({
      positions: [{ kind: 'solid', tileX: 2, tileY: 2, tileIndexOrColor: 0x7c00, solidFlags: 1 }],
      tileRows: 1,
    });
    const gtmpPack = buildIdxContainer([gtmp0], 'aligned-2048');
    const gtmpIdx = parseIdxTable(gtmpPack.idx, 'aligned-2048');
    const gtmpSource = new BufferByteSource(gtmpPack.dat);

    const parsedGtmp = await readGtmpContainerEntry(gtmpSource, gtmpIdx, 0);
    expect(getRgbaAt(composeGtmpToRgba(parsedGtmp).rgba, 32, 16)).toEqual([0, 0, 255, 255]);
    await expect(readGtmpContainerEntry(gtmpSource, gtmpIdx, 1)).rejects.toThrow(RangeError);
  });

  it('rejects bad magics, missing GMLL, truncated buffers, and out-of-range tile/palette indices', () => {
    expect(isGmMagic(new Uint8Array([0x47, 0x4d, 0x03]))).toBe(false);
    expect(isGtmpMagic(new Uint8Array([0x47, 0x54, 0x4d]))).toBe(false);

    expect(() => parseGm(new Uint8Array(7))).toThrow(GtImgError);
    expect(() => parseGtmp(new Uint8Array(0x3fff))).toThrow(GtImgError);

    const badGmMagic = buildGm({ positions: [], tileCount: 1 });
    badGmMagic[0] = 0x00;
    expect(() => parseGm(badGmMagic)).toThrow(GtImgError);

    const badGmll = buildGm({ positions: [], tileCount: 1 });
    const gmllOffset = 8 + 4 + 12; // no groups, 0 mainInfoBoxes, 12B metadata
    badGmll[gmllOffset] = 0x00;
    expect(() => parseGm(badGmll)).toThrow(GtImgError);

    const oobGmTile = buildGm({
      positions: [{ kind: 'tile', tileX: 0, tileY: 0, tileIndexOrColor: 5, paletteIndex: 0 }],
      tileCount: 2,
    });
    expect(() => parseGm(oobGmTile)).toThrow(GtImgError);

    const badGtmpLen = new Uint8Array(0x4000 + 100);
    badGtmpLen.set([0x47, 0x54, 0x4d, 0x50], 0);
    expect(() => parseGtmp(badGtmpLen)).toThrow(GtImgError);

    const oobGtmpTile = buildGtmp({
      positions: [{ kind: 'tile', tileX: 0, tileY: 0, tileIndexOrColor: 99, paletteIndex: 0 }],
      tileRows: 1, // 32 tiles max
    });
    expect(() => parseGtmp(oobGtmpTile)).toThrow(GtImgError);
  });
});
