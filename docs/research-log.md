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
