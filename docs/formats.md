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

- **Confidence:** **E2** (target **E3** after M2.10 verification on real `local_assets/GT2.VOL`)
- **Reference Source:** `adeyblue/GTVolTools` (`GT2VolFile.cs`, MIT License)
- **Endianness:** Little-endian (`DataView(..., true)`)
- **Sector Alignment:** `VOL_SECTOR_SIZE = 0x800` (2048 bytes) (**E2**)

### 1. Header (`0x00..0x0F`, 16 bytes)

| Offset | Size | Type | Name / Meaning | Confidence |
| --- | --- | --- | --- | --- |
| `0x00` | 8 B | `char[8]` | Magic `"GTFS\0\0\0\0"` (`47 54 46 53 00 00 00 00`) | **E2** |
| `0x08` | 2 B | `int16` LE | `files`: entry count of the offset table | **E2** |
| `0x0A` | 2 B | `int16` LE | `totalEntries`: total number of 32-byte TOC records (files + dirs + `..`) | **E2** |
| `0x0C` | 4 B | `uint32` LE | `unk_0x0C`: unread by reference parser; ignored at runtime | **E0** |

Validation invariants (**E2**): magic matches `"GTFS\0\0\0\0"`, `files > 0`, `totalEntries > 0`, and `totalEntries > files`.

### 2. Offset Table (`0x10..0x10 + files * 4 - 1`)

- Array of `uint32[files]` little-endian raw mangled offset words (**E2**).
- Index meanings (**E2**):
  - `offsets[0]` — offset of the offset table itself
  - `offsets[1]` — TOC start offset (mangled)
  - `offsets[2 .. files - 1]` — file data start offsets (mangled)
  - `offsets[files]` (virtual, appended by parser) — total archive byte size (`source.size`)
- Word decoding (`splitOffset(raw)`, **E2**):
  - `address = (raw & 0xFFFFF800) >>> 0` (sector-aligned byte offset)
  - `tail = (raw & 0x7FF) >>> 0` (unused trailing bytes in the final `0x800` sector)

### 3. Table of Contents (TOC) Boundaries

```text
tocAddress       = splitOffset(offsets[1]).address
tocTail          = splitOffset(offsets[1]).tail
firstFileAddress = splitOffset(offsets[2]).address   (or virtual EOF when files === 2)
tocLength        = firstFileAddress - tocAddress - tocTail
```

Hard invariant (**E2**): `tocLength >= totalEntries * 32` and `tocAddress + tocLength <= volSize`.

### 4. TOC Entry Record (32 bytes each)

| Offset | Size | Type | Name / Meaning | Confidence |
| --- | --- | --- | --- | --- |
| `0x00` | 4 B | `int32` LE | `unixTime`: Unix timestamp (seconds, UTC) | **E2** |
| `0x04` | 2 B | `int16` LE | `offsetIndex`: index into `offsets` (`0` = `..` parent entry; non-zero for regular entries) | **E2** / **E1** (regular dirs) |
| `0x06` | 1 B | `uint8` | `flags`: `0x01` = directory, `0x80` = last entry in current directory; bits `0x02..0x7E` unknown | **E2** (`0x01`,`0x80`) / **E0** (`0x02..0x7E`) |
| `0x07` | 25 B | `char[25]` | `name`: ASCII entry name, zero-padded | **E2** |

- Entries with `offsetIndex === 0` or directory flag (`flags & 0x01`) have `address = 0` and no file payload (**E2**).
- `..` entries (and entries with `offsetIndex === 0`) are excluded from the final directory listing, **but `flags & 0x80` on them still terminates the current directory** (**E2**).

### 5. Directory Tree Reconstruction ("First Encounter", **E2**)

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

- For consecutive file entries in TOC order (**E2**):
  - `previous.size = next.address - previous.address - previous.tail`
- For the last file entry (**E2**):
  - `computed = offsets[files] - last.address - last.tail`
  - If `computed <= 0`, fallback size is `0x800` bytes.
- **0-byte files (E1):** represented with `next.address === previous.address` and `previous.tail === 0`, yielding `size = 0`.
- **Monotonicity (E1):** file addresses in TOC order are assumed non-decreasing (`next.address >= previous.address`); violations, overlaps, or out-of-range spans emit `VolInfo.warnings` without throwing.

### 7. Compression (Reference Only — Implemented in M2.7)

- `.gz` entries are standard gzip streams (`1F 8B` magic) (**E2**).
