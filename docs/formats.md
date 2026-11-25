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
  - `7/91` are multi-member containers starting with a valid CRC-checked gzip member followed by zero-padding to either a 4-byte boundary (`5` entries) or a 2048-byte CD sector boundary (`2` entries) where the next `1F 8B` member begins (**E1**; container unpacking deferred to M3/M4).
