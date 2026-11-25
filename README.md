# OpenGT2 Web Engine

An independent, browser-based engine written in strict TypeScript, pure WebGL2, and Web Audio that loads all game assets **exclusively from a user-supplied local `GT2.VOL` file**.

- **Zero bundled game assets or placeholders:** the repository contains only application source code.
- **100% local & self-contained:** your `GT2.VOL` file never leaves your computer, is never uploaded, and is never loaded into RAM as a whole (only metadata and range reads are used).
- **No external runtime dependencies:** zero CDNs, zero external fonts, zero analytics, and `noindex,nofollow` enabled.

---

## Requirements

- **Runtime (browser):** a modern browser with **WebGL2** enabled (required). Module Web Workers, `DecompressionStream('gzip')`, and `showOpenFilePicker` are detected automatically with graceful fallbacks where applicable.
- **Development:** Node.js 22+ (CI runs on Node.js 24) and `npm`.

---

## Running Locally

Install dependencies:

```bash
npm ci
```

Start the local development server:

```bash
npm run dev
```

Build and preview the production static bundle locally:

```bash
npm run build
npm run preview
```

Run all verification checks (typecheck, lint, unit tests, and production build):

```bash
npx tsc --noEmit
npm run lint
npm test
npm run build
```

---

## Loading Your Own `GT2.VOL`

1. Open the app locally (`npm run dev` or `npm run preview`) or on the deployed static page.
2. Drag and drop your own legally obtained `GT2.VOL` file onto the drop area, or click **Wybierz plik GT2.VOL**.
3. The application inspects only the local file handle / metadata (`name`, `size`) without reading the full archive into memory.

> **Privacy & Memory Safety:** Your file is never transmitted over the network and never buffered completely into RAM.

---

## Deployment & Static Hosting

The build outputs a self-contained static bundle to `dist/` with `base: './'`, so it can be served from any root or subpath (including GitHub Pages).

- CI runs `typecheck`, `lint`, `test`, and `build` on pushes and pull requests to `main`.
- Automatic GitHub Pages deployment from `main` is controlled by the repository variable `DEPLOY_TARGET` (`github-pages` by default; set to `none` to run checks only without publishing).

---

## Legal Notice

OpenGT2 Web Engine is an **independent open-source project**. It is **not** affiliated with, endorsed by, sponsored by, or otherwise connected to Sony Interactive Entertainment or Polyphony Digital.

This repository does **not** include, distribute, or bundle any copyrighted Sony, Polyphony Digital, or *Gran Turismo 2* files, assets, textures, models, audio, dumps, or data tables. To use the engine, you must supply your own legally obtained copy of `GT2.VOL`.
