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

## 2026-11-25 — M1.5–M1.7 — Odcisk pliku (SHA-256), trwałość FileSystemFileHandle i IdbCache (domknięcie M1)
- **Pytanie:** Jak domknąć warstwę trwałości i identyfikacji plików M1 (§4.4) bez wczytywania dużych archiwów do RAM, bez zależności zewnętrznych i z pełną degradacją w przeglądarkach bez File System Access API / IndexedDB?
- **Metoda:** Implementacja `src/io/fingerprint.ts`, `src/io/fileHandleStore.ts` i `src/io/IdbCache.ts` w ścisłym TypeScript, integracja z `src/app/appState.ts`, `src/ui/fileLoaderScreen.ts`, `src/ui/styles.css` i `src/main.ts` oraz pokrycie 18 nowymi testami jednostkowymi Vitest (`fingerprint.test.ts`, `fileHandleStore.test.ts`, `idbCache.test.ts`) i weryfikacją e2e w Playwright (`tests/e2e/smoke.spec.ts`).
- **Wynik:**
  - `src/io/fingerprint.ts`: `fingerprint(source, options?)` liczy SHA-256 (`crypto.subtle.digest`) wyłącznie na 44-bajtowym nagłówku metadanych (`size`, opcjonalne `lastModified`, rozmiary próbek) oraz maksymalnie dwóch nienakładających się fragmentach z `ByteSource` (pierwszy 1 MiB + ostatni 1 MiB); test na wirtualnym źródle 640 MiB potwierdza dokładnie 2 odczyty bez dotykania środka pliku. Skrócony odcisk (`formatShortFingerprint`) wyświetla się w panelu statusu `Ready` z pełnym hashem w atrybucie `title`.
  - `src/io/fileHandleStore.ts`: `FileHandleStore` przechowuje `FileSystemFileHandle` w IndexedDB (przez wstrzykiwalny interfejs `FileHandleKeyValueBackend`) i obsługuje ponowne otwarcie po zgodzie użytkownika (`queryPermission` / `requestPermission`, z pasywnym wczytaniem uchwytu przy starcie bez automatycznego `requestPermission`). Przy braku File System Access API lub wyborze przez drag&drop / `<input type="file">` degraduje bez żadnych błędów konsoli.
  - `src/io/IdbCache.ts`: `IdbCache` (`klucz -> ArrayBuffer`) egzekwuje limit `maxBytes` z deterministycznym wywłaszczaniem najstarszych wpisów (LRU `accessedAt` + monotoniczne `seq`), unieważnia wpisy ze starszych wersji dekodera/schematu oraz udostępnia `clear()` i `buildCacheKey()`. Przycisk „Wyczyść dane” w UI czyści jednocześnie `IdbCache` i zapamiętany uchwyt pliku z potwierdzeniem stanu.
  - `src/ui/styles.css`: naprawiono overflow etykiety „Dostępne” przy `DecompressionStream('gzip')` (`min-width: 0`, `flex-wrap: wrap`, `overflow-wrap: anywhere`, `flex-shrink: 0; margin-left: auto`), zweryfikowano geometrycznie w Playwright (0 przepełnień).
  - Pełna bramka zielona: `tsc --noEmit`, `eslint .`, 16/16 plików Vitest (84/84 testy), `vite build` oraz 2/2 testy Playwright e2e (0 błędów konsoli i 0 odpowiedzi 4xx/5xx).
- **Pewność:** N/A (infrastruktura I/O, trwałości i UI domykająca M1; format `GT2.VOL` nie był parsowany).
- **Konsekwencje dla kodu:** Milestone M1 jest w pełni domknięty — gotowa jest kompletna podstawa (`ByteSource`, `CachedByteSource`, RPC, `WorkerPool`, `fingerprint`, `FileHandleStore`, `IdbCache`) do rozpoczęcia prac badawczych i parsera M2 (`GT2.VOL` + `gzip`).
- **Otwarte pytania:** Brak blokad w M1; kolejnym krokiem jest M2.1 (`src/formats/vol/header.ts`, zgodnie z Załącznikiem A i protokołem 🔬 z §2.1).


