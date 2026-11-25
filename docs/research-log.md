# OpenGT2 Research Log

Chronological log of binary format investigations, reverse-engineering findings, and open questions.

<!-- Entry template:
## YYYY-MM-DD — Topic
- **Goal:**
- **Confidence:** E0 / E1 / E2 / E3
- **Findings:**
- **Open questions:**
-->


## 2026-11-25 — M0.5–M0.10 — Fundament aplikacji, pusty kontekst WebGL2 i polityka dist/
- **Pytanie:** Jak ustrukturyzować pusty stan aplikacji (maszyna stanów, UI wyboru `GT2.VOL` bez wczytywania do RAM, pusty kontekst WebGL2, detekcja możliwości przeglądarki) oraz zweryfikować w CI politykę `noindex` i brak zewnętrznych URL w `dist/` bez dodawania zbędnych zależności?
- **Metoda:** Implementacja modułów w ścisłym TypeScript (`src/app/appState.ts`, `src/app/capabilities.ts`, `src/renderer/GlContext.ts`, `src/ui/fileLoaderScreen.ts`, `src/ui/formatSize.ts`), dokumentacja w `README.md`, `public/robots.txt` oraz testy jednostkowe Vitest (w tym programmatic `vite.build()` + leksykalny skaner `http(s)://` w `tests/unit/distPolicy.test.ts`).
- **Wynik:**
  - `src/app/appState.ts`: discriminated union `NoFile | Loading | Ready | Error` z walidacją przejść.
  - `src/ui/fileLoaderScreen.ts` + `src/ui/formatSize.ts`: odczyt wyłącznie `file.name` i `file.size` (zero odczytu bajtów pliku do RAM), formatowanie binarne MiB (`1572864 -> "1.50 MB"`).
  - `src/renderer/GlContext.ts`: czysty WebGL2 z `devicePixelRatio`, `ResizeObserver` i `webglcontextlost`/`webglcontextrestored`, wyłącznie `clearColor` + `clear` (zero geometrii ani zasobów zastępczych).
  - `src/app/capabilities.ts`: detekcja `WebGL2` (ze zwolnieniem kontekstu próbnego przez `WEBGL_lose_context`), `DecompressionStream('gzip')`, `Worker` modułowego (pusty Blob URL bez żądań sieciowych) i `showOpenFilePicker`.
  - `tests/unit/distPolicy.test.ts`: automatyczny build Vite + sprawdzenie `<meta name="robots" content="noindex,nofollow">`, `dist/robots.txt` (`Disallow: /`) i brak zewnętrznych URL `http(s)://` poza komentarzami i przestrzeniami nazw XML; dodano minimalne `tests/node-builtins.d.ts` zamiast instalacji `@types/node`.
- **Pewność:** N/A (zadania infrastrukturalne M0, brak parsowania formatów binarnych GT2).
- **Konsekwencje dla kodu:** Kontrakt `AppState` i `BrowserCapabilities` stanowi bazę dla M0.11–M0.12 oraz M1 (`BlobByteSource`). `npm test` weryfikuje również finalny bundle `dist/` niezależnie od kolejności kroków w CI.
- **Otwarte pytania:** W M0.12 zweryfikować w prawdziwej przeglądarce (Playwright / GitHub Pages) zachowanie wyboru dużego pliku oraz brak błędów konsoli podczas detekcji `Worker` modułowego.

## 2026-11-25 — M0.11–M0.12 — Rdzeń wejścia (InputManager) i smoke test Playwright
- **Pytanie:** Jak zbudować deterministyczny, niezależny od DOM rdzeń wejścia (§1.6) oraz wiarygodny test e2e Playwright (lokalnie i post-deploy na GitHub Pages z prefiksem ścieżki)?
- **Metoda:** Implementacja `src/core/input/` (`types.ts`, `config.ts`, `InputManager.ts`, `domInputBridge.ts`, `debugHook.ts`) z testami jednostkowymi Vitest w Node (`tests/unit/inputManager.test.ts`), instalacja `@playwright/test`, `playwright.config.ts`, `tests/e2e/smoke.spec.ts` oraz post-deploy job `smoke-test` w `.github/workflows/ci.yml`.
- **Wynik:**
  - `InputManager` obsługuje konteksty `menu`/`viewer`/`freecam`/`race`, jednoczesne WSAD + strzałki po `KeyboardEvent.code`, ignorowanie `repeat`, znoszenie przeciwstawnych kierunków, wygładzanie osi analogowych z ograniczeniem kąta skrętu zależnym od prędkości, zakaz `Ctrl`/`Alt`/`Meta` w zdarzeniach i bindingach, wykrywanie konfliktów w ramach kontekstu oraz `preventDefault()` wyłącznie przy fokusie na canvasie.
  - Hak `window.__input` jest udostępniany wyłącznie dla `?debug=1` i nie istnieje w trybie produkcyjnym.
  - Dodano `<link rel="icon" href="data:," />` w `index.html`, eliminując domyślne żądanie `/favicon.ico` (404) w Chromium bez dodawania zasobów zewnętrznych.
  - W Playwright zastosowano `waitUntil: 'load'` zamiast `networkidle` (uniknięcie zawieszania na natychmiastowo przerywanym `Worker(blobUrl)` w detekcji możliwości) oraz budowanie URL przez `new URL(normalized)` zachowujące podkatalog GitHub Pages.
  - Zweryfikowano lokalnie pełną bramkę (`tsc`, `eslint`, 38/38 Vitest, `vite build`) oraz 2/2 testy Playwright e2e przeciwko `vite preview` (brak 404 i błędów konsoli, start workera modułowego, wybór syntetycznego pliku 1.50 MB, reakcja `window.__input` na `W`, `ArrowUp`, `Space`).
