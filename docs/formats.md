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
| `.cdo.gz` / `.cno.gz` | gzip (1 człon) | `47 54 02 00` (`"GT\x02\x00"`) | `2 220` (`1 110` + `1 110`) | `11 048–20 000 B` | Modele 3D aut dzień/noc (`100% <= 0x5000`, Załącznik D; zweryfikowane w M6.1–M6.6) | **E3** (CDO/CNO) / **E1** (rekordy cienia) |
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
| `(<region>_)unistrdb.dat.gz` | `eng`, `fra`, `ger`, `ita`, `jpn`, `spa`, `usa` | `7` | `16,128–22,020 B` | `"WSDB"` at `0x04` | **E3** (verified across `7/7` variants in M5.4) |

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

#### 5.7 `CarRacingModification` (`0x1C` / 28 B, slot `5`, **E3** structure)

| Offset | Size | Type | Field | Notes / Meaning | Confidence |
| --- | --- | --- | --- | --- | --- |
| `0x00` | 4 B | `uint32` LE | `carId` | Base car identifier (`1,049 / 1,056` match `CarData.carId` in PAL) | **E3** |
| `0x04` | 4 B | `int32` LE | `price` | Racing modification price (`0–85000`; `621` rows with `0`) | **E3** |
| `0x08` | 4 B | `uint32` LE | `rmBodyId` | 30-bit body asset identifier (`1,056 / 1,056` resolve in `carobj/`; `428` distinct from `carId`) | **E3** |
| `0x0C` | 16 B | `uint8[16]` | `unk_0x0c` | Unverified trailing fields preserved raw | **E0** |

### 6. `WSDB` (`(<region>_)unistrdb.dat.gz`, **E3**)

Verified in M5.4 against `GT2DataExploder/main.cpp` (`ExtractUniStrDb`, `adeyblue/GTVolTools`, MIT License) and all `7/7` unpacked `unistrdb` files (`eng`, `fra`, `ger`, `ita`, `jpn`, `spa`, `usa`) in `local_assets/GT2.VOL`:

| Offset | Size | Type | Name / Meaning | Confidence |
| --- | --- | --- | --- | --- |
| `0x00` | 4 B | `uint32` LE | `fileSize`: exact unpacked byte length (`7/7` match `unpacked.byteLength`, `0` trailing bytes) | **E3** |
| `0x04` | 4 B | `char[4]` | Magic `"WSDB"` (`57 53 44 42`) | **E3** |
| `0x08` | 2 B | `uint16` LE | `numStrings` (`846` PAL `eng/fra/ger/ita/spa`, `851` `usa`, `764` `jpn`) | **E3** |
| `0x0A` | variable | `WsdbRecord[numStrings]` | Sequential records: `uint16 LE charCount`, `uint16 LE[charCount]` UTF-16LE code units, `uint16 LE 0x0000` terminator | **E3** |

- **Character Encoding & Integrity (`7/7` variants, **E3**):** Pure BMP **UTF-16LE** (`0` UTF-16 surrogates, `0` embedded nulls, `0` control characters `< 0x20` or `0x7F`, `0` non-zero terminators). `eng` uses ASCII (`maxCodeUnit = 0x7a`); European variants include Latin accents/punctuation (up to `0x2019`); `jpn` includes CJK/Kana characters (`2,741` non-ASCII code units, up to `0x96e8`).
- **Empty String Entries (**E3**):** Each variant contains exactly `1` empty entry (`charCount === 0`, preserved as `""`, at index `195` in PAL/USA and `140` in `jpn`), referenced by `CarData.nameSecondPartIndex` on single-part names (`57` PAL / `55` USA / `367` JP).
- **Database Index Validation (**E3**):** `100%` of `CarData.nameFirstPartIndex` (`> 0` length), `CarData.nameSecondPartIndex`, and `CarEngineData` string indices (`engineTypeNameIndex`, `engineTypeName2Index`, `torqueRpmStringIndex` — all non-empty) resolve within `[0, numStrings)` across all `7/7` variants.

### 7. `carId (uint32)` ↔ VOL Asset Mapping (`src/formats/gtdb/carId.ts`)

- **Confidence:** **E3** for 30-bit `carId` ↔ 5-character stem encoding and `.cdo`/`.cno`/`.cdp`/`.cnp` resolution; **E1** for `.es` audio stem patterns (deferred to M11).
- **Reference Source:** `adeyblue/GTVolTools` (`GTMP/GMImage.cs:CarNameConversion`, MIT License).

#### 7.1 Bit-Packed 5-Character Encoding (**E3**)

`carId` (`uint32` LE) encodes a 5-character lowercase stem `[c0, c1, c2, c3, c4]` (`30` active bits, MSB-first, bits `30..31` always `0`):

```text
CAR_ID_CHARSET = "-0123456789abcdefghijklmnopqrstuvwxyz"   (37 symbols, index 0..36)

decodeCarId(carId):
  c4 = charset[(carId >>>  0) & 0x3F]
  c3 = charset[(carId >>>  6) & 0x3F]
  c2 = charset[(carId >>> 12) & 0x3F]
  c1 = charset[(carId >>> 18) & 0x3F]
  c0 = charset[(carId >>> 24) & 0x3F]
  code = c0 + c1 + c2 + c3 + c4

encodeCarId(code):
  carId = Σ_{i=0..4} (charset.indexOf(code[i]) << ((4 - i) * 6))
```

#### 7.2 VOL Car & Parameter Linkage Table (`local_assets/GT2.VOL`, M6.11)

