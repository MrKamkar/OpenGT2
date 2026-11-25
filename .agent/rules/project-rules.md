---
trigger: always_on
---

# OpenGT2 Web Engine — Hard Project Rules

1. **Read `ROADMAP.md` first**: At the start of every session, read `ROADMAP.md` (when present) before planning or editing code.
2. **TypeScript strict mode**: Always write strict TypeScript (`strict: true`, no `any`, explicit types at module boundaries).
3. **Pure WebGL2 only**: Implement rendering directly on raw WebGL2 APIs. **No Three.js** or other high-level 3D engines/wrappers.
4. **Zero placeholder assets**: Never commit or bundle substitute/placeholder meshes, textures, audio, or fake game data. All game content must be loaded at runtime from user-supplied local assets.
5. **No Sony / GT2 proprietary data in Git**: Never commit any copyrighted Sony, Polyphony Digital, or Gran Turismo 2 files, dumps, extracted assets, tables, or binary blobs (`.vol`, `.bin`, `.cue`, `.iso`, `local_assets/`, `dumps/`).
6. **Never load entire `.VOL` into RAM**: Always use streaming / random-access range reads (`File.slice` / chunked `ArrayBuffer` reads) against `.VOL` archives. Never call `file.arrayBuffer()` on the whole archive.
7. **Never guess binary offsets or formats**: If a binary offset, struct layout, compression detail, or format field is unverified (below confidence level `E2` in `docs/formats.md`), **STOP and ask the user** instead of guessing or fabricating values.