## 2026-11-25 — M2.11, M2.1–M2.5 — Generator syntetycznego `GT2.VOL` i czyste parsery (`header`, `offsets`, `toc`, `tree`, `sizes`)
- **Pytanie:** Jak zaimplementować deterministyczny generator syntetycznych archiwów `GT2.VOL` oraz bezstanowe, strumieniowe parsery nagłówka, tablicy offsetów, TOC, rekonstrukcji drzewa katalogów i wyliczania rozmiarów plików na poziomie **E2** (bez czytania prawdziwego `GT2.VOL` i bez wczytywania archiwum do RAM)?
- **Metoda:** Implementacja fixture buildera (`tests/fixtures/buildVol.ts`) oraz czystych modułów `src/formats/vol/` (`types.ts`, `header.ts`, `offsets.ts`, `toc.ts`, `tree.ts`, `sizes.ts`, `index.ts`) korzystających wyłącznie z `ByteSource` i `DataView(..., true)`, z pełnym pokryciem testami jednostkowymi Vitest (w tym TDD dla `tree.ts` na syntetycznym drzewie 3-poziomowym z wpisami `..`, pustym katalogiem z flagą `0x81`, plikami 0-bajtowym, wyrównanym do `0x800` i ostatnim plikiem z fallbackiem `0x800`).
- **Wynik:**
  - `tests/fixtures/buildVol.ts`: deterministyczny generator drzew o ≥ 3 poziomach zagnieżdżenia w porządku „first encounter”, wspierający `..` (`offsetIndex=0`), flagę `0x80`/`0x81`, pliki 0-bajtowe oraz mutacje negatywne (zły magic, ucięty plik, nieprawidłowe liczniki, błędne granice TOC, niemonotoniczne/nakładające się offsety).
  - `src/formats/vol/header.ts` + `types.ts`: weryfikacja magic `"GTFS\0\0\0\0"`, `files > 0 && totalEntries > 0 && totalEntries > files`, izolacja pola `unk_0x0C` (`0x0C..0x0F`, **E0**) oraz typowane błędy `VolError` (`BadMagic`, `TruncatedHeader`, `InvalidHeaderCounts`, itd.). Odczyt wyłącznie 16 B.
  - `src/formats/vol/offsets.ts`: odczyt wyłącznie `[0x10, 0x10 + files * 4)`, bezznakowe `splitOffset(raw)` (`>>> 0`, bezpieczne dla bitu 31) i dopisanie wirtualnego `offsets[files] = source.size`.
  - `src/formats/vol/toc.ts`: wyliczanie granic TOC wg A.4 z twardą walidacją `tocLength >= totalEntries * 32` i odczytem wyłącznie zakresu TOC; dekodowanie 32-bajtowych rekordów (`int32` czas UTC, `int16 offsetIndex`, `uint8 flags` z izolacją bitów `0x02..0x7E` **E0**, `char[25]` ASCII dopełnione zerami).
  - `src/formats/vol/tree.ts`: algorytm „first encounter” wg A.5; wpisy `..` oraz `offsetIndex === 0` nie trafiają do wyniku, a flaga `0x80` na nich przełącza bieżący katalog.
  - `src/formats/vol/sizes.ts`: wyliczanie rozmiarów plików wg A.6 (w tym pliki 0-bajtowe i fallback `0x800` dla ostatniego pliku przy wyniku `<= 0`) oraz niekrytyczne kontrole spójności (niemonotoniczne adresy, nakładanie zakresów, przekroczenie rozmiaru VOL) raportowane wyłącznie w `warnings`.
  - Wyrównano tabelę poziomów pewności `E0–E3` w `docs/formats.md` do `ROADMAP.md §3` i dopisano pełną specyfikację `GT2.VOL` na poziomie **E2**.
- **Pewność:** **E2** dla całej struktury `GT2.VOL` na podstawie kodu referencyjnego `adeyblue/GTVolTools` (`GT2VolFile.cs`, MIT); **E1** dla kodowania plików 0-bajtowych, monotoniczności adresów oraz założenia `offsetIndex !== 0` dla zwykłych katalogów; **E0** dla `header.unk_0x0C` (`0x0C..0x0F`) i bitów flag TOC `0x02..0x7E`.
- **Konsekwencje dla kodu:** Gotowy czysty rdzeń parsera `GT2.VOL` pod `VolReader` (M2.6) i weryfikację na realnym archiwum (M2.10).
- **Otwarte pytania (do zweryfikowania w M2.10 na prawdziwym `local_assets/GT2.VOL`):**
  1. Czy w prawdziwym `GT2.VOL` zwykłe katalogi **zawsze** mają `offsetIndex !== 0` (w odróżnieniu od wpisów `..` mających `offsetIndex === 0`)?
  2. Jak w prawdziwym `GT2.VOL` kodowane są pliki 0-bajtowe w tablicy offsetów (czy faktycznie `next.address === prev.address && prev.tail === 0`)?
  3. Czy wszystkie adresy plików w kolejności TOC są niemalejące i nienakładające się (0 ostrzeżeń w `warnings`)?
  4. Czy w prawdziwym `GT2.VOL` występują niezerowe wartości `unk_0x0C` (**E0**) lub nieznane bity flag TOC `0x02..0x7E` (**E0**)?