| Directory / Path Pattern | Entries | Format / Compression | DB Linkage & Coverage (`PAL` / `USA` / `JP`) | Confidence |
| --- | --- | --- | --- | --- |
| `carparam/(<region>_)?gtmode_data.dat.gz` (+ `gtmode_race`, `unistrdb`, `arcade_data`, `license_data`, `*_dev`) | `29` | `GTDT` / `WSDB` (`gzip`) | Primary car/part/race tables (`621` / `618` / `613` cars, `1,056` / `1,051` / `1,041` `CarRacingModification` rows) | **E3** |
| `carobj/<5char>.cdo.gz` & `.cno.gz` | `1,110` + `1,110` | `CDO`/`CNO` (`gzip`) | `CarData.carId` `100.0%` (`621`/`618`/`613`), `CarRacingModification.rmBodyId` `100.0%` (`1,056`/`1,051`/`1,041`); union across all DBs covers `1,072/1,110` stems (`38` unused) | **E3** |
| `carobj/<5char>.cdp.gz` & `.cnp.gz` | `1,110` + `1,110` | `CDP`/`CNP` (`gzip`) | `1:1` stem match with `.cdo.gz`/`.cno.gz` (`100.0%`); `.cdp` header `0x02` stores `1..16` ASCII `[0-9a-z]` paint `colorIds` (`36` symbols) matching `.cnp` `1,110/1,110` | **E3** |
| `.carinfoa`, `.carinfoe`, `.carinfoj` | `3` | `"CAR\0"` + `uint32` count (`1,110`) | Index table of `1,110` `(uint32 carId, uint32 offset)` pairs in strictly ascending `carId` order matching sorted `carobj/` (`1,110/1,110`) | **E1** |
| `.carcolor` | `1` | `"CCOL00\0\0"` + `uint16[1110]` offsets | `1,110` variable-length records in `.carinfo` order; `1,110/1,110` have `recordBytes === cdp.colorCount * 2` (`4,629` `uint16` indices in `0..1163`) | **E1** |
| `.cclatain` & `.ccjapanese` | `2` | `uint16[1164]` offset table + strings | `1,164` null-terminated paint name strings (`1,164/1,164`); `.carcolor` `uint16` values fall strictly in `[0, 1163]` | **E1** |
| `carwheel/<pat>.tim` | `192` | PS1 `TIM` (raw) | Filename patterns `LLDDD--L.tim` (`38`), `LLDDD-DL.tim` (`154`); linkage to `CarData.rimsCode3` unverified | **E1** |
| `carlogo/<pat>.tim` | `3,346` | PS1 `TIM` (raw) | Manufacturer/car logo badges; DB linkage unverified | **E1** |
| `engine/*.es` | `2,747` | `"ENGN"` (raw) | `0` direct 5-char `carId` matches; stems match `DDDDD` (`305`), `DDDDD_LD` (`2,440`), `LLL_L` (`2`) (deferred to M11) | **E1** |

- **Production Rule (§3):** Only **E3**-verified `carparam/*.dat.gz` (`CarData`, `CarRacingModification`, etc.) and `carobj/*.{cdo,cno,cdp,cnp}.gz` paths are used in `CarCatalog` and `CarAssetIndex`. **E1** auxiliary root files (`.carcolor`, `.cclatain`, `.ccjapanese`, `.carinfo*`) are documented for reference only without production coupling.

---

## GT2 Car Model Format: `CDO` / `CNO` (`src/formats/car/cdo/`)