- **Pewność:** N/A (zadania infrastrukturalne zamykające M0, brak parsowania formatów binarnych GT2).
- **Konsekwencje dla kodu:** Domknięto cały Milestone M0; `InputManager` jest gotowy do użycia w M7–M10, a workflow CI automatycznie uruchomi `smoke-test` po każdym wdrożeniu na GitHub Pages.
- **Otwarte pytania:** Potwierdzić pierwsze uruchomienie post-deploy joba `smoke-test` bezpośrednio na GitHub Actions po wypchnięciu gałęzi `main`.


## 2026-11-25 — M1.1–M1.4 — Warstwa I/O (ByteSource, LRU 2048 B) oraz RPC i pula workerów
- **Pytanie:** Jak zbudować bezkopiową, strumieniową warstwę dostępu do plików > 2 GiB (bez wczytywania całości do RAM) oraz typowany, testowalny w Node protokół RPC i priorytetową pulę workerów bez `SharedArrayBuffer` i bibliotek zewnętrznych?
- **Metoda:** Implementacja `src/io/` (`ByteSource.ts`, `BlobByteSource.ts`, `BufferByteSource.ts`, `CachedByteSource.ts`, `index.ts`) i `src/workers/` (`rpc.ts`, `WorkerPool.ts`, `index.ts`) w ścisłym TypeScript oraz 28 nowych testów jednostkowych Vitest (`tests/unit/byteSource.test.ts`, `cachedByteSource.test.ts`, `rpc.test.ts`, `workerPool.test.ts`).
- **Wynik:**
  - `ByteSource` zachowuje dokładny kontrakt §4.2 (`size`, `read(start, end)`, `slice(start, end)`) z walidacją zakresów (`RangeError`), offsetami `number` (bez `bigint`) i bezkopiowym `slice()`. `BlobByteSource` korzysta wyłącznie z `Blob.slice` + `await arrayBuffer()` na strukturalnym interfejsie `BlobLike` (bez zależności od `window`/DOM). Test akceptacyjny potwierdza odczyt 16 B z offsetu > 2 GiB na wirtualnym `ByteSource` bez alokacji 2 GiB RAM.
  - `CachedByteSource` utrzymuje LRU okien (domyślnie `64 × 256 KiB`, wyrównanie `CD_SECTOR_SIZE = 2048 B`, przycinanie ostatniego okna do `size`), deduplikuje współbieżne odczyty tego samego okna i udostępnia metryki (`hits`, `misses`, `evictions`, `sourceReads`, `bytesReadFromSource`, `cachedWindows`).
  - `src/workers/rpc.ts` implementuje typowany protokół `rpc:request` / `rpc:cancel` / `rpc:response` (`ok: true | false`) na minimalnym interfejsie `RpcEndpoint` / `RpcMessageTransport` (zweryfikowana kompilacyjnie zgodność z DOM `Worker`), z propagacją oryginalnego `name` i `message` błędu z workera, anulowaniem przez `AbortSignal` (przed wysłaniem i w locie) oraz transferem `Transferable` w obu kierunkach (`withTransfer`).
  - `src/workers/WorkerPool.ts` wylicza rozmiar puli wzorem `Math.min(4, Math.max(1, (hardwareConcurrency || 2) - 1))`, szereguje zadania w binarnej kolejce priorytetowej (FIFO przy równych priorytetach), obsługuje anulowanie zadań w kolejce i samonaprawę puli po krytycznym błędzie workera.
- **Pewność:** N/A (infrastruktura I/O i workerów M1; format `GT2.VOL` nie był parsowany; wyrównanie 2048 B odpowiada rozmiarowi sektora CD PS1 z ROADMAP M1.2).
- **Konsekwencje dla kodu:** Kontrakty `ByteSource`, `CachedByteSource`, `RpcClient`/`bindRpcServer` i `WorkerPool` są gotowe jako baza dla M1.5–M1.7 (fingerprint, uchwyt pliku, `IdbCache`) oraz M2 (`VolReader` i dekodery w workerach).
- **Otwarte pytania:** Brak na tym etapie; w kolejnej sesji wdrożyć M1.5–M1.7 (`fingerprint`, pamiętanie `FileSystemFileHandle` w IndexedDB, `IdbCache`).
