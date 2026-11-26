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
    - `5` `.dat` containers (`37.55–46.83 MB` compressed) holding `12,658` sequential gzip members (`2,493–2,561` per file), zero-padded to 4-byte or 2048-byte boundaries, every member starting with `47 4D 03 00` (`"GM\x03\x00"`).
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
| `.dat` `[multi-gz]` | multi-gzip (`4 B` / `2048 B`) | `47 4D 03 00` (`"GM\x03\x00"`) | `5` plików (`12 658` członów) | `3 184–563 792 B` / człon | Obrazy menu GT2 (`GMImage` wg `GTVolTools`; prawdopodobnie indeksowane przez `6` plików `.idx`); wariant 2. bajtu po magic obserwowany jako `00..03` | **E3** (obecność/magic) / **E2** (układ wg `GTVolTools`) |
| `.dat` (surowy `GTMP`) | brak (surowy) | `47 54 4D 50` (`"GTMP"`) | `1` plik | `44 724 224 B` | Kontener obrazów menu GT2 (`GTMP` wg `GTVolTools`; kolejne pola LE: `0x00140503`, `16031`, `16030`) | **E3** (obecność/magic) / **E2** (układ wg `GTVolTools`) |
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
| `.dat.gz` | gzip (1 człon) | `47 54 44 54` (`"GTDT"`, `22` pliki) i inne (`17`) | `39` | `32–776 504 B` | Pliki bazy danych i konfiguracji gry (zakres M5) | **E1** |
| `(none)` (pozostałe) | `18` surowych + `3` gzip | m.in. `06 00 0A 00` (`7`), `CAR\0` (`3`), `UCAR` (`3`) | `21` | `2 652–348 160 B` | Różne pliki systemowe/danych bez rozszerzenia | **E0** / **E1** |
| `.seq` | brak | `53 45 51 47` (`"SEQG"`) | `10` | `4 267–23 755 B` | Sekwencje muzyczne/audio (zakres M11) | **E1** |
| `.idx` | brak | zmienna (`uint32` LE) | `6` | `1 840–13 552 B` | Indeksy (prawdopodobnie powiązane z kontenerami menu `.dat`) | **E1** |
| `.ins` | brak | `49 4E 53 54` (`"INST"`) | `5` | `34 600–383 296 B` | Banki instrumentów audio (zakres M11) | **E1** |
| `.gmr.gz` / `.gmr` | `4` gzip + `1` surowy | `53 43 13 ??` | `5` | `40 960–122 880 B` | Nieznany format (najprawdopodobniej dane powtórek/bazy) | **E0** |
| `.000` / `.999` | brak | `(pusty)` | `6` (`3` + `3`) | `0 B` | Puste wpisy znacznikowe `0 B` | **E3** |
| `.dat` (surowy, nie-GTMP), `.tsd.gz`, `.arc`, `.txd`, `(none).gz` | `2` gzip + `3` surowe | różne (`80000000`, `@(#)GT-A`, `Lap\0`, `5A000A00`, `0B000000`) | `5` | `28 760–159 072 B` | Pojedyncze pliki pomocnicze | **E0** |