- **Confidence:** **E3** (header, wheel slot order, coordinate system, LOD table, LOD headers, per-LOD `scale` vertex multiplier `2^(scale - 16)`, vertices, packed normals, 4 polygon lists, perimeter quad triangulation `(0,1,2)+(0,2,3)`, uniform single-sided `CCW` winding convention, PS1 4×4 CLUT `paletteRaw` formula, `renderFlags` bit 2 ↔ `paletteIndex === 14` correlation, and shadow header verified across `2,220 / 2,220` decompressed `.cdo.gz`/`.cno.gz` paired with `.cdp.gz`/`.cnp.gz` and `621 / 621` GTDB cars in `local_assets/GT2.VOL`, `tests/unit/cdoRealArchive.test.ts`, `tests/unit/cdoCdpResearchRealArchive.test.ts` & `tests/unit/carModelRealArchive.test.ts`); **E1** (clean-room shadow payload record layout, `renderOrder`, `renderFlags` bit 2 visual meaning); **E0** (`unk_0x04`, `unk_0x10`, `0x40..0x867`, `unk_0x4e`, unused zero bitfields).
- **Clean-room source:** Implemented solely from [ROADMAP.md Appendix D](../ROADMAP.md#załącznik-d-format-aut-gt2-cdocnocdpcnp) and streaming verification against `local_assets/GT2.VOL` (no code copied from `pez2k/gt2tools`).
- **Endianness & Size Limit:** Little-endian (`DataView(..., true)`) (**E3**); uncompressed size `11,048–20,000 B` (`100% <= 0x5000` / `20,480 B`) (**E3**).
- **Coordinate System (**E3**):** Right-handed `1/4096 m` integer grid with **`+X` right, `+Y` up, `-Z` forward** (verified across `2,220` models: wheel `y` averages `+699`, LOD0 `y` spans `[-18, +2850]` on average, and night-illuminated white headlights cluster at `Z < 0` [`4,817` vs `18`] while red taillights cluster at `Z > 0` [`4,480` vs `174`]).

### 1. Fixed Header (`0x00..0x867`, `2,152` bytes)

| Offset | Size | Type | Name / Meaning | Confidence |
| --- | --- | --- | --- | --- |
| `0x00` | 3 B | `uint8[3]` | Magic `"GT\x02"` (`47 54 02`) | **E3** |
| `0x03` | 1 B | `uint8` | `unk_0x03`: observed `0x00` across `2,220 / 2,220` models | **E1** |
| `0x04` | 4 B | `uint32` LE | `unk_0x04`: observed `0x00000000` across `2,220 / 2,220` models | **E0** |
| `0x08` | 8 B | `uint16[4]` LE | `rawWheelDiag0x08`: strictly `[0, 0, 0, 0]` across `2,220 / 2,220` models (`0x18` is the active wheel parameter record in GT2) | **E3** |
| `0x10` | 8 B | `uint16[4]` LE | `unk_0x10`: observed `0` across `2,220 / 2,220` models | **E0** |
| `0x18` | 8 B | `uint16[4]` LE | `menuWheels`: `frontRadius`, `frontWidth`, `rearRadius`, `rearWidth` (`1/4096 m` units; strictly non-zero across `2,220 / 2,220` models) | **E3** |
| `0x20` | 32 B | `4×(4×int16)` LE | `wheelPositions`: `[x, y, z, menuX]` per wheel (`1/4096 m`, `menuX / x ≈ 0.874` in `[0.796, 0.920]`). Verified semantics across `621` GTDB cars (`2,484` wheels): **`x` is the outer tyre face** and **`menuX` is the wheel center** (`|x| - |menuX| = width / 2`, median ratio `1.001`, `2,194 / 2,484 = 88.3%` within `±2 mm`), while **`lod0.boundingBox.low.y ≈ 0.0 m` is the chassis floor/rocker panel** and **`wheel.y - radius` sits below it (`-0.134 m` median ground clearance)**. Verified slot order across `2,220 / 2,220` models: **`[0]` Front-Left (`x<0, z<0`), `[1]` Front-Right (`x>0, z<0`), `[2]` Rear-Left (`x<0, z>0`), `[3]` Rear-Right (`x>0, z>0`)**. | **E3** |
| `0x40` | `0x828` B | `uint8[]` | `unk_0x40`: unknown gap (`0x40..0x867`), explicitly skipped | **E0** |

### 2. LOD Table (`0x868`) & Sequential LOD Header (`0x50` bytes)

- **LOD Directory (`0x868`, **E3**):** `uint32 LE lodCount` (`3` across `2,220 / 2,220` models) + `lodCount × 8 B` entries `{ uint16 zero (0), uint16 maxDistance ([5, 15, 300]), uint32 offset (RAM pointer placeholder) }`. LOD blocks begin at `0x884` and MUST be read sequentially (ignoring non-zero `offset` placeholders).

| Offset in LOD | Size | Type | Name / Meaning | Confidence |
| --- | --- | --- | --- | --- |
| `0x00` | 2 B | `uint16` LE | `vertexCount` (`<= 256` due to 8-bit vertex indices) | **E3** |
| `0x02` | 2 B | `uint16` LE | `normalCount` (`0` in `8` LODs across `4` files; otherwise `> 0`) | **E3** |
| `0x04` | 2 B | `uint16` LE | `triCount` (untextured triangles) | **E3** |
| `0x06` | 2 B | `uint16` LE | `quadCount` (untextured quads) | **E3** |
| `0x08` | 4 B | `uint16[2]` LE | `unk_0x08`: observed `[0, 0]` across `6,660 / 6,660` LODs | **E1** |
| `0x0C` | 2 B | `uint16` LE | `uvTriCount` (UV-textured triangles) | **E3** |
| `0x0E` | 2 B | `uint16` LE | `uvQuadCount` (UV-textured quads) | **E3** |
| `0x10` | 4 B | `uint32` LE | `unk_0x10`: observed `0` across `6,660 / 6,660` LODs | **E1** |
| `0x14` | 40 B | `uint32[10]` LE | `sectionOffsets` RAM pointers (`sectionOffsets[0] === 0x50` across `6,660 / 6,660` LODs) | **E3** |
| `0x3C` | 16 B | `8×int16` LE | `boundingBox`: `low XYZW`, `high XYZW` (`100%` exact match with vertex min/max across `6,660 / 6,660` LODs) | **E3** |
| `0x4C` | 2 B | `uint16` LE | `scale` (observed `14..23`): per-LOD vertex scale shift `2^(scale - 16)` (`621/621` GTDB cars: `515/621` = `17` [`2×`], `106/621` = `16` [`1×`]; length ratio median `0.9999`, wheel-arch fit `1,099/1,110 = 99.0%`; `wheelPositions` `0x20` and `menuWheels` `0x18` remain unshifted `1/4096 m`) | **E3** |
| `0x4E` | 2 B | `uint16` LE | `unk_0x4e`: scale-related value | **E0** |

### 3. LOD Geometry & Polygon Lists (Sequential, No Padding)

1. **Vertices (`vertexCount × 8 B`, **E3**):** `int16 x, y, z, w` LE (`w === 0` across all vertices; per-LOD unit `2^(lod.scale - 16) / 4096 m`).
2. **Packed Normals (`normalCount × 4 B`, **E3**):** `uint32` LE containing three 10-bit two's-complement fields scaled by `/ 500`:
   - `bits 0..1`: `rawLow2Bits` (`0` across `945,187 / 945,187` normals, **E0**),
   - `bits 2..11`: `X`, `bits 12..21`: `Y`, `bits 22..31`: `Z`.
   - Observed lengths across `945,187 / 945,187` normals: `[0.9967, 1.0000]` (`0` outside `±5%`).
3. **Four Polygon Lists in File Order (`16 B` untextured × 2, `28 B` textured × 2, **E3**):**
   - `triangles` (`triCount × 16 B`, `faceType = 32` / `0x20`, `9,854` records),
   - `quads` (`quadCount × 16 B`, `faceType = 40` / `0x28`, `71,188` records),
   - `uvTriangles` (`uvTriCount × 28 B`, `faceType = 37` / `0x25`, `295,480` records),
   - `uvQuads` (`uvQuadCount × 28 B`, `faceType = 45` / `0x2D` [`466,201` records] + modulated variant `faceType = 44` / `0x2C` [`8` records across `2` files, accepted with parser warning]).
   - Base `16 B` layout: `0x00` `uint8[4] v0..v3` (`v3 === 0` for triangles), `0x04` `uint16` (`renderOrder` bits `0..4` [**E1**, observed `15` values `{2, 4, 6, 8, 10, 12, 14, 16, 17, 19, 21, 23, 27, 29, 31}`, dominated by `16` (`687,417`)], `n0` bits `5..13`, bits `14..15 === 0` [**E0**]), `0x06` `uint16` (bits `0..11 === 0` [**E0**], `renderFlags` bits `12..15` observed `{0, 4, 8, 12}`), `0x08` `uint32` (bit `0 === 0` [**E0**], `n1` bits `1..9`, `n2` bits `10..18`, `n3` bits `19..27`, bits `28..31 === 0` [**E0**]), `0x0C` `uint32` (`color` `BGR888` bits `0..23` as `0xBBGGRR`, `faceType` bits `24..31`).
   - **Quad Triangulation & Uniform Winding Order (**E3**):** Quads list vertices `[v0, v1, v2, v3]` in **perimeter order** and triangulate cleanly as `(v0, v1, v2) + (v0, v2, v3)` (`532,711` consistent vs `2,529` mixed in 3D, `99.53%`; `442,945` vs `1,493` in 2D UV, `99.66%`; whereas Z-order `(0,1,2)+(2,1,3)` yields `99.0%` normal-inversion conflicts). Relative to the unpacked 10-bit vertex normals (`(v1 - v0) × (v2 - v0) · N_avg > 0` in right-handed `+X right, +Y up, -Z forward`), both triangles and triangulated quads use **uniform CCW front-facing winding (`gl.CCW`)** when single-sided:
     - `renderFlags` bit 3 (`0x08`, **E3**): **`1`** (`renderFlags ∈ {8, 12}`) = single-sided `CCW` (`657,294 / 659,138 = 99.72%`, including `19,458 / 19,458 = 100.00%` for `rf = 12`) and **`100.000%` (`660,207 / 660,207`)** carry valid smooth outward vertex normals; **`0`** (`renderFlags ∈ {0, 4}`) = double-sided (disable back-face culling) and **`100.000%` (`181,978 / 181,978`)** leave `n0 = n1 = n2 = n3 = 0` unindexed (computed via geometric triangle normals + two-sided lighting in `src/renderer/meshData.ts`).
     - `renderFlags` bit 2 (`0x04`, **E3** correlation / **E1** visual meaning): **`1`** (`renderFlags ∈ {4, 12}`) is in **`100.00%` (`21,941 / 21,941`) bijection** with `paletteIndex === 14` across all `842,731` polygons (`0` occurrences on untextured `32/40` or palettes `0..13`).
   - Additional `12 B` UV block (`0x10..0x1B`): `uv0 (u,v)`, `uint16 paletteRaw` (**E3**), `uv1 (u,v)`, `uint16 pad0x16 === 0` (**E3**), `uv2 (u,v)`, `uv3 (u,v)` (`(0,0)` for triangles; `u ∈ [0, 255]`, `v ∈ [0, 223]` texel coordinates).
   - **`paletteRaw` Formula (**E3**):** Only `15` distinct values occur across all `761,689` UV polygons (`0x0000..0x0003`, `0x0040..0x0043`, `0x0080..0x0083`, `0x00C0..0x00C2` — PS1 4×4 VRAM CLUT grid `row = raw >>> 6`, `col = raw & 3`). `(raw >>> 4) + (raw & 0x3F)` maps `761,689 / 761,689` (`100.0%`) strictly into `0..14`.
   - Edge case (`4` files / `8` LODs): `normalCount === 0` with all polygon normal indices `[0, 0, 0, 0]` (accepted with warning; non-zero index when `normalCount === 0` is rejected).

### 4. Trailing Shadow Block (After Final LOD)

- **Header (`28 B` / `0x1C`, **E3**):** `uint16 vertexCount` (`24` in `2,218` files, `48` in `2` files), `uint16 triangleCount` (`2` or `4`), `uint16 quadCount` (`16` or `32`), `uint16 unk_0x06` (`0` across `2,220 / 2,220`, **E0**), `8×int16` `boundingBox` (`lowX/highX/lowZ/highZ` match shadow `XZ` min/max across `2,220 / 2,220`; `lowY`/`highY` non-zero in `46`/`62` files), `uint16 scale` (`15..17`, **E1**), `uint16 unk_0x1a` (**E0**).
- **Clean-room Payload Layout (**E1**, `100%` exact EOF across `2,220 / 2,220` models):**
  - `vertexCount × 4 B`: `int16 x, int16 z` LE (`1/4096 m`).
  - `triangleCount × 4 B` followed by `quadCount × 4 B`: packed `uint32` LE (`v0` bits `0..5`, `v1` `6..11`, `v2` `12..17`, `v3` `18..23` [`0` on triangles], `flagsRaw` bits `24..31` observed `0x80`/`0x00` — diagnostic only).
  - Sample shadow header + start of payload (`64 B` total): `1800020010000000b7f80000bfef0000490700001f12000011004d12` + `0000bfef00001f120000e1f200008e0b8404170b640641084907c30978057611`.

---

## GT2 Car Texture & Palette Format: `CDP` / `CNP` (`src/formats/car/cdp/`)

- **Confidence:** **E3** (file size, header, `colorCount`, ASCII `colorIds`, `30` × `0x240`-byte paint slot layout, `256 × 224` 4 bpp bitmap, `0xFFFF` empty-entry semantics, and day/night slot alignment verified across `2,220 / 2,220` decompressed `.cdp.gz`/`.cnp.gz` files in `local_assets/GT2.VOL`, `tests/unit/cdpRealArchive.test.ts` & `tests/unit/cdoCdpResearchRealArchive.test.ts`); **E1** (`illuminationMasks` and `paintMasks` semantics, STP bit 15 role).
- **Clean-room source:** Implemented solely from [ROADMAP.md Appendix D.7](../ROADMAP.md#d7-tekstury-cdp--cnp) and streaming verification against `local_assets/GT2.VOL`.
- **Endianness & Fixed Size:** Little-endian (`DataView(..., true)`) (**E3**); exact uncompressed size `45,984 B` (`0xB3A0 = 0x43A0 + 0x7000`) across `2,220 / 2,220` files (**E3**).

### 1. Header & Color Slot Table (`0x00..0x439F`)

| Offset | Size | Type | Name / Meaning | Confidence |
| --- | --- | --- | --- | --- |
| `0x00` | 2 B | `uint16` LE | `colorCount`: active paint slots (`1..16` observed, max `30`; upper byte `0x01` is `0x00` across `2,220 / 2,220`) | **E3** |
| `0x02` | `30` B | `uint8[30]` | `colorIds`: ASCII `[0-9a-z]` (`36` distinct chars) for `0..colorCount-1`; trailing `colorCount..29` strictly `0x00` (`2,220 / 2,220`) | **E3** |
| `0x20` | `30 × 0x240` B | `CdpColorSlot[30]` | Paint slot records (`9,258` active slots across `2,220` files; unused slots `colorCount..29` strictly `0x00` across `2,220 / 2,220`) | **E3** |
| `0x43A0` | `0x7000` B | `uint8[]` | `256 × 224` 4 bpp indexed bitmap (`128 B/row`, even pixel = low nibble `byte & 0x0F`, odd pixel = high nibble `(byte >>> 4) & 0x0F`) | **E3** |

### 2. Paint Slot Record (`0x240` = `576` bytes)

| Relative Offset | Size | Type | Name / Meaning | Confidence |
| --- | --- | --- | --- | --- |
| `+0x000` | `0x200` B | `uint16[16][16]` LE | `16` CLUTs × `16` 15-bit PS1 `A1B5G5R5` colors (`bit 15 = STP`, `14..10 = B`, `9..5 = G`, `4..0 = R`); `0xFFFF` = empty/unused slot | **E3** |
| `+0x200` | `0x20` B | `uint16[16]` LE | `illuminationMasks`: bit `c` of word `p` correlates with day→night palette changes (`26,187` changed+marked vs `3,337` changed-only); STP bit 15 shows no surge on illuminated entries (`138` day vs `122` night) | **E1** |
| `+0x220` | `0x20` B | `uint16[16]` LE | `paintMasks`: bit `c` of word `p` correlates with multi-color paint recoloring (`123,883` varying+marked vs `2,654` varying-only across `1,650` multi-color files) | **E1** |

- **`0xFFFF` Empty Slot vs White+STP (**E3**):** Across `148,128` active palettes (`9,258` slots × `16`), `11,902` are all-`0xFFFF` and `107` are partial-`0xFFFF`. Active UV polygons have **`0` texel hits** in partially-`0xFFFF` palettes (`1,068 / 1,068`), and only **`4` daytime quads in `1` `.cdo`** reference an all-`0xFFFF` palette (`paletteIndex = 12`, `dayIllum = 0`) whose paired night `.cnp` populates palette `12` (`0` `0xFFFF` entries, `illuminationMasks[12] = 0xFF00`). `cdpToIndexedImage` defaults `0xFFFF` to `0x0000` (transparent black) while preserving raw `emptyEntryMasks`/`emptyPalettes` on `CdpColorSlot`.
- **Stock Wheel / Rim Disc Allocation (`palette 0` vs. `palette 15`, **E3**):** Across `1,110 / 1,110` `.cdp` textures and `621` `.cdo` body models, **palette `0`** (`0` body polygon uses) holds each car's stock `48 × 48` circular alloy rim disc at texels `(0..47, 0..47)` (`1,091 / 1,110 = 98.3%` non-empty, `1,097 / 1,110` transparent corners, `0 / 621` paint-slot variance), while `12 / 1,110` empty-palette-`0` files fall back to `192` standalone `carwheel/*.tim` (`48 × 48 @ 4 bpp`) assets. **Palette `15`** is instead the red/orange brake-light illumination palette (`609 / 620 = 98.2%` reddish, non-zero `illuminationMasks`, paired with `paletteIndex === 14`).
- **Day vs Night Pairs (**E3**):** `1,110 / 1,110` `.cdp`/`.cnp` pairs share identical `colorCount` and `colorIds`; `1,077 / 1,110` pairs differ in bitmap content (`0x43A0..0xB39F`).


---

## GT2 Track & Background Texture Pack Format: `TRP` / `BSP` (M8.2)

- **Confidence:** **E3** (full archive verification across `126/126` `.trp.gz` [`14,138` TIMs] and `34/34` `.bsp.gz` [`1,160` TIMs] in `local_assets/GT2.VOL`, `tests/unit/trackResearchRealArchive.test.ts`).
- **Endianness:** Little-endian (`DataView(..., true)`).
- **Layout:**

| Offset | Size | Type | Name / Meaning | Confidence |
| --- | --- | --- | --- | --- |
| `0x00` | 4 B | `uint32` LE | `timCount` (`8..259` in `.trp`, `3..63` in `.bsp`) | **E3** |
| `0x04` | variable | `TimImage[timCount]` | Concatenated standard PS1 TIMs (`0x10 00 00 00`, `flags = 0x08` = `4 bpp + CLUT`, strict `clut.bnum` & `img.bnum`, zero padding, ends at exact EOF) | **E3** |

- **VRAM Bounds (`1,024 × 512` 16-bit halfwords):**
  - `.trp` (`14,138 / 14,138` TIMs): pixel `x ∈ [640, 1024]`, `y ∈ [0, 512]`.
  - `.bsp` (`1,160 / 1,160` TIMs): pixel `x ∈ [704, 1024]`, `y ∈ [0, 512]`.
  - Sequential PS1 `LoadImage` blitting across `126/126` `.trp` packs yields `0` pixel/CLUT overlaps, `237` exact-rectangle TIM pixel updates (`179` identical, `58` updated), and `2` partial pixel overlaps (**E3**).
  - Active CLUT entries (`226,208` total) contain `4,516` `0x0000`, `5,092` `0x8000`, and `5,884` STP-set (`0x8000`) entries (**E3**).
- **Signature Note:** When `timCount === 16` (`0x10 00 00 00`), byte `0x00..0x03` matches standalone TIM magic. `FORMAT_REGISTRY` resolves `.trp`/`.bsp` reliably by matching the first entry's TIM header + `4 bpp + CLUT` flags `[0x10, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00]` at `magicOffset: 4`.
- **Sample header (`Track #1 (smallest)` `.trp`, first 32 B):** `2500000010000000080000002c0000006002f30110000100ff7f7b6f5a6bf762`.

---

## GT2 Track Geometry Format: `TRO` (M8.2–M8.5)

- **Confidence:** **E3** for header magic, section bounds, Section 0 layout, `TRO_UNITS_PER_METER = 64` world scale (`16.16` `trackLengthRaw` match), `0x44`-byte sub-mesh headers, 11-list strides, `SVECTOR` vertex arrays, `F3/F4/G3/G4/FT3/FT4/GT3/GT4` packed polygon bitfields, `w1` bits `28..30` polygon `surfaceCode` (`0` asphalt, `1` kerb, `2` grass, `3` sand/gravel, `5` rally dirt), GPU command tags & RGB color layout, `subMesh0`/`subMesh1` LOD relationship and opposite winding, `(0,1,2)+(0,2,3)` / `(0,2,1)+(0,3,2)` quad triangulation, world-space cell origin `(int32 >> 22) * 4096`, `subBlock98` 2D barrier walls and outward normal winding, and `100%` 4 bpp `clut`/`tpage`/texel addressing across all `126/126` tracks; **E1** for auxiliary Sections 1–4, checkpoints, `0x48..off0`, `subBlock9C`/`A0`, list `9` sprites, `unk5`/`unkFlags` bits `23..27`, and rare `surfaceCode` `4`/`6`; **E0** for list `10`, unknown header/UV tail words, and `.tro`→`raceId` cross-file mapping.
- **Endianness:** Little-endian.

### 1. Top-Level Header (`0x00..0x47`, 72 B) & Variable Prefix (`0x48..off0`)

| Offset | Size | Type | Name / Meaning | Confidence |
| --- | --- | --- | --- | --- |
| `0x00` | 12 B | `char[12]` | Magic `"@(#)GT-PS\0\0\0"` (`40 28 23 29 47 54 2D 50 53 00 00 00`) | **E3** |
| `0x0C` | 4 B | `uint32` | Constant `0x001F0000` across `126/126` files (role/version flag unverified) | **E1** |
| `0x10` | 4 B | `uint32` | `off0`: Section 0 offset (segments + UV table) | **E3** |
| `0x14` | 4 B | `uint32` | `off1`: Section 1 offset (`off0 < off1`, `4,861` items total across archive) | **E3** bounds / **E1** role |
| `0x18` | 4 B | `uint32` | `off2`: Section 2 offset (`off1 <= off2`, `5,709` items total; candidate trackside/static objects) | **E3** bounds / **E1** role |
| `0x1C` | 4 B | `uint32` | `off3`: Section 3 offset (`off2 <= off3`, `5,924` items total) | **E3** bounds / **E1** role |
| `0x20` | 4 B | `uint32` | `off4`: trailing section offset (`off3 <= off4 < EOF`; `u32[off4] === fileLength - off4` on `126/126`) | **E3** bounds / **E1** role |
| `0x24..0x47` | 36 B | `uint32[]` | `checkpointCount` (`0..3`) + distance table | **E1** |
| `0x48..off0` | `472..2,344` B | variable | Variable pre-geometry table (candidate start grid / racing line) | **E0/E1** |

- **Sample header (`Track #1 (smallest)` `.tro`, first 32 B):** `4028232947542d505300000000001f003803000040040100e4040100d02c0100`.

### 2. Section 0 (`off0..off1`): Segment Table & UV Table (`126/126`, **E3**)

| Relative Offset | Size | Type | Name / Meaning | Confidence |
| --- | --- | --- | --- | --- |
| `+0x00` | 4 B | `uint32` | `trackLengthRaw` (`16.16` fixed-point length: `trackLengthRaw / 65536` matches centerline path sum at `64 raw units/m` across `126/126` tracks) | **E3** |
| `+0x04` | 2 B | `uint16` | `segmentCount` (`12..194` per track, `14,387` total) | **E3** |
| `+0x06` | 2 B | `uint16` | `uvCount` (`<= 2,742` per track) | **E3** |
| `+0x08` | 4 B | `uint32` | `uvTableOff` (`off1 - uvTableOff === uvCount * 32` on `126/126`) | **E3** |
| `+0x0C` | `segmentCount × 4` B | `uint32[]` | `segOffsets` (`segOffsets[0] === off0 + 12 + segmentCount * 4`, strictly monotonic `< uvTableOff`) | **E3** |

### 3. Segment Record (`14,387 / 14,387`) & World-Space Cell Origin

| Relative Offset | Size | Type | Name / Meaning | Confidence |
| --- | --- | --- | --- | --- |
| `+0x00` | 2 B | `uint16` | `prevSeg` index | **E3** |
| `+0x02` | 2 B | `uint16` | `nextSeg` index | **E3** |
| `+0x18..+0x23` | 12 B | `int32[3]` | Start centerline `(X, Z_up, Y_lat)` (`1024 × vertexUnit`) | **E1** |
| `+0x30..+0x3B` | 12 B | `int32[3]` | Segment center `(X, Z_up, Y_lat)` used for cell origin extraction | **E3** cell / **E1** center |
| `+0x44..+0x93` | 80 B | `int32[20]` | Two `10 × int32` world bounding prisms | **E1** |
| `+0x94` | 4 B | `uint32` | `subMesh1Off` (`LOD1` / far low-detail `0x44` B sub-mesh header) | **E3** |
| `+0x98` | 4 B | `uint32` | `subBlock98Off` (`uint32 count` + `count × 8 B` 2D barrier walls `{ uint16 v0, uint16 v1, int16 nxFixed12, int16 nyFixed12 }`, `80,433` walls across `14,387/14,387` segments) | **E3** |
| `+0x9C` | 4 B | `uint32` | `subBlock9COff` (payload contains internal file offset at `+0x28`, candidate road/collision strip) | **E1** |
| `+0xA0` | 4 B | `uint32` | `subBlockA0Off` (trailing visibility / PVS block) | **E1** |
| `+0xA4` | `0x44` B | `SubMeshHeader` | Primary `subMesh0` header (`LOD0`) | **E3** |

- **World-Space Reconstruction & Engine Transform (**E3** geometry & world scale):** Each sub-mesh stores local `int16` vertices `(vx, vy, vz)` inside a `4096`-unit cell:
  - `cellX = (int32[seg + 0x30] >> 22) * 4096`
  - `cellY = (int32[seg + 0x38] >> 22) * 4096`
  - `cellZ = (int32[seg + 0x34] >> 22) * 4096`
  - `worldRaw = (cellX + vx, cellY + vy, cellZ + vz)` (`(X, Y)` horizontal ground plane, `+Z` up).
  - Verified across all `14,387` segments: `0` off-by-4096 seam errors (`13,154` exact vertex seams; remaining `1,233` are point-to-point endpoints or `0`-vertex dummy segments).
  - Proper-rotation (`det = +1`) axis transform to engine right-handed `+Y` up (`+X` right, `+Y` up, `-Z` forward): `(x / s, z / s, -y / s)` with `s = TRO_UNITS_PER_METER = 64` (**E3**: empirically verified across `126/126` tracks — wall-to-wall `subBlock98` road width `p10/p50/p90 = 16.1 / 23.5 / 31.0 m`, retaining-wall polygon height `p25/p50/p75 = 1.11 / 1.50 / 2.39 m`, closed-loop centerline length `p10/p50/p90 = 1.25 / 3.54 / 4.94 km` [max `6.97 km`], matching `16.16` `trackLengthRaw`).
- **`subMesh0` (LOD0) vs `subMesh1` (LOD1) & Opposite Winding (**E3**):**
  - `subMesh0` (`1,129,468` vertices, `699,211` polygons) and `subMesh1` (`301,658` vertices, `155,186` polygons) are LOD variants (`32/126` identical, `94/126` simplified LOD1; `12/126` tracks have `700` distant `only1` segments with `subMesh0.vertexCount === 0` and `subMesh1.vertexCount > 0`).
  - Shared polygons have reversed vertex order (`85,122 / 85,300 = 99.79%`): in raw `.tro` (`+Z` up), `subMesh0` horizontal faces are `95.7%` CW from above (`nz < 0`) and `subMesh1` are `98.1%` CCW from above (`nz > 0`). Engine `gl.CCW` normalization emits `(0,2,1)` / `(0,2,1)+(0,3,2)` for `subMesh0` and `(0,1,2)` / `(0,1,2)+(0,2,3)` for `subMesh1`.
- **`subBlock98` 2D Wall Barriers (`80,433` records across `14,387/14,387` segments, **E3**):**
  - `b9cOff - b98Off === 4 + count * 8` (`100%`). Each `8 B` entry stores `uint16 v0, uint16 v1` (`0` OOB in `subMesh0` vertices) and `int16 nxFixed12, int16 nyFixed12` (`99.82%` unit length `/ 4096`, `99.74%` perpendicular to edge `(v1 - v0)`).
  - Across `126/126` tracks, `80,407 / 80,433 (99.97%)` barrier edges share exact `(v0, v1)` vertices with `subMesh0` polygons (`99.54%` ground), and **`76,116 / 80,433 (94.63%)` raw normals point OUTWARD** toward wall exteriors (`99.75%` left-handed relative to `(v1 - v0)`). Engine `CollisionMesh` construction deterministically orients each normal inward toward single-sided adjacent ground polygons (falling back to segment centerline on double-sided apron/curb edges).
  - **Road-marking decals (E2, heuristic):** no `.tro` polygon flag distinguishes painted markings from asphalt. Across `126/126` tracks, the 9-bit `unkFlags` bits `0..8` are near-zero for both decals and asphalt, `unk5` and `listIndex` correlate only weakly (decals are `74%` flat-coloured vs `7%` for other asphalt), and none is exclusive. Decals are asphalt-coded (`surfaceCode 0`) ground triangles `0.5-14.3 cm` (median `2.3 cm`, mostly `1-2` raw units of `1/64 m`) above another asphalt triangle, sometimes across a segment boundary or partially overhanging the road edge. `buildCollisionMesh` therefore excludes asphalt ground triangles that either have all three vertices, or their centroid plus at least one vertex, `0.5-15 cm` above a near-parallel asphalt ground triangle of any segment (XZ-contained). The lowest layer is never removed; kerbs, steps > 15 cm, overpasses and non-overlapping seams stay collidable; render geometry is unchanged.

### 4. Sub-Mesh Header (`0x44` B) & 11 Typed Lists (`28,774 / 28,774` exact match)

- Header layout: `+0x00..+0x2B` = `11 × uint32` absolute list offsets (`ptr[0] === mhOff + 0x44`), `+0x2C` = `uint16 vertexCount` (`<= 448` per sub-mesh), `+0x2E` = `uint16 pad === 0`, `+0x30..+0x43` = `10 × uint16` counts for lists `1..10`.
- Strides & archive totals:
  - List `0` (`8 B`, `1,431,126`): `int16 x, y, z, pad=0` (`SVECTOR`, **E3**).
  - List `1` (`12 B`, `4,987`): `F3` untextured triangle (`0x20`, **E3**).
  - List `2` (`12 B`, `37,115`): `F4` untextured quad (`0x28`, **E3**).
  - List `3` (`20 B`, `2,993`): `G3` Gouraud triangle (`0x30`, **E3**).
  - List `4` (`24 B`, `14,573`): `G4` Gouraud quad (`0x38`, **E3**).
  - List `5` (`12 B`, `89,063`): `FT3` textured triangle (`0x24`, **E3**).
  - List `6` (`12 B`, `663,589`): `FT4` textured quad (`0x2C`, **E3**).
  - List `7` (`20 B`, `5,625`): `GT3` textured Gouraud triangle (`0x34`, **E3**).
  - List `8` (`24 B`, `36,452`): `GT4` textured Gouraud quad (`0x3C`, **E3**).
  - List `9` (`16 B`, `12,409`): candidate billboard/sprite (`0x2C` GPU packet tag, **E1**).
  - List `10` (`20 B`, `2,195`): auxiliary block (`0x00` tag, **E0/E1**).
- **Polygon Bitfields, GPU Tags & Colors (Lists `1..8`, `854,397` polygons, **E3**):**
  - `w0` (`uint32` at `+0x00`): `v0` (bits `0..8`), `v1` (bits `9..17`), `v2` (bits `18..26`), `unk5` (bits `27..31`, **E1**).
  - `w1` (`uint32` at `+0x04`): `v3` (bits `0..8`; strictly `0` on `100%` of triangles), `uvIdx` (bits `9..22`; `0` OOB across `794,729` textured polygons), `unkFlags` bits `23..27` (**E1**), **`surfaceCode` bits `28..30` (`(w1 >>> 28) & 0x07`, **E3**)**, and bit `31 === 0` (`100%`).
  - **Polygon `surfaceCode` (`(w1 >>> 28) & 0x07`, `702,680` primary polygons across `126/126` tracks):**
    - `0` (`583,638` polys, `126/126` tracks): **asphalt / road & general track scenery** (**E3** — `95.7%` grey inside barriers, `5.50 m` mean lateral distance from centerline).
    - `1` (`23,204` polys, `85/126` tracks, `95.2%` ground-exclusive): **kerb / rumble strip** (**E3** — `8.72 m` mean lateral distance; `lat(0) < lat(1)` on `82/85` = `96.5%` of tracks).
    - `2` (`41,476` polys, `79/126` tracks, `98.0%` ground-exclusive): **grass / turf runoff** (**E3** — `11.15 m` mean lateral distance; `lat(1) < lat(2)` on `64/65` = `98.5%` of tracks).
    - `3` (`6,333` polys, `51/126` tracks, `98.1%` ground-exclusive): **sand / gravel trap** (**E3** — `14.10 m` mean lateral distance; `lat(2) <= lat(3)` on `47/50` = `94.0%` of tracks).
    - `4` (`241` polys, `13/126` tracks, `100.0%` ground-exclusive): rare concrete/apron ground (**E1** — conservatively mapped to asphalt).
    - `5` (`47,696` polys, `32/126` tracks, `98.5%` ground-exclusive): **dirt / rally road** (**E3** — `6.07 m` mean lateral distance; `17/19` rally tracks center `code = 5` within `< 7.5 m`).
    - `6` (`246` polys, `8/126` tracks, `99.6%` ground-exclusive): rare off-track rough ground (**E1** — conservatively mapped to gravel).
    - `7` (`0` occurrences across `126/126` tracks).
  - Trailing primitive bytes after `w0, w1`: `+0x08..+0x0A` = `[R, G, B]` (`uint8[3]`), `+0x0B` = PS1 GP0 command byte (`0x20, 0x28, 0x30, 0x38, 0x24, 0x2C, 0x34, 0x3C` for lists `1..8` on `100.0%` of polygons; `0` semi-transparent tags). Gouraud lists (`3, 4, 7, 8`) store additional `[R, G, B, 0x00]` color words at `+0x0C`, `+0x10`, and (quads `4, 8`) `+0x14` (`byte +3 === 0x00` on `100%`). Textured lists use PS1 modulated brightness (`0x80` = `1.0×`).
  - **Quad Triangulation (**E3**):** Quads `[v0, v1, v2, v3]` follow perimeter order; normalized to engine `gl.CCW` via `(0,2,1)+(0,3,2)` for `subMesh0` and `(0,1,2)+(0,2,3)` for `subMesh1`.

- **Polygon GPU Command Tags, Colors (`E3`), and Flags (`E1`):**
  - Across all `126/126` tracks (`649,041` textured primary polygons / `2,297,520` RGB samples; `53,793` untextured primary polygons / `295,272` RGB samples):
    - Textured polygons use PS1 modulated brightness (`0x80` = `1.0×`, `p50 = 69`, `p90 = 98`, `p99 = 128`, `99.52% < 128`), requiring `clamp(texel.rgb * (v_color * 2.0), 0.0, 1.0)` (**E3**).
    - Untextured polygons store direct unscaled vertex colors (`p50 = 93`, `p90 = 179`, `p99 = 255`, `52.94% > 128`), rendered directly as `v_color` (**E3**).
- **Texture Page & CLUT Budget (`126/126` tracks, `E3`):**
  - `3–10` `256×256` 4 bpp pages per track (median `7`, `p95 = 10`, max `10`), `5–93` 16-color CLUTs (median `43`, `p95 = 81`, max `93`), `1:1` with unique `(page, palette)` pairs, and up to `19` distinct CLUTs sharing a single `256×256` page.
  - Because `10 × 256×256` `R8` layers + `93 × 16` `RGBA8` CLUTs total `≤ 650 KiB` VRAM, both HD Remaster (4-tap shader-side bilinear with `uv - 0.5` texel-center alignment) and PS1 (`NEAREST`) share the exact same GPU texture atlas without cross-palette mipmap bleeding.

### 5. UV Table (`uvCount × 32 B` at `uvTableOff`, **E3**)

Each `32 B` entry holds two `16 B` records (`+0x00` hi-res, `+0x10` mipmap):

| Relative Offset | Size | Type | Name / Meaning | Confidence |
| --- | --- | --- | --- | --- |
| `+0x00` | 2 B | `uint8[2]` | `u0, v0` | **E3** |
| `+0x02` | 2 B | `uint16` | `clut` (`X = (clut & 0x3F) * 16`, `Y = (clut >>> 6) & 0x1FF`) | **E3** |
| `+0x04` | 2 B | `uint8[2]` | `u1, v1` | **E3** |
| `+0x06` | 2 B | `uint16` | `tpage` (`tpX = (tpage & 0x0F) * 64`, `tpY = ((tpage >>> 4) & 0x01) * 256`, `abr = (tpage >>> 5) & 3`, `depth = (tpage >>> 7) & 3`) | **E3** |
| `+0x08..+0x0B` | 4 B | `uint8[4]` | `u2, v2, u3, v3` | **E3** |
| `+0x0C` | 4 B | `uint32` | `unk` | **E0** |

- Across **all `126/126` tracks** (`255,422` hi-res/mipmap records, `1,021,688` UV corners), `.tro` + `.trp` resolution yields **`100.0%` (`0` misses)** CLUT and pixel VRAM hits, `0` cross-TIM UV quads, and `100.0%` (`255,422 / 255,422`) `tpage` `colorDepth === 0` (`4 bpp`), `abr === 0`, `highBits === 0`.
- **Sample UV entry (`Track #2`, `uvIdx = 0`, 32 B):** `5e60287e5e7f0d00007f0060620b00008e90257d8e9f0d00609f609000000000`.

---

## GT2 Track Background Object Container: `BSO` (M8.1, M8.8)

- **Confidence:** **E2** (`34` files under `bgsobj/*.bso.gz`, 1:1 paired with `bgsobj/*.bsp.gz`, ASCII magic `"BG\0\0"` = `42 47 00 00` across `34/34`); **E1** (candidate GP0 `0x28`-tagged sky gradient/color words at `0x04` and `0x08`, and `uint32` count `194..382` at `0x0C` across `34/34` files); **E0** (internal skybox geometry payload, `.tro` → `.bso` sky assignment, fog parameters).
- **Bounded M8.8 Check:**
  - `0/34` `bgsobj/` stems match `crsobj/` stems, and `0/126` decompressed `.tro` files contain ASCII references to any `.bso` stem.
  - No verified fog distance/color table or `.tro` → `.bso` sky index was established at `E2`/`E3`. Per §1.1/§3, production track rendering keeps a plain clear background color with zero procedural skyboxes or fog.
