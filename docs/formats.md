# OpenGT2 Binary Formats Reference

## Confidence Levels (E0–E3)

Aligned with [ROADMAP.md §3](../ROADMAP.md#3-poziomy-pewności-wiedzy-o-formatach):

| Level | Meaning |
| --- | --- |
| **E3** | Confirmed in reference code **and** verified by automated test on a real game file. |
| **E2** | Confirmed in reference code or community documentation, not yet verified on a real game file. |
| **E1** | Hypothesis based on data observation (e.g., patterns, entropy, repetition), without independent confirmation. |
| **E0** | Unknown. Field or structure exists, but its meaning is not known. Never affects runtime behavior. |

---

## `GT2.VOL` Archive Format

- **Confidence:** **E3** (verified in M2.10 against a real 488,241,152 B `GT2.VOL` archive: `files = 11581`, `totalEntries = 11620`, `warnings = []`)
- **Reference Source:** `adeyblue/GTVolTools` (`GT2VolFile.cs`, MIT License)
- **Endianness:** Little-endian (`DataView(..., true)`) (**E3**)
- **Sector Alignment:** `VOL_SECTOR_SIZE = 0x800` (2048 bytes) (**E3**)

### 1. Header (`0x00..0x0F`, 16 bytes)

| Offset | Size | Type | Name / Meaning | Confidence |
| --- | --- | --- | --- | --- |
| `0x00` | 8 B | `char[8]` | Magic `"GTFS\0\0\0\0"` (`47 54 46 53 00 00 00 00`) | **E3** |
| `0x08` | 2 B | `int16` LE | `files`: entry count of the offset table | **E3** |
| `0x0A` | 2 B | `int16` LE | `totalEntries`: total number of 32-byte TOC records (files + dirs + `..`) | **E3** |
| `0x0C` | 4 B | `uint32` LE | `unk_0x0C`: unread by reference parser; observed `0x00000000` in verified `GT2.VOL` | **E0** |

Validation invariants (**E3**): magic matches `"GTFS\0\0\0\0"`, `files > 0`, `totalEntries > 0`, and `totalEntries > files`.

### 2. Offset Table (`0x10..0x10 + files * 4 - 1`)

- Array of `uint32[files]` little-endian raw mangled offset words (**E3**).
- Index meanings (**E3**):
  - `offsets[0]` — offset of the offset table itself (`0x10`)
  - `offsets[1]` — TOC start offset (mangled)
  - `offsets[2 .. files - 2]` — file data start offsets (mangled; `files - 3 = 11578` files in verified `GT2.VOL`)
  - `offsets[files - 1]` — explicit trailing EOF sentinel (`address = archiveSize`, `tail = 0`) observed in verified `GT2.VOL` (**E3**)
  - `offsets[files]` (virtual, appended by parser) — total archive byte size (`source.size`), retained as a safeguard for other GT2 releases (**E2** / **E3** consistent with `offsets[files - 1]`)
- Word decoding (`splitOffset(raw)`, **E3**):
  - `address = (raw & 0xFFFFF800) >>> 0` (sector-aligned byte offset)
  - `tail = (raw & 0x7FF) >>> 0` (unused trailing bytes in the final `0x800` sector)

### 3. Table of Contents (TOC) Boundaries

```text
tocAddress       = splitOffset(offsets[1]).address
tocTail          = splitOffset(offsets[1]).tail
firstFileAddress = splitOffset(offsets[2]).address   (or virtual EOF when files === 2)
tocLength        = firstFileAddress - tocAddress - tocTail
```

Hard invariant (**E3**): `tocLength >= totalEntries * 32` (`tocLength === totalEntries * 32 = 371,840 B` in verified `GT2.VOL`) and `tocAddress + tocLength <= volSize`.

### 4. TOC Entry Record (32 bytes each)

| Offset | Size | Type | Name / Meaning | Confidence |
| --- | --- | --- | --- | --- |
| `0x00` | 4 B | `int32` LE | `unixTime`: Unix timestamp (seconds, UTC) | **E3** |
| `0x04` | 2 B | `int16` LE | `offsetIndex`: `0` = `..` parent entry (**E3**); non-zero for all 21/21 regular directories (**E3**) and `2..files-2` for files (**E3**). Regular directories can store values `>= files` (e.g., up to `11604` > `11581`), indicating a TOC-space index rather than an offset-table index (exact pointer semantics **E1**). | **E3** / **E1** (dir target) |
| `0x06` | 1 B | `uint8` | `flags`: `0x01` = directory, `0x80` = last entry in current directory (**E3**); bits `0x02..0x7E` observed `0x00` across all 11,620 entries (**E0**) | **E3** (`0x01`,`0x80`) / **E0** (`0x02..0x7E`) |
| `0x07` | 25 B | `char[25]` | `name`: ASCII entry name, zero-padded | **E3** |

- Entries with `offsetIndex === 0` or directory flag (`flags & 0x01`) have `address = 0` and no file payload (**E3**).
- `..` entries (and entries with `offsetIndex === 0`) are excluded from the final directory listing, **but `flags & 0x80` on them still terminates the current directory** (**E3**).

### 5. Directory Tree Reconstruction ("First Encounter", **E3**)

TOC entries appear in directory-grouped "first encounter" order:
- Maintain `dirBeingParsed = ""`, queue `directories = []`, `dirIndex = 0`, `dirInsertIndex = 0`.
- For each TOC entry:
  1. `path = dirBeingParsed ? `${dirBeingParsed}/${entry.name}` : entry.name`.
  2. If directory and not `..`:
     - If `dirBeingParsed !== ""`, insert `path` into `directories` at `dirInsertIndex++`.
     - Else, append `path` to `directories`.
  3. If `(flags & 0x80) !== 0`:
     - `dirBeingParsed = dirIndex < directories.length ? directories[dirIndex++] : ""`
     - `dirInsertIndex = dirIndex`
  4. Emit entry if `offsetIndex !== 0 && !isParentRef`.

### 6. File Size Derivation & Consistency Assumptions

- For consecutive file entries in TOC order (**E3**):
  - `previous.size = next.address - previous.address - previous.tail`
- For the last file entry (**E3**):
  - `computed = offsets[files] - last.address - last.tail` (matching `offsets[files - 1] === archiveSize` in verified `GT2.VOL`)
  - If `computed <= 0`, fallback size is `0x800` bytes (**E2**).
- **0-byte files (E3):** `6/6` zero-byte entries in verified `GT2.VOL` use `next.address === previous.address` and `previous.tail === 0`, yielding `size = 0`.
- **Monotonicity & Non-overlap (E3):** file addresses in TOC order are non-decreasing (`next.address >= previous.address`), non-overlapping, and bounded by `volSize` (`0` warnings in verified `GT2.VOL`); violations emit `VolInfo.warnings` without throwing.

### 7. Compression (`src/formats/gzip/`)

- **`.gz` entries (E3):** `5114/5114` (100%) `.gz` files in verified `GT2.VOL` begin with standard RFC 1952 gzip magic (`1F 8B 08`) and decompress cleanly with valid CRC-32 and ISIZE on both `DecompressionStream('gzip')` and `fflate`.
- **Non-`.gz` entries starting with `1F 8B`:** `91` entries in verified `GT2.VOL` lack the `.gz` extension yet start with `1F 8B 08`:
  - `84/91` are standalone RFC 1952 gzip streams that pass strict single-stream `gunzip` and CRC-32 verification (**E3**).
  - `7/91` are multi-member gzip containers starting with a valid CRC-checked gzip member followed by zero-padding to either a 4-byte boundary or a 2048-byte CD sector boundary where the next `1F 8B` member begins (**E3** for framing and member magic verified in M4.1):
    - `5` `.dat` containers (`37.55–46.83 MB` compressed) holding `16,914` individual gzip members indexed via `5` `.idx` tables (`3,379–3,386` per file; previously counted as `12,658` in M4.1 because `node:zlib` concatenated adjacent members with `tail === 0`), padded to 4-byte boundaries (`tail = raw & 3`), every member starting with `47 4D 03 00` (`"GM\x03\x00"`) (**E3**).
    - `2` extensionless containers (`116,736 B` and `118,784 B` compressed) holding `12` sequential gzip members each (`24` total), zero-padded to 2048-byte sector boundaries, every member being a valid 16-bpp PS1 TIM image (`10 00 00 00 02 00 00 00`).

---

## Formaty obrazów w GT2.VOL

> **Źródło i weryfikacja (M4.1):** pełny skan strumieniowy wszystkich `11 578` plików lokalnego `GT2.VOL` (`488 241 152 B`), w tym `5 114` plików `.gz`, `84` samodzielnych strumieni `1F 8B` oraz `7` wieloczłonowych kontenerów `1F 8B` (`12 682` członów łącznie). Test automatyczny: `tests/unit/volImageInventory.test.ts`.

### 1. Kandydaci na formaty obrazów i tekstur

| Rozszerzenie (zewn. / wewn.) | Kompresja | Sygnatura magic (hex / ASCII) | Liczba plików / członów | Zakres rozmiaru (po rozpakowaniu) | Rola / uwagi | Pewność |
| --- | --- | --- | --- | --- | --- | --- |
| `.tim` | brak (surowy) | `10 00 00 00` | `3 576` plików | `1 216–163 860 B` | Standardowy PS1 TIM: `3 539` w trybie `4 bpp + CLUT` (`flags = 0x08`), `37` w trybie `4 bpp` bez CLUT (`flags = 0x00`); `100%` ścisła zgodność `bnum` | **E3** |
| `.tim.gz` (`.tim`) | gzip (1 człon) | `10 00 00 00` | `129` plików | `4 672–169 504 B` | PS1 TIM: `120` `4 bpp + CLUT`, `7` `8 bpp + CLUT`, `2` `4 bpp` bez CLUT; `95` ścisłe + `34` z anomalią `img.bnum` (szczegóły poniżej) | **E3** |
| `(brak)` `[multi-gz]` | multi-gzip (`2048 B`) | `10 00 00 00 02 00 00 00` | `2` pliki (`24` człony) | `7 860–122 900 B` / człon | PS1 TIM `16 bpp` bez CLUT (`flags = 0x02`), `100%` ścisła zgodność `bnum` | **E3** |
| `.dat` `[multi-gz]` + `.idx` | multi-gzip (`4 B`, `mangled-4` `.idx`) | `47 4D 03 00` (`"GM\x03\x00"`) | `5` par (`.dat`+`.idx`), `16 914` członów | `3 184–245 000 B` / człon | Obrazy pierwszego planu menu GT2 (`4 bpp`, kafelki `16×8`, `32` palety `16`-kolorowe, sekcja `GMLL`, płótno `512×504`; zweryfikowane `16 914 / 16 914` w M4.4) | **E3** |
| `.dat` (surowy `GTMP`) + `.idx` | brak (`aligned-2048` `.idx`) | `47 54 4D 50` (`"GTMP"`) | `1` para (`.dat`+`.idx`), `458` bloków (`44 724 224 B` łącznie) | `20 480–266 240 B` / blok | Obrazy tła menu GT2 (`8 bpp`, kafelki `16×8`, `16` palet `256`-kolorowych, `2 016` pozycji, płótno `512×504`; zweryfikowane `458 / 458` w M4.4) | **E3** |
| `.cdp.gz` / `.cnp.gz` | gzip (1 człon) | brak stałego magic (`uint16` liczba kolorów) | `2 220` (`1 110` + `1 110`) | `45 984 B` (stały, `0xB3A0`) | Tekstury i palety lakierów aut dzień/noc (`0x43A0 + 0x7000 = 45 984 B`, 100% zgodności z Załącznikiem D.7; zakres M6.7) | **E3** (rozmiar/obecność) / **E2** (układ) |
| `.trp.gz` / `.bsp.gz` | gzip (1 człon) | brak stałego magic (`uint32[1] = 0x10`) | `160` (`126` + `34`) | `7 172–295 620 B` | Kandydaci na pakiety tekstur torów/tła sparowane `1:1` z `.tro.gz` (`126`) i `.bso.gz` (`34`) (zakres M8) | **E1** |
| `.lgf.gz` + `(brak)` (1-człon. gzip) | gzip (1 człon) | `00 00 02 01` | `261` (`180` + `81`) | `36 956 B` (`.lgf`), `2 063–589 824 B` (`(brak)`) | Powtarzalna niezweryfikowana sygnatura (kandydat badawczy — brak potwierdzenia kodem referencyjnym) | **E1** |

### 2. Rygorystyczna weryfikacja TIM i anomalia `img.bnum` (dla M4.3)

- **Zero fałszywych trafień TIM (`0 / 3 729`):** Każdy z `3 705` pojedynczych plików (`3 576` surowych `.tim` + `129` `.tim.gz`) oraz `24` członów z `2` bezrozszerzeniowych kontenerów multi-gzip o sygnaturze `10 00 00 00` przeszedł walidację flag (`flags & ~0x0B === 0`), spójności bloku CLUT (`12 + clutW * clutH * 2`) oraz wymiarów bloku obrazu. Żaden inny plik ani człon w archiwum nie ma przypadkowego magic `10 00 00 00`.
- **Anomalia `34` plików `.tim.gz` (**E3** obserwacja):** Wszystkie `34` pliki mają `flags = 0x08` (`4 bpp + CLUT`), `clutBnum = 44` (`16×1`), `imgW = 24`, `imgH = 96` oraz dokładny rozmiar rozpakowanego bufora `4 672 B = 8 + 44 + (12 + 24 * 96 * 2)`. W polu `img.bnum` zapisano jednak `9 228 = 12 + 2 * 24 * 96 * 2` (podwojony rozmiar danych pikseli, `o +4 608 B` za dużo). Parser M4.3 powinien akceptować ten wariant, gdy `imgOff + 12 + imgW * imgH * 2 === stream.byteLength`.

### 3. Pozostałe rodziny plików w `GT2.VOL` (pełne pokrycie `11 578` wpisów)

| Rozszerzenie (zewn. / wewn.) | Kompresja | Sygnatura magic (hex / ASCII) | Liczba plików | Zakres rozmiaru | Rola / uwagi | Pewność |
| --- | --- | --- | --- | --- | --- | --- |
| `.es` | brak | `45 4E 47 4E` (`"ENGN"`) | `2 747` | `4 080–90 080 B` | Dane dźwięku silnika (zakres M11) | **E1** |
| `.cdo.gz` / `.cno.gz` | gzip (1 człon) | `47 54 02 00` (`"GT\x02\x00"`) | `2 220` (`1 110` + `1 110`) | `11 048–20 000 B` | Modele 3D aut dzień/noc (`100% <= 0x5000`, Załącznik D.1; zakres M6) | **E3** (magic/limit) / **E2** (układ) |
| `.tro.gz` | gzip (1 człon) | `40 28 23 29 47 54 2D 50` (`"@(#)GT-P"`) | `126` | `77 768–696 792 B` | Geometria torów (zakres M8) | **E1** |
| `.bso.gz` | gzip (1 człon) | `42 47 00 00` (`"BG\0\0"`) | `34` | `7 232–22 096 B` | Obiekty tła / nieba (zakres M8) | **E1** |
| `.dat.gz` | gzip (1 człon) | `47 54 44 54` (`"GTDT"`, `22` pliki), `WSDB` pod `0x04` (`7` plików) i inne (`10`) | `39` | `32–776 504 B` | Pliki bazy danych (`GTDT`, `WSDB` — **E3** w M5.1) oraz pliki menu (`10`, **E0**/**E1**) | **E3** (`GTDT`/`WSDB`) / **E1** (pozostałe) |
| `(none)` (pozostałe) | `18` surowych + `3` gzip | m.in. `06 00 0A 00` (`7`), `CAR\0` (`3`), `UCAR` (`3`) | `21` | `2 652–348 160 B` | Różne pliki systemowe/danych bez rozszerzenia | **E0** / **E1** |
| `.seq` | brak | `53 45 51 47` (`"SEQG"`) | `10` | `4 267–23 755 B` | Sekwencje muzyczne/audio (zakres M11) | **E1** |
| `.idx` | brak | `uint32` LE `count` + `uint32[count + 1]` | `6` | `1 840–13 552 B` | Tablice offsetów kontenerów menu (`1` × `aligned-2048` dla `GTMP` = `458` bloków; `5` × `mangled-4` dla `.dat` `GM\x03\x00` = `16 914` członów) | **E3** |
| `.ins` | brak | `49 4E 53 54` (`"INST"`) | `5` | `34 600–383 296 B` | Banki instrumentów audio (zakres M11) | **E1** |
| `.gmr.gz` / `.gmr` | `4` gzip + `1` surowy | `53 43 13 ??` | `5` | `40 960–122 880 B` | Nieznany format (najprawdopodobniej dane powtórek/bazy) | **E0** |
| `.000` / `.999` | brak | `(pusty)` | `6` (`3` + `3`) | `0 B` | Puste wpisy znacznikowe `0 B` | **E3** |
| `.dat` (surowy, nie-GTMP), `.tsd.gz`, `.arc`, `.txd`, `(none).gz` | `2` gzip + `3` surowe | różne (`80000000`, `@(#)GT-A`, `Lap\0`, `5A000A00`, `0B000000`) | `5` | `28 760–159 072 B` | Pojedyncze pliki pomocnicze | **E0** |

---

## PS1 TIM Image Format (`src/formats/tim/`)

- **Confidence:** **E3** (`4 bpp`, `8 bpp`, `16 bpp`, CLUT, and doubled-`img.bnum` quirk verified across `3,729 / 3,729` TIM images in `GT2.VOL`, `0` false positives); **E2** (`24 bpp` per PSX-SPX, tested on synthetic buffers).
- **Endianness:** Little-endian (`DataView(..., true)`).

| Offset | Size | Type | Name / Meaning | Confidence |
| --- | --- | --- | --- | --- |
| `0x00` | 4 B | `uint32` LE | `magic`: `0x00000010` (`10 00 00 00`) | **E3** |
| `0x04` | 4 B | `uint32` LE | `flags`: bits `0..1` = pixel mode (`0` = 4 bpp, `1` = 8 bpp, `2` = 16 bpp, `3` = 24 bpp); bit `3` (`0x08`) = has CLUT; all other bits `0` (`flags & ~0x0B === 0`) | **E3** (`0,1,2`) / **E2** (`3`) |
| `0x08` | variable | `TimBlock` | Optional CLUT block (`if flags & 0x08`): `uint32 bnum` (`12 + clutW * clutH * 2`), `uint16 vramX, vramY, clutW, clutH`, followed by `clutH` row palettes of `clutW` 15-bit `A1B5G5R5` LE words | **E3** |
| `0x08` or after CLUT | variable | `TimBlock` | Image block: `uint32 bnum`, `uint16 vramX, vramY, vramW, height`, followed by `vramW * height * 2` pixel bytes | **E3** |

- **VRAM Word Width → Pixel Width (**E3** / **E2**):**
  - `4 bpp` (`pmode 0`): `pixelWidth = vramW * 4` (low nibble = even pixel, high nibble = odd pixel).
  - `8 bpp` (`pmode 1`): `pixelWidth = vramW * 2`.
  - `16 bpp` (`pmode 2`): `pixelWidth = vramW` (`A1B5G5R5` LE).
  - `24 bpp` (`pmode 3`): `pixelWidth = (vramW * 2) / 3` (**E2**, `RGB888`, requires `(vramW * 2) % 3 === 0`).
- **GT2 `.tim.gz` Anomaly (**E3**):** `34 / 129` `.tim.gz` files (`4 bpp + CLUT`, `24×96`) record `img.bnum = 12 + 2 * vramW * height * 2` (`9,228`) while the decompressed buffer ends cleanly at `imgOff + 12 + vramW * height * 2` (`4,672 B`). Accepted with an explicit parser warning when `imgOff + expectedImgBnum === byteLength`.

---

## GT2 Menu Image Formats: `.idx`, `GM\x03\x00`, and `GTMP` (`src/formats/gtimg/`)

- **Confidence:** **E3** (reimplemented from `adeyblue/GTVolTools` MIT reference code `GTMP/GMImage.cs`, `GTMP/GTMPImage.cs`, `GTMP/GT2Common.cs`, and verified against `6/6` `.idx` tables, `16,914/16,914` `GM\x03\x00` images, and `458/458` `GTMP` blocks in `GT2.VOL`).
- **Shared Canvas & Tiling (**E3**):** Canvas is `512 × 504` px composed from `16 × 8` px tiles stored in a 512 px wide row-major sheet (`32` tiles per row).

### 1. `.idx` Offset Tables (`6 / 6`, **E3**)

| Offset | Size | Type | Name / Meaning | Confidence |
| --- | --- | --- | --- | --- |
| `0x00` | 4 B | `uint32` LE | `count`: number of entries (`458` for `GTMP`; `3,379–3,386` per `GM` `.dat`) | **E3** |
| `0x04` | `(count + 1) * 4` B | `uint32[]` LE | `rawOffsets`: `count` entry start offsets + trailing sentinel `datSize` | **E3** |

- **`aligned-2048` mode (`GTMP`):** `offset = rawOffsets[i]`, `tail = 0`, `size = rawOffsets[i + 1] - offset`.
- **`mangled-4` mode (`GM` gzip containers):** `offset = (rawOffsets[i] & ~3) >>> 0`, `tail = rawOffsets[i] & 3` (trailing zero-padding bytes), `compressedSize = ((rawOffsets[i + 1] & ~3) >>> 0) - offset - tail`.

### 2. `GM\x03\x00` Menu Foreground (`16,914 / 16,914`, **E3**)

| Offset | Size | Type | Name / Meaning | Confidence |
| --- | --- | --- | --- | --- |
| `0x00` | 4 B | `char[4]` | Magic `"GM\x03\x00"` (`47 4D 03 00`) | **E3** |
| `0x04` | 4 B | `uint32` LE | `subBlockSets` (observed `0..4`: `4239, 280, 2940, 9330, 125`) | **E3** |
| `0x08` | variable | `SubBlock[subBlockSets]` | Per group: `uint16 numIcons`, `uint16 numInfoBoxes`, `numIcons × 0x0C` B `IconImageBox` (`unk_0x08` observed `0x000b` **E0**), `numInfoBoxes × 0x4C` B `InfoBox` | **E3** / **E0** (`IconImageBox.unk_0x08`) |
| after groups | `4 + N * 0x4C` B | `uint32` + `InfoBox[]` | `numMainInfoBoxes` + `InfoBox` array (`group = -1`) | **E3** |
| after main boxes | 12 B | `GmScreenMetadata` | `int8 manufacturerId`, `uint8 screenBehaviour` (`3` = `backLinkToPreviousScreen`; observed `0, 2, 3`), `int16 music`, `int32 backLink`, `int32 backgroundIndex` (`0..457` into `GTMP`) | **E3** |
| after metadata | 8 B | `char[4]` + `uint32` | `"GMLL"` (`47 4D 4C 4C`) marker + `numPositionEntries` | **E3** |
| after `GMLL` hdr | `numPositionEntries * 4` B | `TilePlacement[]` | `uint8 xRaw` (`x = (xRaw & 0x1F) * 16`, `solidFlags = (xRaw & 0xE0) >>> 5`), `uint8 yRaw` (`y = yRaw * 8`), `uint16 tileAndPal` (tile: `tile = & 0x03FF`, `pal = >>> 11` in `0..31`; solid: 15-bit color) | **E3** |
| after positions | `0x400` B | `uint16[32][16]` LE | `32` 16-color palettes (`A1B5G5R5` LE; non-zero colors have bit `15 === 0` in `1,173,912 / 1,173,912` words) | **E3** |
| after palettes | 4 B | `uint32` LE | `tileCount` (`> 0`, max `1,016` observed) | **E3** |
| after `tileCount` | `ceil(tileCount / 32) * 2048` B | `uint8[]` | `4 bpp` packed tile sheet (`512` px wide, even pixel = low nibble, odd = high nibble); `419/16,914` files carry trailing padding bytes after the last tile row | **E3** |

- **`GM` Color Rule (`gmColor15ToRgba`, **E3**):** `0x0000` → transparent `(0,0,0,0)`; `0x8000` → opaque black `(0,0,0,255)`; any non-zero `(word & 0x7FFF) !== 0` toggles bit 15 (`bit 15 === 0` → `a = 255`, `bit 15 === 1` → `a = 0`).

### 3. `GTMP` Menu Background (`458 / 458`, **E3**)

| Offset | Size | Type | Name / Meaning | Confidence |
| --- | --- | --- | --- | --- |
| `0x0000` | 4 B | `char[4]` | Magic `"GTMP"` (`47 54 4D 50`) | **E3** |
| `0x0004` | `0x1F80` B | `TilePlacement[2016]` | `2,016` tile placements (`x = (xRaw & 0x1F) * 16`, `solidFlags = (xRaw & 0xE0) >>> 5`, `y = yRaw * 8`, `tileAndPal` tile: `& 0x0FFF`, `pal = >>> 12` in `0..15`; solid: 15-bit color) | **E3** |
| `0x1F84` | `0x2000` B | `uint16[16][256]` LE | `16` 256-color palettes (`A1B5G5R5` LE; `0 / 1,875,968` non-zero words lack bit 15) | **E3** |
| `0x3F84` | `0x7C` B | `uint8[124]` | `unk_0x3f84`: ignored by reference decoder; `u32[0x3f84] === u32[0x3f88]` empirically matches non-empty tile count across `458 / 458` blocks (**E1**), remaining bytes **E0** | **E0** / **E1** |
| `0x4000` | `N * 4096` B | `uint8[]` | `8 bpp` tile sheet (`512` px wide, `N >= 1` rows of `32` tiles × `16×8` px, `100%` multiple of `4096 B`) | **E3** |

- **`GTMP` Color Rule (`gtmpColor15ToRgba`, **E3**):** Palette entries decode opaque when bit 15 is set (`(word & 0x8000) !== 0 ? 255 : 0`); solid-color tile placements (`solidFlags !== 0`, `609,537` instances with bit 15 = 0) are forced opaque (`a = 255`). Canvas base initializes to opaque black `(0, 0, 0, 255)`.

---

## GT2 Game Database Formats: `GTDT` and `WSDB` (`src/formats/gtdb/`)

- **Confidence:** **E3** (`GTDT` container header, 31-slot `gtmode_data` table layout, 4-slot `gtmode_race` layout, and 24 `structs.h` element sizes verified across all `7/7` standard car-DB and `7/7` race-DB variants in `local_assets/GT2.VOL`; `WSDB` header verified across `7/7` string DBs); **E1** (`formatFlag` semantics and `arcade_data`/`license_data` trailing tables); **E0** (`unk_section_02`, `unk_section_24..29`).
- **Reference Source:** `adeyblue/GTVolTools` (`GT2DataExploder/structs.h`, `GT2DataExploder/main.cpp`, MIT License).
- **Endianness:** Little-endian (`DataView(..., true)`) (**E3**).

### 1. Archive Distribution & Compression (**E3**)

All `29 / 29` entries in the database directory of verified `GT2.VOL` are single-member RFC 1952 gzip streams (`1F 8B 08`) that decompress cleanly with valid CRC-32 and ISIZE:

| Pattern (`(<region>_)?...`) | Detected Regional Prefixes | Count | Unpacked Size Range | Container Magic | Confidence |
| --- | --- | --- | --- | --- | --- |
| `(<region>_)?gtmode_data.dat.gz` | `(none)` (JP), `usa`, `eng`, `fra`, `ger`, `ita`, `spa` | `7` | `765,516–776,504 B` (`5` PAL variants byte-identical) | `"GTDT"` (`pairCount = 62`) | **E3** |
| `(<region>_)?gtmode_race.dat.gz` | `(none)` (JP), `usa`, `eng`, `fra`, `ger`, `ita`, `spa` | `7` | `169,606–171,334 B` (`5` PAL variants byte-identical) | `"GTDT"` (`pairCount = 6`) | **E3** |
| `(<region>_)?arcade_data.dat.gz` | `(none)`, `eng`, `usa` | `3` | `41,250 B` | `"GTDT"` (`pairCount = 68`) | **E3** (header) / **E1** (extra tables) |
| `(<region>_)?license_data.dat.gz` | `(none)`, `eng`, `usa` | `3` | `36,432 B` | `"GTDT"` (`pairCount = 64`) | **E3** (header) / **E2** (`LicenseTestInfo`) |
| `*_dev.dat.gz` (`gtmode_data_dev`, `gtmode_race_dev`) | `(none)` | `2` | `32–315,006 B` | `"GTDT"` (`pairCount = 31` / `3`) | **E1** (ASCII dev part names / empty stub) |
| `(<region>_)unistrdb.dat.gz` | `eng`, `fra`, `ger`, `ita`, `jpn`, `spa`, `usa` | `7` | `16,128–22,020 B` | `"WSDB"` at `0x04` | **E3** (header) / **E2** (records, M5.4) |

### 2. `GTDT` Container Header & Directory (**E3**)

| Offset | Size | Type | Name / Meaning | Confidence |
| --- | --- | --- | --- | --- |
| `0x00` | 4 B | `char[4]` | Magic `"GTDT"` (`47 54 44 54`) | **E3** |
| `0x04` | 2 B | `uint16` LE | `formatFlag`: observed `0x006C` (`'l', '\0'`) across `22/22` `GTDT` files (`GT2DataExploder/main.cpp` comment misread `'l'` as `'1'`) | **E3** (value) / **E1** (meaning) |
| `0x06` | 2 B | `uint16` LE | `pairCount`: number of 8-byte `(offset, size)` pairs in the directory (`8 + pairCount * 8 === firstNonEmptyOffset` on `21/21` non-empty `GTDT` files and `8 + 3 * 8 === 32 === unpackedSize` on empty `gtmode_race_dev`). Note: `GT2DataExploder/main.cpp` halved this field (`numShorts / 2`), which only worked on `gtmode_data` because trailing pairs `31..61` are all `(0, 0)`. | **E3** |
| `0x08` | `pairCount * 8` B | `GtdtPair[]` | Sequential `{ uint32 LE offset, uint32 LE size }` records; unused slots store `(0, 0)` | **E3** |

### 3. `(<region>_)?gtmode_data.dat.gz` 31-Table Layout (`pairCount = 62`, **E3**)

Slots `0..30` are packed contiguously (`gap = 0` between adjacent tables, `finalEnd === unpackedSize` for `7/7` variants), while slots `31..61` are `(0, 0)` across all `7/7` variants. Every named `structs.h` table passes `size % elementSize === 0` with `0` remainder mismatches across all `7` regional variants (`621` PAL / `618` USA / `613` JP cars; `CarDimensions`, `CarEngineData`, `CarDrivetrain`, and `CarData` match car counts `1:1`; `CarTyres` and `CarRearTyres` match `4720` / `4696` / `4661`):

| Index | Table Name (`structs.h`) | Element Size | Record Count (PAL / USA / JP) | Confidence |
| --- | --- | --- | --- | --- |
| `0` | `CarBrakes` | `0x0C` (12 B) | `1149` / `1142` / `1133` | **E3** |
| `1` | `CarBrakeBalanceController` | `0x10` (16 B) | `534` / `531` / `526` | **E3** |
| `2` | `unk_section_02` (`ParseNothing`) | `null` (24 B total) | `null` | **E0** (`steering` hint in `structs.h` **E1**) |
| `3` | `CarDimensions` | `0x14` (20 B) | `621` / `618` / `613` | **E3** |
| `4` | `CarWeightReduction` | `0x0C` (12 B) | `1606` / `1597` / `1582` | **E3** |
| `5` | `CarRacingModification` | `0x1C` (28 B) | `1056` / `1051` / `1041` | **E3** |
| `6` | `CarEngineData` | `0x4C` (76 B) | `621` / `618` / `613` | **E3** |
| `7` | `CarPortGrinding` | `0x0C` (12 B) | `529` / `526` / `521` | **E3** |
| `8` | `CarEngineBalancing` | `0x0C` (12 B) | `529` / `526` / `521` | **E3** |
| `9` | `CarDisplacementIncrease` | `0x0C` (12 B) | `29` / `29` / `29` | **E3** |
| `10` | `CarChip` | `0x0C` (12 B) | `529` / `526` / `521` | **E3** |
| `11` | `CarNATuning` | `0x0C` (12 B) | `615` / `612` / `600` | **E3** |
| `12` | `CarTurboTuning` | `0x14` (20 B) | `1166` / `1158` / `1153` | **E3** |
| `13` | `CarDrivetrain` | `0x10` (16 B) | `621` / `618` / `613` | **E3** |
| `14` | `CarFlywheel` | `0x0C` (12 B) | `1579` / `1570` / `1555` | **E3** |
| `15` | `CarClutch` | `0x10` (16 B) | `2199` / `2187` / `2167` | **E3** |
| `16` | `CarPropShaft` | `0x0C` (12 B) | `308` / `306` / `301` | **E3** |
| `17` | `CarGearbox` | `0x24` (36 B) | `2217` / `2205` / `2185` | **E3** |
| `18` | `CarSuspension` | `0x4C` (76 B) | `2211` / `2199` / `2179` | **E3** |
| `19` | `CarIntercooler` | `0x0C` (12 B) | `397` / `393` / `391` | **E3** |
| `20` | `CarMuffler` | `0x0C` (12 B) | `1579` / `1570` / `1555` | **E3** |
| `21` | `CarLSD` | `0x20` (32 B) | `2346` / `2331` / `2306` | **E3** |
| `22` | `CarTyres` | `0x10` (16 B) | `4720` / `4696` / `4661` | **E3** |
| `23` | `CarRearTyres` | `0x0C` (12 B) | `4720` / `4696` / `4661` | **E3** |
| `24` | `unk_section_24` (`ParseNothing`) | `null` (868 B) | `null` | **E0** |
| `25` | `unk_section_25` (`ParseNothing`) | `null` (1,280 B) | `null` | **E0** |
| `26` | `unk_section_26` (`ParseNothing`) | `null` (8 B) | `null` | **E0** |
| `27` | `unk_section_27` (`ParseNothing`) | `null` (48 B) | `null` | **E0** |
| `28` | `unk_section_28` (`ParseNothing`) | `null` (48 B) | `null` | **E0** |
| `29` | `unk_section_29` (`ParseNothing`) | `null` (1,576 B) | `null` | **E0** |
| `30` | `CarData` | `0x48` (72 B) | `621` / `618` / `613` | **E3** |

### 4. Other `GTDT` Families (`gtmode_race`, `license_data`, `arcade_data`, `*_dev`)

- **`(<region>_)?gtmode_race.dat.gz` (`pairCount = 6`, **E3**):**
  - `[0]` `RaceInfo` (`0x9C` / 156 B, `248` races across `7/7` variants).
  - `[1]` `OpponentInfo` (`0x60` / 96 B, `1,228` PAL / `1,220` USA / `1,210` JP).
  - `[2]` `RestrictedCars` (`0x80` / 128 B fixed blocks of `int32[32]`, `94` blocks across `7/7` variants).
  - `[3]` `RaceStrings` (`2,670 B` across `7/7` variants, `offset + size === unpackedSize`; variable-length length-prefixed ASCII strings).
  - `[4..5]` empty `(0, 0)`.
- **`(<region>_)?license_data.dat.gz` (`pairCount = 64`):** slots `0..29` match the exact same 30 part struct sizes as `gtmode_data` (`0` mismatches); slot `[30]` is `LicenseTestInfo` (`0x9C` / 156 B, `60` entries), `[31]` is `OpponentInfo` (`0x60` / 96 B, `53` entries), `[62]` is a `876 B` string table ending at exact EOF (`36,432 B`), all other slots `(0, 0)`.
- **`(<region>_)?arcade_data.dat.gz` (`pairCount = 68`):** slots `0..29` match the exact same 30 part struct sizes (`0` mismatches); slots `[30..33]` hold arcade tables (`2,340 B`, `3,648 B`, `3,780 B`, `3,780 B`), `[64]` holds an `86 B` string table ending at exact EOF (`41,250 B`).
- **`*_dev.dat.gz` (`2` files):** single-half `pairCount` (`31` / `3`) storing developer ASCII part codes (e.g., length-prefixed part name strings) rather than binary car structs.

### 5. Verified `gtmode_data` Car Struct Layouts (M5.3)

All structs are packed (`#include <pshpack1.h>`) little-endian records matching `C_ASSERT` sizes in `GT2DataExploder/structs.h` (`adeyblue/GTVolTools`, MIT License). `carId` is decoded as unsigned `uint32` LE (`E3`). Across all `7/7` regional variants (`621` PAL / `618` USA / `613` JP cars), the `carId` sets of `CarDimensions`, `CarEngineData`, `CarGearbox`, `CarSuspension`, `CarTyres`, `CarRearTyres`, and `CarData` match `100%` (`0` orphan or missing IDs).

#### 5.1 `CarDimensions` (`0x14` / 20 B, slot `3`, **E3** structure)

| Offset | Size | Type | Field | Notes / Meaning | Confidence |
| --- | --- | --- | --- | --- | --- |
| `0x00` | 4 B | `uint32` LE | `carId` | Numeric car identifier | **E3** |
| `0x04` | 4 B | `uint32` LE | `unk_0x04` | `unk` in `structs.h` | **E0** |
| `0x08` | 2 B | `uint16` LE | `length` | Vehicle length in mm (observed `2790–5537`) | **E3** |
| `0x0A` | 2 B | `uint16` LE | `height` | Vehicle height in mm (observed `1016–1773`) | **E3** |
| `0x0C` | 2 B | `uint16` LE | `unk_0x0c` | `unk2` in `structs.h` (GT3 wheelbase note unconfirmed for GT2) | **E0** |
| `0x0E` | 2 B | `uint16` LE | `weightKg` | Stock vehicle weight in kg (`weight`; observed `425–2055`) | **E3** |
| `0x10` | 1 B | `uint8` | `rmWeightMultiplier` | Racing modification weight multiplier (`rmWeightMultipier`; observed `17–79`) | **E3** |
| `0x11` | 1 B | `uint8` | `unk_0x11` | `unk4` in `structs.h` | **E0** |
| `0x12` | 2 B | `uint16` LE | `unk_0x12` | `unk5` in `structs.h` | **E0** |

#### 5.2 `CarEngineData` (`0x4C` / 76 B, slot `6`, **E3** structure)

| Offset | Size | Type | Field | Notes / Meaning | Confidence |
| --- | --- | --- | --- | --- | --- |
| `0x00` | 4 B | `uint32` LE | `carId` | Numeric car identifier | **E3** |
| `0x04` | 2 B | `uint16` LE | `engineTypeNameIndex` | Index into `unistrdb` (`engineTypeName`) | **E2** |
| `0x06` | 2 B | `uint16` LE | `engineTypeName2Index` | Index into `unistrdb` (`engineTypeName2`) | **E2** |
| `0x08` | 2 B | `uint16` LE | `unk_0x08` | `unk3` in `structs.h` | **E0** |
| `0x0A` | 2 B | `uint16` LE | `unk_0x0a` | `unk4` in `structs.h` | **E0** |
| `0x0C` | 32 B | `uint16[16]` LE | `bandAcceleration` | Torque/power curve sample values (`0xFFFF` = unused) | **E2** |
| `0x2C` | 2 B | `uint16` LE | `engineCc` | Nominal displacement in cc (observed `0–25230`) | **E3** |
| `0x2E` | 2 B | `uint16` LE | `ps` | Base power in PS (observed `23–1030`) | **E3** |
| `0x30` | 2 B | `uint16` LE | `maxPowerRpmRaw` | Peak power RPM ÷ 10 (observed `0–1200`) | **E3** |
| `0x32` | 2 B | `uint16` LE | `torqueKgmRaw` | Peak torque in kg·m × 10 (observed `0–954`) | **E3** |
| `0x34` | 2 B | `uint16` LE | `torqueRpmStringIndex` | Index into `unistrdb` (`torqueRPM`) | **E2** |
| `0x36` | 5 B | `uint8[5]` | `baseUnits` | `CalculateRealPS` inputs (`[0],[3],[4]` confirmed in disassembly; `[1],[2]` unconfirmed) | **E2** |
| `0x3B` | 16 B | `uint8[16]` | `bandRpms` | Sample RPMs ÷ 100 (`0xFF` = unused) | **E2** |
| `0x4B` | 1 B | `uint8` | `bandPointCount` | Active point count in `bandAcceleration` / `bandRpms` (`significantUnks` in `structs.h`; observed `7–16`) | **E2** |

#### 5.3 `CarGearbox` (`0x24` / 36 B, slot `17`, **E3** structure)

| Offset | Size | Type | Field | Notes / Meaning | Confidence |
| --- | --- | --- | --- | --- | --- |
| `0x00` | 4 B | `uint32` LE | `carId` | Numeric car identifier | **E3** |
| `0x04` | 4 B | `int32` LE | `price` | Purchase price (observed `0–11000`) | **E3** |
| `0x08` | 1 B | `uint8` | `type` | `0` = Stock/NA, `1` = Close, `2` = Super Close, `3` = Fully Customised (observed `0–3`) | **E3** |
| `0x09` | 1 B | `uint8` | `unk_0x09` | `unk1` in `structs.h` | **E0** |
| `0x0A` | 16 B | `uint8[16]` | `unk_0x0a` | `unk2[16]` in `structs.h` (individual gear ratios unconfirmed) | **E0** |
| `0x1A` | 2 B | `uint16` LE | `finalGear` | Final drive ratio (observed `2430–6666`) | **E3** |
| `0x1C` | 4 B | `int32` LE | `unk_0x1c` | `unk3` in `structs.h` | **E0** |
| `0x20` | 4 B | `int32` LE | `unk_0x20` | `unk4` in `structs.h` | **E0** |

#### 5.4 `CarSuspension` (`0x4C` / 76 B, slot `18`, **E3** structure)

| Offset | Size | Type | Field | Notes / Meaning | Confidence |
| --- | --- | --- | --- | --- | --- |
| `0x00` | 4 B | `uint32` LE | `carId` | Numeric car identifier | **E3** |
| `0x04` | 4 B | `int32` LE | `price` | Purchase price (observed `0–20000`) | **E3** |
| `0x08` | 1 B | `uint8` | `stage` | `0` = Stock/NA, `1` = Sports, `2` = Semi-Racing, `3` = Professional (observed `0–3`) | **E3** |
| `0x09` | 1 B | `uint8` | `unk_0x09` | `unk1` in `structs.h` | **E0** |
| `0x0A` | 2 B | `uint16` LE | `unk_0x0a` | `unk2` in `structs.h` | **E0** |
| `0x0C` | 64 B | `uint8[64]` | `unk_0x0c` | `unk3[0x4C - 0x0C]` in `structs.h` | **E0** |

#### 5.5 `CarTyres` (`0x10` / 16 B, slot `22`) and `CarRearTyres` (`0x0C` / 12 B, slot `23`)

Note: Unlike `CarTyres`, `CarRearTyres` is `12` bytes (`0x0C`) and **omits the 4-byte `price` field**, shifting all subsequent offsets by `-4` bytes.

| Struct | Offset | Size | Type | Field | Notes / Meaning | Confidence |
| --- | --- | --- | --- | --- | --- | --- |
| `CarTyres` | `0x00` | 4 B | `uint32` LE | `carId` | Numeric car identifier | **E3** |
| `CarTyres` | `0x04` | 4 B | `int32` LE | `price` | Purchase price (observed `0–18000`) | **E3** |
| `CarTyres` | `0x08` | 1 B | `uint8` | `type` | `0..7` (Stock/Sports/Hard/Medium/Soft/Super Soft/Sim/Dirt) | **E3** |
| `CarTyres` | `0x09` | 1 B | `uint8` | `unk_0x09` | `unk1` in `structs.h` (observed `0`) | **E0** |
| `CarTyres` | `0x0A` | 2 B | `uint16` LE | `unk_0x0a` | `unk2` in `structs.h` | **E0** |
| `CarTyres` | `0x0C` | 4 B | `uint32` LE | `unk_0x0c` | `unk3` in `structs.h` | **E0** |
| `CarRearTyres` | `0x00` | 4 B | `uint32` LE | `carId` | Numeric car identifier | **E3** |
| `CarRearTyres` | `0x04` | 1 B | `uint8` | `type` | `0..7` (Stock..Dirt) | **E3** |
| `CarRearTyres` | `0x05` | 1 B | `uint8` | `unk_0x05` | `unk1` in `structs.h` (observed `0`) | **E0** |
| `CarRearTyres` | `0x06` | 2 B | `uint16` LE | `unk_0x06` | `unk2` in `structs.h` | **E0** |
| `CarRearTyres` | `0x08` | 4 B | `uint32` LE | `unk_0x08` | `unk3` in `structs.h` | **E0** |

#### 5.6 `CarData` (`0x48` / 72 B, slot `30`, **E3** structure)

Important `structs.h` discrepancies resolved during M5.3:
- Offset `0x0E` is named `weightDistribution` in `CarData` but `rmPartId` in `OpponentInfo`; observed values (`0–1054`) match `CarRacingModification` count (`1056`) rather than weight distribution, so it is kept as `unk_0x0e` (**E0**).
- Source offset comments `16` (`unk5`) and `1a` (`naPart`) in `structs.h` are off under `#include <pshpack1.h>`; actual byte offsets are `0x14` and `0x18` (with `0x18` observed `0` across `100%` of records and doubted by the original author), so both are `unk_0x14` / `unk_0x18` (**E0**).

| Offset | Size | Type | Field | Notes / Meaning | Confidence |
| --- | --- | --- | --- | --- | --- |
| `0x00` | 4 B | `uint32` LE | `carId` | Numeric car identifier | **E3** |
| `0x04` | 2 B | `int16` LE | `brakePart` | Default `CarBrakes` index (`0–1147` PAL) | **E3** |
| `0x06` | 4 B | `int32` LE | `specialCar` | `1` = special car, `0` = normal (`88` special cars in PAL) | **E3** |
| `0x0A` | 2 B | `uint16` LE | `weightPartId` | `CarDimensions` / weight part index (`0–620` PAL) | **E3** |
| `0x0C` | 2 B | `uint16` LE | `unk_0x0c` | `unk3` in `structs.h` (observed `0`) | **E0** |
| `0x0E` | 2 B | `uint16` LE | `unk_0x0e` | Conflicting `weightDistribution` / `rmPartId` in `structs.h` (`0–1054` PAL) | **E0** |
| `0x10` | 2 B | `uint16` LE | `enginePartId` | `CarEngineData` index (`0–620` PAL) | **E3** |
| `0x12` | 2 B | `uint16` LE | `unk_0x12` | `unk4` in `structs.h` (observed `0`) | **E0** |
| `0x14` | 4 B | `int32` LE | `unk_0x14` | `unk5` in `structs.h` (comment `16` inaccurate; observed `0`) | **E0** |
| `0x18` | 4 B | `int32` LE | `unk_0x18` | `naPart` in `structs.h` (comment `1a` inaccurate; observed `0`) | **E0** |
| `0x1C` | 2 B | `uint16` LE | `turboPart` | `CarTurboTuning` index (`0–1165` PAL) | **E3** |
| `0x1E` | 2 B | `uint16` LE | `drivetrainPart` | `CarDrivetrain` index (`0–620` PAL) | **E3** |
| `0x20` | 2 B | `uint16` LE | `flywheel` | `CarFlywheel` index (`0` observed on stock cars) | **E2** |
| `0x22` | 2 B | `uint16` LE | `clutch` | `CarClutch` index (`0–2198` PAL) | **E3** |
| `0x24` | 2 B | `uint16` LE | `unk_0x24` | `unk8` in `structs.h` (observed `0`) | **E0** |
| `0x26` | 2 B | `uint16` LE | `differential` | `CarLSD` index (`0–2345` PAL) | **E3** |
| `0x28` | 2 B | `uint16` LE | `transmission` | `CarGearbox` index (`0–2215` PAL) | **E3** |
| `0x2A` | 2 B | `uint16` LE | `suspension` | `CarSuspension` index (`0–2207` PAL) | **E3** |
| `0x2C` | 4 B | `uint32` LE | `unk_0x2c` | `unk9` in `structs.h` (observed `0`) | **E0** |
| `0x30` | 2 B | `uint16` LE | `frontTyres` | `CarTyres` index (`6–4715` PAL) | **E3** |
| `0x32` | 2 B | `uint16` LE | `rearTyres` | `CarRearTyres` index (`6–4715` PAL) | **E3** |
| `0x34` | 4 B | `uint32` LE | `unk_0x34` | `unk10` in `structs.h` (non-zero on `88` special cars) | **E0** |
| `0x38` | 2 B | `uint16` LE | `rimsCode3` | Stock wheel/rims code (`0–10`) | **E2** |
| `0x3A` | 2 B | `uint16` LE | `manufacturerId` | Manufacturer ID (`0–38`) | **E2** |
| `0x3C` | 2 B | `uint16` LE | `nameFirstPartIndex` | `unistrdb` index (`8–841` PAL) | **E2** |
| `0x3E` | 2 B | `uint16` LE | `nameSecondPartIndex` | `unistrdb` index (`8–845` PAL) | **E2** |
| `0x40` | 1 B | `uint8` | `unk_0x40` | `padding` in `structs.h` (empirically equals `specialCar` on `621/621`) | **E0** |
| `0x41` | 1 B | `uint8` | `year` | 2-digit model year (`0–99`) | **E3** |
| `0x42` | 2 B | `uint16` LE | `unk_0x42` | `unk14` in `structs.h` (observed `0`) | **E0** |
| `0x44` | 4 B | `uint32` LE | `newPrice` | New car price (`2800–2000000`) | **E3** |

### 6. `WSDB` (`(<region>_)unistrdb.dat.gz`) Header Summary (**E3** header / M5.4 deferred)

| Offset | Size | Type | Name / Meaning | Confidence |
| --- | --- | --- | --- | --- |
| `0x00` | 4 B | `uint32` LE | `fileSize`: exact unpacked byte length (`7/7` verified) | **E3** |
| `0x04` | 4 B | `char[4]` | Magic `"WSDB"` (`57 53 44 42`) | **E3** |
| `0x08` | 2 B | `uint16` LE | `numStrings` (`846` PAL, `851` USA, `764` JP) | **E3** |
| `0x0A` | variable | `uint16 len + UTF-16LE chars + 0x0000` | Wide-string records (exact decoder & encoding verification deferred to M5.4) | **E2** |
