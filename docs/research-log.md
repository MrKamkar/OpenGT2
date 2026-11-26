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

## 2026-11-25 — M2.7, M2.6, M2.10 — Dekompresja gzip, VolReader w Workerze i weryfikacja na prawdziwym `GT2.VOL`
- **Pytanie:** Jak dostarczyć strumieniową dekompresję `gzip` (natywną + fallback `fflate`), warstwę `VolReader` w Web Workerze z bezpiecznym transferem buforów oraz zweryfikować wszystkie założenia E0/E1/E2 na prawdziwym `local_assets/GT2.VOL` bez wczytywania archiwum do RAM i bez umieszczania danych gry w repozytorium?
- **Metoda:**
  - M2.7: implementacja `src/formats/gzip/gunzip.ts` (`isGzipMagic`, `gunzip` na `DecompressionStream('gzip')` i `fflate` z jawną weryfikacją CRC-32 + ISIZE ze stopki RFC 1952) oraz testy obu ścieżek i uszkodzonych strumieni w `tests/unit/gzip.test.ts`.
  - M2.6: implementacja `src/formats/vol/VolReader.ts` (cache TOC i indeksu katalogów, leniwe wykrywanie `isGzip` przez 2-bajtowy odczyt `1F 8B`, integracja z `CachedByteSource` i `fingerprint`) oraz protokołu RPC (`src/workers/volReaderProtocol.ts`, `volReader.worker.ts`, `createVolReaderWorker.ts`) z kopiowaniem do dedykowanego bufora przed `withTransfer`, zweryfikowanym przez `structuredClone(..., { transfer })` w `tests/unit/volReader.test.ts`.
  - M2.10: strumieniowy test `tests/unit/volRealArchive.test.ts` na `NodeFileByteSource` (`fs/promises` `FileHandle.read`, pomijany przez `describe.skipIf` przy braku pliku w CI) przeciwko `local_assets/GT2.VOL`.
- **Wynik (statystyki zagregowane z prawdziwego `GT2.VOL`):**
  - Rozmiar archiwum: `488 241 152 B` (~465.62 MiB), `files = 11581`, `totalEntries = 11620`, `warnings = []` (0 ostrzeżeń spójności).
  - **Odpowiedź na pytanie 1:** `21/21` zwykłych katalogów ma `offsetIndex !== 0` (`0/21` ma `0`), a `21/21` wpisów `..` ma `offsetIndex === 0`. Część zwykłych katalogów ma `offsetIndex >= files` (np. do `11604` przy `files = 11581`), co potwierdza, że nie jest to indeks do tablicy offsetów, lecz prawdopodobnie indeks w przestrzeni TOC (dokładne znaczenie wskaźnika: **E1**).
  - **Odkrycie tablicy offsetów:** `offsets[files - 1]` (`offsets[11580]`) nie jest wskazywane przez żaden wpis TOC i zawiera jawny wpis końcowy EOF (`address = 488241152`, `tail = 0`), więc pliki zajmują `offsets[2 .. files - 2]` (`11578` plików; `11578 + 21 + 21 = 11620`). Wirtualny `offsets[files] = source.size` w `offsets.ts`/`sizes.ts` pozostaje bezpiecznikiem dla innych wydań GT2.
  - **Odpowiedź na pytanie 2:** Wszystkie `6/6` plików 0-bajtowych spełniają `next.address === address && tail === 0`.
  - **Odpowiedź na pytanie 3:** Wszystkie `11 578` plików ma adresy niemalejące, nienakładające się i mieszczące się w rozmiarze archiwum (`0` ostrzeżeń w `VolInfo.warnings`).
  - **Odpowiedź na pytanie 4:** `header.unk_0x0C = 0x00000000` oraz `0/11620` wpisów TOC ma zapalone bity `0x02..0x7E` (`0x00`) — pola pozostają jako **E0**.
  - **Weryfikacja gzip (M2.10):**
    - `5 114 / 5 114` (100%) plików `.gz` posiada magic `1F 8B` i rozpakowuje się bezbłędnie (CRC-32 + ISIZE OK) na obu backendach (`native` i `fflate`).
    - `91` plików bez rozszerzenia `.gz` zaczyna się od `1F 8B 08`: `84/91` to samodzielne strumienie gzip (100% PASS na obu backendach), natomiast `7/91` to wieloczęściowe kontenery kolejnych członów gzip rozdzielonych zerowym paddingiem do granicy `4 B` (`5` plików) lub sektora `2048 B` (`2` pliki) — pierwszy człon w każdym z tych `7` plików ma poprawny strumień i CRC-32, a ścisły `gunzip()` celowo zgłasza `Trailing junk`.
- **Pewność:** **E3** dla formatu `GT2.VOL` (nagłówek, tablica offsetów z jawnym EOF w `offsets[files - 1]`, granice TOC, rekordy 32 B, drzewo „first encounter”, wyliczanie rozmiarów, kodowanie plików 0 B, monotoniczność, standardowy gzip na `.gz` i samodzielnych plikach `1F 8B`); **E1** dla znaczenia `offsetIndex >= files` w katalogach i wewnętrznego układu 7 kontenerów wieloczłonowych; **E0** dla `unk_0x0C` oraz bitów flag `0x02..0x7E`.
- **Konsekwencje dla kodu:** `VolReader`, worker RPC i `gunzip` są zweryfikowane przeciwko prawdziwemu archiwum i gotowe do podpięcia pod UI Eksploratora (M2.8–M2.9). Przekazywanie kopii z własnym `ArrayBuffer` przed `withTransfer` chroni okna `CachedByteSource` przed odłączeniem (`detach`).
- **Otwarte pytania:**
  1. W M2.8–M2.9: podpiąć `VolReaderRpcClient` i `gunzip` do UI Eksploratora (drzewo katalogów, pobieranie surowego i rozpakowanego pliku).
  2. W M3/M4: zbadać dokładną strukturę 7 wieloczęściowych kontenerów bez `.gz` (zaczynających się od `1F 8B 08`) oraz weryfikować, na co dokładnie wskazuje `offsetIndex` w zwykłych katalogach.

## 2026-11-25 — M2.8–M2.9 — UI Eksplorator GT2.VOL oraz akcje na pliku (domknięcie M2)
- **Pytanie:** Jak zbudować responsywny, wirtualizowany eksplorator dla >11 500 wpisów z leniwym wykrywaniem gzip i lokalnym pobieraniem plików (surowych i rozpakowanych w Workerze), bez kolizji z `InputManager`, bez ładowania całego archiwum do RAM i bez użycia `SharedArrayBuffer`?
- **Metoda:**
  - M2.8: `src/ui/explorer/` (`explorerModel.ts`, `virtualRange.ts`, `lazyStatCache.ts`, `formatters.ts`, `explorerView.ts`), `src/app/volArchiveSession.ts`, `isEditableElement()` w `src/core/input/domInputBridge.ts` oraz integracja z `src/main.ts` i `src/ui/fileLoaderScreen.ts`. Pokrycie testami jednostkowymi (`explorerModel.test.ts`, `virtualRange.test.ts`, `lazyStatCache.test.ts`, `explorerFormatters.test.ts`, `volArchiveSession.test.ts`, `inputManager.test.ts`) i Playwright e2e (`tests/e2e/explorer.spec.ts` na syntetycznym VOL z 11 606 plikami).
  - M2.9: rozszerzenie `src/workers/volReaderProtocol.ts` o `readDecompressed` (wywołuje `gunzip()` w Workerze i zwraca wynik przez `withTransfer` bez odłączania okien `CachedByteSource`), `src/ui/explorer/fileActions.ts` (lokalne pobieranie `Blob` URL, nazewnictwo `.gz`/`.unpacked`, mapowanie błędów wieloczęściowych kontenerów gzip, hash `#hex=<path>&off=0x0` pod M3.1) oraz podpięcie akcji w `explorerView.ts` + testy (`fileActions.test.ts`, `volReader.test.ts`, `explorer.spec.ts`).
- **Wynik:**
  - Drzewo katalogów + wirtualizowana lista (`EXPLORER_ROW_HEIGHT = 28`, `EXPLORER_OVERSCAN = 8`) renderują jedynie widoczny wycinek DOM (< 60 wierszy przy >11 600 wpisach) i wyświetlają nazwę, rozmiar, datę `YYYY-MM-DD HH:MM:SS UTC` oraz flagę `gzip`.
  - `LazyStatCache` sonduje wyłącznie widoczne pliki (limit 4 równoległych `stat()`), anuluje wywołania po przewinięciu poza widok i przypina wybrany plik (`ensure()`), nie odpytując wszystkich 11 578 plików naraz.
  - `attachDomInputBridge` ignoruje `keydown` w polach edycyjnych (`isEditableElement`), dzięki czemu wyszukiwarka WSAD/strzałek/Spacji nie koliduje z `InputManager` (a `keyup` nadal zwalnia wcześniej wciśnięte klawisze).
  - Pliki niebędące `GT2.VOL` wyświetlają czytelny komunikat błędu przy zerowej liczbie `console.error`; pusty canvas WebGL2 pozostaje nietknięty (§1.1).
  - Akcje M2.9 („Podgląd hex” jako placeholder z docelowym hashem M3.1, „Pobierz surowy”, „Pobierz rozpakowany”) działają lokalnie na `Blob` URL; próba rozpakowania wieloczęściowego kontenera gzip kończy się czytelnym komunikatem w UI bez błędu konsoli i z możliwością pobrania pliku surowego.
- **Pewność:** N/A (zadania UI i warstwy aplikacji zamykające M2, oparte na kontrakcie `GT2.VOL` zweryfikowanym jako **E3** w M2.10).
- **Konsekwencje dla kodu:** Milestone M2 jest w pełni domknięty. Kolejnym etapem jest M3.1 (`src/tools/hexview` pod adresem `#hex=<path>&off=0x0`) oraz badanie 7 wieloczęściowych kontenerów gzip bez rozszerzenia `.gz`.
- **Otwarte pytania:** W M3 zintegrować przycisk „Podgląd hex” z właściwym widokiem hexview oraz dodać obsługę rozpakowywania wieloczłonowych kontenerów gzip.

## 2026-11-26 — M3.1–M3.4 — Narzędzia badawcze: Hex Viewer, Skaner sygnatur, Analizator i Klasyfikator formatów
- **Pytanie:** Jak dostarczyć strumieniowy, wirtualizowany widok hex (`raw` i `gunzip`), streamingowy skaner sygnatur z maskami działający w osobnym Workerze bez przesyłania surowych danych przez wątek główny, analizator entropii/histogramu/stride'ów oraz deklaratywny klasyfikator formatów bez dodawania zależności zewnętrznych i bez ładowania całych plików do RAM?
- **Metoda:**
  - M3.1: `VolReader.readRange`, `VolReaderRpcClient.readRange` / `readDecompressedRange` (z 1-slotowym cache ostatnio rozpakowanego pliku i kopiowaniem wycinków przed `withTransfer`), czysta logika `src/tools/hexview/` (`hashRoute.ts`, `interpreter.ts`, `hexFormat.ts`), wirtualizowany UI `src/ui/tools/hexViewPanel.ts`, integracja z `#hex=...` oraz poprawki UI Eksploratora (`id`/`name` na `<input>`, poziome przewijanie chroniące kolumnę `NAZWA`).
  - M3.2: rozszerzenie `src/workers/rpc.ts` o komunikaty `rpc:progress`, czysty parser wzorców z maskami (`??`, nibble) i streamingowy `scanByteSource` z nakładką `pattern.length - 1` i kontekstem `≤ 64 B` (`src/tools/scanner/`), dedykowany Worker (`src/workers/scanner.worker.ts`, `scannerProtocol.ts`) owijający bezpośrednio `BlobByteSource` na zakresie `[address, address + size)` oraz panel `src/ui/tools/scannerPanel.ts`.
  - M3.3: czysta logika `src/tools/analyzer/` (`entropy.ts`, `histogram.ts`, `stride.ts`, `analyze.ts`) i panel SVG `src/ui/tools/analyzerPanel.ts` (okno analizy ograniczone do 1 MiB, canvas WebGL2 nietknięty).
  - M3.4: deklaratywny rejestr `src/formats/registry.ts` (`FORMAT_REGISTRY`, `classifyFile`, `stripGzipExtension`) podpięty pod szczegóły Eksploratora (odczyt tylko 16 B nagłówka) oraz nagłówek Hex Viewera.
- **Wynik:**
  - Widok hex obsługuje skoki przez URL-hash `#hex=<path>&off=0x<hex>[&len=0x<hex>][&mode=raw|gunzip]`, zaznaczenie zakresu i interpretacje LE (`u8`, `s8`, `u16`, `s16`, `u32`, `s32`, `float32`) oraz fixed-point PS1 ze znakiem `4.12` (`int16 / 4096`) i `1.15` (`int16 / 32768`), bez kolizji z `InputManager`.
  - Skaner sygnatur z presety `gzip (1F 8B 08)`, `TIM (10 00 00 00)`, `GTFS (47 54 46 53 00 00 00 00)` i maskami `??` wykrywa trafienia na granicy okien odczytu z raportowaniem postępu i anulowaniem przez `AbortSignal`.
  - Analizator wylicza entropię Shannona (`0` dla stałych, `~8` dla równomiernych/losowych), histogram 256 koszyków oraz autokorelację stride'ów z tłumieniem harmonicznych (poprawnie wyróżnia fundamentalny stride `0x20` przed `0x40`).
  - Klasyfikator `registry.ts` utrzymuje ścisłe poziomy pewności (`GTFS` **E3**, `gzip` **E3**, `TIM` **E2**, `CDO/CNO` **E2**, `CDP/CNP` **E2**) i klasyfikuje nierozpoznane lub fałszywie nazwane pliki jako `unknown` (**E0**).
  - Bramka końcowa: `tsc --noEmit`, `eslint .`, `vitest` (35/35 plików, 174/174 testów), `vite build` oraz `playwright test` (5/5 testów e2e bez błędów konsoli i sieci).
- **Pewność:** **E3** dla `GTFS`/`gzip`, **E2** dla `TIM`/`CDO`/`CDP` (oczekują na weryfikację inwentaryzacyjną w M4.1), **E0** dla nierozpoznanych plików (`unknown`).
- **Konsekwencje dla kodu:** Pierwsza połowa M3 (M3.1–M3.4) jest kompletna i przetestowana na syntetycznych danych; narzędzia badawcze są gotowe do dokończenia M3.5–M3.8 oraz inwentaryzacji formatów GT2 w M4–M5.
- **Otwarte pytania:** W kolejnej sesji zrealizować M3.5–M3.8 (podgląd tablic struktur, eksport Evidence Pack, podgląd obrazu „na ślepo”, metodyka badań) oraz przejść do M4.1 na prawdziwym `GT2.VOL`.

---

## Metodyka badania nieznanego formatu binarnego (M3.8)

Poniższa procedura porządkuje pracę badawczą nad nieznanymi plikami z `GT2.VOL` (M4–M8) przy użyciu narzędzi z M3.1–M3.7 oraz reguł `ROADMAP.md` (§1.2, §2.3, §2.4, §3):

1. **Rozpoznanie wstępne i tryb strumienia (`registry.ts` + Hex Viewer M3.1):**
   - Sprawdź wynik klasyfikatora w szczegółach Eksploratora (`src/formats/registry.ts`, odczyt wyłącznie pierwszych 16 B) oraz flagę `gzip` (`1F 8B`).
   - Dla plików skompresowanych przełącz Hex Viewer w tryb `gunzip` (`#hex=<path>&off=0x0&mode=gunzip`), aby badać właściwy ładunek po dekompresji bez ładowania całego archiwum do RAM.
2. **Skanowanie sygnatur (`scannerPanel.ts` / Worker M3.2):**
   - Przeskanuj plik w Workerze presetami (`gzip`, `TIM 10 00 00 00`, `GTFS`) lub własnym wzorcem z maską `??`.
   - Trafienia skanera pozwalają jednym kliknięciem skoczyć do offsetu w Hex Viewerze i zlokalizować osadzone kontenery lub nagłówki sekcji.
3. **Analiza entropii i histogramu bajtów (`analyzerPanel.ts` M3.3):**
   - **Entropia bliska `8.0 bit/B`** + płaski histogram → dane skompresowane lub zaszyfrowane (sprawdź kolejne człony `gzip` lub inne strumienie).
   - **Entropia `0.0–2.0 bit/B`** + dominacja `0x00`/`0xFF` → padding, puste tablice lub maski.
   - **Entropia `3.5–6.5 bit/B`** ze skokami na wykresie okien → wyraźne granice między nagłówkiem, tablicami struktur i danymi pikseli/geometrii.
4. **Wykrywanie powtarzalnych `stride`'ów (autokorelacja M3.3):**
   - Odczytaj sugerowany fundamentalny `stride` (tłumienie harmonicznych wskazuje najmniejszy okres powtarzalności, np. `0x20` przed `0x40`).
   - Zweryfikuj granice sekcji w Hex Viewerze (`off + count * stride`).
5. **Podgląd jako tablica struktur i wartości kandydujące (`structViewPanel.ts` M3.5 + Inspektor M3.1):**
   - Zaznacz podejrzane bajty w Hex Viewerze i porównaj interpretacje LE (`u8/s8/u16/s16/u32/s32`, `float32`, PS1 fixed-point `4.12` i `1.15`).
   - Przełącz się do podglądu struktury „jako tablica”, podaj `baseOffset`, `stride` i `count` oraz nazwij znane lub hipotetyczne pola (nieznane pozostaw jako `unk_<offset>`).
   - Zapisz definicję schematu jako JSON (`Kopiuj JSON` / `Pobierz JSON`) na potrzeby dalszych testów lub dokumentacji.
6. **Podgląd obrazu „na ślepo” (`blindImagePanel.ts` M3.7):**
   - Jeśli sekcja ma regularny rozmiar lub niską/średnią entropię pasującą do bitmapy, przetestuj parametry w podglądzie „na ślepo” (`4 bpp` parzysty=młodszy nibble, `8 bpp`, `15-bit A1B5G5R5 LE`, opcjonalny offset palety CLUT 15-bit, skala `1×/2×/4×`).
   - Zmieniaj szerokość (np. `64`, `128`, `256`) i offset aż do uzyskania czytelnych kafelków lub atlasu tekstur — bez zgadywania dedykowanego nagłówka.
7. **Hipoteza, niezmienniki i weryfikacja na wielu plikach:**
   - Sprawdź niezmienniki arytmetyczne (np. `baseOffset + count * stride == fileSize` lub początek kolejnej sekcji, indeksy `< count`, długości normalnych `≈ 1.0`).
   - Zweryfikuj tę samą hipotezę na **wielu plikach** tego samego katalogu/typu w `GT2.VOL`. Jeśli warunek zawodzi lub dwa źródła są sprzeczne — **STOP** (§2.3).
8. **Ocena poziomu pewności (`E0–E3`) i eksport Evidence Pack (`evidencePackPanel.ts` M3.6):**
   - Nadaj rygorystyczny poziom: `E0` (nieznane), `E1` (obserwacja z danych), `E2` (potwierdzone w źródle referencyjnym/dokumentacji), `E3` (potwierdzone źródłem + testem na realnym pliku).
   - Zbierz kluczowe trafienia z Hex Viewera / Skanera do **Evidence Pack** (twardy limit **≤ 64 B** próbki hex na wpis wg §1.2), pobierz lokalny JSON jako załącznik do analizy i opisz fakty w `docs/formats.md` oraz `docs/research-log.md`.

## 2026-11-26 — M3.5–M3.8 — Podgląd tablic struktur, Evidence Pack, Blind Image i metodyka badań
- **Pytanie:** Jak domknąć zestaw narzędzi badawczych M3 (tablice struktur z eksportem schematu JSON, bezpieczny eksport odkryć Evidence Pack ≤ 64 B, generyczny podgląd surowych bitmap PS1 oraz udokumentowana metodyka badań) przy zachowaniu pełnej separacji od danych Sony i bez pisania dedykowanych parserów M4?
- **Metoda:**
  - M3.5: czysta logika `src/tools/structview/` (`types.ts`, `decoder.ts`, `schemaJson.ts`, `index.ts`) z `DataView(..., true)` LE i stronicowaniem, panel `src/ui/tools/structViewPanel.ts`, testy `tests/unit/structView.test.ts` oraz poprawka CSS siatki Hex Viewera (pełna szerokość 16 znaków `ASCII` bez ucinania przy inspektorze LE).
  - M3.6: czysta logika `src/tools/evidence/` (`types.ts`, `evidencePack.ts`, `index.ts`) z twardą walidacją limitu `EVIDENCE_MAX_HEX_SAMPLE_BYTES = 64` przy tworzeniu i serializacji, panel `src/ui/tools/evidencePackPanel.ts`, szybkie przechwytywanie z `hexViewPanel.ts` i `scannerPanel.ts`, testy `tests/unit/evidencePack.test.ts`.
  - M3.7: czysta logika `src/tools/blindimage/` (`types.ts`, `decoder.ts`, `index.ts`) dla trybów `4 bpp` (parzysty piksel = młodszy nibble), `8 bpp`, `15-bit A1B5G5R5` LE (Załącznik B.1) i opcjonalnego CLUT 15-bit LE, panel `src/ui/tools/blindImagePanel.ts` z własnym `<canvas>` 2D (`image-rendering: pixelated`, przełącznik skali `1× / 2× / 4×`, główny canvas WebGL2 nietknięty) oraz testy `tests/unit/blindImage.test.ts`.
  - M3.8: ustrukturyzowana dokumentacja metodyki badań w `docs/research-log.md` i rozszerzenie testów Playwright `tests/e2e/explorer.spec.ts` na syntetycznych danych VOL.
- **Wynik:**
  - Wszystkie trzy narzędzia działają wyłącznie na strumieniowych odczytach potrzebnego zakresu bajtów (`readRange` / `readDecompressedRange`), używają `id`/`name` na polach formularzy i nie kolidują z `InputManager`.
  - Testy jednostkowe i e2e potwierdzają m.in. poprawność kolejności nibbli `4 bpp`, brak zamiany `R↔B` w `A1B5G5R5` LE, skalowanie `1×/2×/4×`, twardą blokadę eksportu próbek `> 64 B` w Evidence Pack oraz pełną widoczność 16 znaków `ASCII` w Hex Viewerze.
- **Pewność:** N/A dla narzędzi generycznych M3; zastosowane konwencje sprzętowe PS1 (`LE`, `4.12`/`1.15`, `4 bpp` nibble order, `A1B5G5R5`) mają status **E2** wg Załącznika B (`ROADMAP.md`).
- **Konsekwencje dla kodu:** Milestone M3 jest w pełni domknięty — kompletny warsztat badawczy (M3.1–M3.8) jest gotowy do przeprowadzenia inwentaryzacji formatów obrazów `GT2.VOL` w M4.1.
- **Otwarte pytania:** W kolejnej sesji rozpocząć M4.1 (inwentaryzacja formatów obrazów w lokalnym `GT2.VOL` z wpisem do `docs/formats.md`).

## 2026-11-26 — M4.1 — Inwentaryzacja formatów obrazów w `GT2.VOL`
- **Pytanie:** Jakie formaty obrazów i tekstur faktycznie występują w lokalnym `GT2.VOL` (po rozpakowaniu pojedynczych strumieni gzip oraz zbadaniu członów w 7 wieloczłonowych kontenerach `1F 8B`), czy występują prawdziwe pliki TIM i jaki powinien być dokładny zakres parserów M4.3 (`tim/`) i M4.4 (`gtimg/`)?
- **Metoda:** Strumieniowy skan wszystkich `11 578` plików w `tests/unit/volImageInventory.test.ts` przez `NodeFileByteSource` + `CachedByteSource` + `VolReader` (zero wczytywania całego VOL do RAM, sekwencyjne okna `1 MiB` dla kontenerów wieloczłonowych `~40 MB`, rygorystyczna walidacja nagłówka TIM `magic 0x10` + flagi + spójność `clut.bnum` i `img.bnum`).
- **Wynik (zagregowane statystyki bez nazw plików z gry):**
  - **Prawdziwe obrazy TIM (`3 729` instancji, `0` fałszywych trafień):**
    - `3 576` surowych plików `.tim` (`3 539` w `4 bpp + CLUT`, `37` w `4 bpp` bez CLUT; `100%` ścisła zgodność `bnum`),
    - `129` plików `.tim.gz` (`120` w `4 bpp + CLUT`, `7` w `8 bpp + CLUT`, `2` w `4 bpp` bez CLUT), w tym `95` ze ścisłym `img.bnum` oraz `34` pliki `4 672 B` (`24×96`, `4 bpp + CLUT`) z anomalią `img.bnum = 12 + 2·imgW·imgH·2` (`9 228` zamiast `4 620`) przy dokładnym dopasowaniu rozmiaru pliku do `imgOff + 12 + imgW·imgH·2`,
    - `2` bezrozszerzeniowe kontenery multi-gzip (wyrównanie `2048 B`) zawierające po `12` członów (`24` łącznie) w trybie `16 bpp` bez CLUT (`10 00 00 00 02 00 00 00`, `100%` ścisła zgodność `bnum`).
  - **Obrazy menu GT2 (`GM` / `GTMP`):**
    - `5` kontenerów `.dat` multi-gzip (wyrównanie `4 B` i `2048 B`) zawierających `12 658` członów z magic `47 4D 03 00` (`"GM\x03\x00"`), `0` TIM,
    - `1` surowy plik `.dat` (`44 724 224 B`) z magic `47 54 4D 50` (`"GTMP"`).
  - **Tekstury modeli aut i kandydaci badawczy:**
    - `2 220` plików `.cdp.gz` / `.cnp.gz` (`1 110 + 1 110`): `100%` dokładny rozmiar `45 984 B` (`0x43A0 + 0x7000`, Załącznik D.7),
    - `160` plików `.trp.gz` (`126`) + `.bsp.gz` (`34`): `100%` ma `uint32[1] === 0x10` (nie są standardowym TIM),
    - `261` plików z powtarzalnym magic `00 00 02 01` (`180` `.lgf.gz` o stałym rozmiarze `36 956 B` + `81` pojedynczych plików gzip bez rozszerzenia).
- **Pewność:** **E3** dla występowania i statystyk `.tim`, `.tim.gz` (w tym anomalii `img.bnum` w 34 plikach), `2` kontenerów multi-gzip TIM `16 bpp`, magic `GM\x03\x00` / `GTMP` oraz stałego rozmiaru `.cdp/.cnp`; **E2** dla wewnętrznej struktury `GM`/`GTMP` i `.cdp/.cnp`; **E1** dla `.trp/.bsp` oraz `00 00 02 01` (`.lgf.gz`).
- **Konsekwencje i rekomendacje dla M4.3 / M4.4:**
  - **M4.3 (`tim/`) jest ZDECYDOWANIE POTRZEBNE:** w archiwum znajduje się `3 729` pełnoprawnych obrazów TIM we wszystkich 3 trybach indeksowanych/direct (`4 bpp`, `8 bpp`, `16 bpp`). Parser `tim/` powinien też obsługiwać udokumentowaną anomalię `img.bnum = 12 + 2·imgW·imgH·2`, gdy `imgOff + 12 + imgW·imgH·2 === fileLength`.
  - **M4.4 (`gtimg/`) — dokładny zakres:** skupić się na formatach menu `GM\x03\x00` (w tym rozpakowaniu wieloczłonowych kontenerów `.dat` + indeksów `.idx`) oraz kontenerze `GTMP` wg `GTVolTools`. Tekstury aut `.cdp/.cnp` zostają w M6.7, tekstury torów `.trp/.bsp` w M8, a format `00 00 02 01` (`.lgf.gz`) pozostaje jako E1 poza zakresem M4.4 do czasu niezależnego potwierdzenia.
- **Otwarte pytania:** W kolejnej sesji (M4.3–M4.4) zweryfikować nagłówek `GM\x03\x00` i `GTMP` względem `GTVolTools` (`GMImage.cs`, `Image.cs`) oraz zaimplementować czytnik wieloczłonowych kontenerów gzip.

## 2026-11-26 — M4.2 — Konwersja kolorów PS1 `A1B5G5R5` ↔ `RGBA8888` i dekodowanie CLUT
- **Pytanie:** Jak ujednolicić czystą konwersję kolorów PS1 `15-bit A1B5G5R5` (`bit 15 = STP`, `14..10 = B`, `9..5 = G`, `4..0 = R`) oraz obsługę wszystkich 4 przypadków sprzętowych przezroczystości wraz z round-tripem nieprzezroczystej czerni i dekodowaniem tablic CLUT LE?
- **Metoda:** Implementacja czystego modułu `src/formats/ps1/color.ts` + `src/formats/ps1/index.ts` (zero DOM/WebGL/`window`, `DataView(..., true)` LE) oraz testów jednostkowych w `tests/unit/ps1Color.test.ts`.
- **Wynik:**
  - `ps1Color15ToRgba` obsługuje wszystkie 4 przypadki sprzętowe (`0x0000`, `0x8000`, kolor niezerowy bez STP, kolor niezerowy z STP) dla trzech jawnych trybów `TransparencyMode`: `'opaque'`, `'transparent-zero'` i `'stp-semi-transparent'` (z walidacją `semiTransparentAlpha`).
  - `rgbaToPs1Color15` kwantyzuje kanały `8→5 bit` (`compress8To5`, dokładna odwrotność `(c << 3) | (c >> 2)` dla wszystkich 32 wartości) i w trybie `'transparent-zero'` mapuje widoczną czerń `(0, 0, 0, 255)` na `0x8000` (`PS1_OPAQUE_BLACK`), a `a === 0` na `0x0000` (`PS1_TRANSPARENT_BLACK`).
  - Dodano dekodery CLUT LE: `decodeClut15ToUint16`, `clut15Uint16ToRgba` i `decodeClut15ToRgba` z bezpiecznym przycinaniem niekompletnych końcówek.
  - Istniejący `src/tools/blindimage/decoder.ts` może w przyszłości współdzielić ten moduł przy zachowaniu zgodności interfejsów (bez refaktoryzacji w M4.2).
- **Pewność:** **E2** (sprzętowa specyfikacja PSX-SPX / Załącznik B.1; do wykorzystania w M4.3–M4.9).
- **Otwarte pytania:** W kolejnej sesji wdrożyć M4.3 (`src/formats/tim/` z obsługą anomalii 34 plików `.tim.gz`) oraz M4.4 (`src/formats/gtimg/` dla `GM`/`GTMP`).

## 2026-11-26 — M4.5, M4.3, M4.4 — Model `IndexedImage`, czysty parser `TIM` oraz dekodery menu `GM` / `GTMP` / `.idx`
- **Pytanie:** Jak ujednolicić model tekstur indeksowanych (`IndexedImage`), zweryfikować parser PS1 `TIM` na wszystkich `3 729` instancjach w `GT2.VOL`, ustalić rzeczywistą strukturę obrazów menu `GM\x03\x00` i `GTMP` (w tym relację z 6 plikami `.idx`) oraz zaimplementować czyste, w 100% przeglądarkowe dekodery w `src/formats/`?
- **Metoda:**
  - M4.5 (`src/formats/ps1/indexedImage.ts`): implementacja `IndexedImage`, `DecodedRgbaImage`, `unpack4BppIndices` oraz `decodeIndexedImageToRgba` z obsługą `TransparencyMode`, krótkich palet i braku CLUT.
  - M4.3 (`src/formats/tim/`): implementacja parsera TIM (4/8/16/24 bpp), akceptacja anomalii `img.bnum` w 34 plikach `.tim.gz` z ostrzeżeniem, syntetyczne testy `tests/unit/tim.test.ts` oraz strumieniowa weryfikacja w `tests/unit/timRealArchive.test.ts`.
  - M4.4 (`src/formats/gtimg/`): strumieniowe sondowanie `local_assets/GT2.VOL`, weryfikacja z kodem referencyjnym `adeyblue/GTVolTools` (MIT, sklonowanym tymczasowo poza repo do `%TEMP%\gtvoltools-ref` i usuniętym po zakończeniu prac), implementacja czystych dekoderów (`gmImage.ts`, `gtmp.ts`, `color.ts`, `idxContainer.ts`) na `ByteSource` i `src/formats/gzip` (zero `node:*` w `src/`) oraz testy `tests/unit/gtimg.test.ts` i `tests/unit/gtimgRealArchive.test.ts`.
- **Wynik:**
  - **M4.5 (`a03299d`):** 6 testów jednostkowych przeszło (4/8 bpp, wiele palet, krótsze palety, tryby przezroczystości, brak palet → szarość).
  - **M4.3 (`bab58a6`):** `3 729 / 3 729` obrazów TIM z `local_assets/GT2.VOL` sparsowanych i zdekodowanych bezbłędnie (`3 576` surowych `.tim` z `0` warningów, `129` `.tim.gz` w tym `95` ścisłych i dokładnie `34` z ostrzeżeniem podwojonego `img.bnum`, oraz `24` człony `16 bpp` z `2` kontenerów multi-gzip).
  - **M4.4 (`2f10838`) — odkrycia i weryfikacja na `GT2.VOL`:**
    - `6` plików `.idx` jednoznacznie paruje się po `totalDataSize === dat.size`: `1 × aligned-2048` dla surowego `GTMP` (`458` bloków, `44 724 224 B`) oraz `5 × mangled-4` (`offset = raw & ~3`, `tail = raw & 3`, `size = nextOffset - offset - tail`) dla `5` kontenerów `.dat` `GM\x03\x00`. Wyjaśniło to rozbieżność z M4.1 (`12 658` vs **`16 914`** członów): `node:zlib` w M4.1 automatycznie łączył sąsiednie człony gzip z `tail === 0`.
    - **`GM\x03\x00` (`16 914 / 16 914`):** wbrew skrótowemu opisowi z ROADMAP („8-bitowe indeksy”), są to obrazy **4 bpp** (`32` palety × `16` kolorów, kafelki `16×8`, płótno `512×504`, sekcja `GMLL`, grupy `subBlockSets` `0..4` w licznościach `4239, 280, 2940, 9330, 125`, `backgroundIndex` `0..457`, `419` plików z trailing bytes za ostatnim wierszem kafelków). Wszystkie `1 173 912` niezerowych wpisów palet `GM` mają bit `15 === 0` (`gmColor15ToRgba`).
    - **`GTMP` (`458 / 458`):** kafelki **8 bpp** (`16` palet × `256` kolorów, `2 016` pozycji przy `0x0004..0x1F83`, płótno `512×504`, dane pikseli od `0x4000` zawsze jako wielokrotność `4 096 B`). Wszystkie `599 200` niezerowych wpisów palet `GTMP` mają bit `15 === 1`, a wszystkie `609 537` jednolitych kafelków (`solidFlags !== 0`) mają bit `15 === 0` i wymuszają `alpha = 255`.
    - Strumieniowy czytnik przeglądarkowy (`readGmContainerEntry` przez `ByteSource` + `src/formats/gzip`) zweryfikowany na `75` próbkach z `5` kontenerów + pełny przelot `16 914 / 16 914` `GM` i `458 / 458` `GTMP`.
- **Pewność:** **E3** dla TIM (`4/8/16 bpp`, CLUT, anomalia `img.bnum`), `.idx` (`aligned-2048` / `mangled-4`), `GM\x03\x00` i `GTMP`; **E2** dla TIM `24 bpp`; **E1** dla liczników `GTMP` przy `0x3f84/0x3f88`; **E0** dla `IconImageBox.unk_0x08` (`0x000b`) oraz pozostałych bajtów `GTMP.unk_0x3f84` (`0x3f8c..0x3fff`).
- **Konsekwencje dla kodu:** Cała warstwa czystych dekoderów obrazów z M4 (`color.ts`, `indexedImage.ts`, `tim/`, `gtimg/`) jest gotowa jako podstawa dla UI/podglądu/galerii/PNG/WebGL w M4.6–M4.9 oraz tekstur aut `.cdp/.cnp` w M6.7.
- **Otwarte pytania:**
  - W M4.6–M4.9 podpiąć dekodery `tim/` i `gtimg/` pod UI (podgląd 2D, przełączanie palet, miniatury w Workerach, eksport PNG, upload do WebGL `R8` + `RGBA8`).
  - Zweryfikować znaczenie `IconImageBox.unk_0x08` (**E0**) i reszty `GTMP.unk_0x3f84` (`0x3f8c..0x3fff`, **E0**), jeśli będą potrzebne poza dekodowaniem pikseli.

## 2026-11-26 — M4.6–M4.9 — Podgląd obrazów 2D, galeria miniatur w Workerach, eksport PNG i loader tekstur WebGL2
- **Pytanie:** Jak zintegrować z Eksploratorem pełny podgląd obrazów 2D dla wszystkich formatów zweryfikowanych w M4.3–M4.4 (`.tim`, `.tim.gz`, multi-gzip TIM `16 bpp`, kontenery `.dat` + `.idx` `GM\x03\x00` i `GTMP`), leniwą galerię miniatur dla katalogów z tysiącami plików bez skoku RAM, lokalny eksport PNG 1:1 oraz przygotowanie tekstur indeksowanych do WebGL2 (`R8` + `RGBA8`) bez naruszania pustego stanu głównego canvasa WebGL2?
- **Metoda:**
  - M4.6: `src/formats/gzip/multiMember.ts` (przeglądarkowy ekstraktor wieloczłonowych kontenerów gzip bez `node:zlib`, zweryfikowany w `tests/unit/timRealArchive.test.ts` na wszystkich `24/24` członach TIM w `GT2.VOL`), `src/workers/imageDecoderProtocol.ts` + `imageDecoder.worker.ts` (strumieniowe odczyty wycinków `BlobByteSource`, parowanie `.dat` + `.idx` po `totalDataSize === dat.size`, transfer RGBA przez `Transferable`), `src/ui/imageViewer/` (`imageViewerModel.ts`, `imageViewerPanel.ts`) z kontrolkami CLUT, przezroczystości, zoomu `1×/2×/4×`, nawigacji `#0..N-1` oraz widoku `composed`/`tileSheet` dla `GM\x03\x00`/`GTMP`.
  - M4.7: `src/ui/imageViewer/thumbnailCache.ts` (`ThumbnailLruCache` z limitem `96` wpisów / `6 MiB` + czysta matematyka wirtualnej siatki) oraz `thumbnailGalleryPanel.ts` (wirtualizowana siatka + `IntersectionObserver` + pula workerów `TaskPriority.Low` z limitem 4 równoległych zadań + anulowanie `AbortSignal` przy przewinięciu/zmianie katalogu + jawne zerowanie `canvas.width = 0; canvas.height = 0` przy odmontowaniu kafelka).
  - M4.8: `src/ui/imageViewer/pngExport.ts` (`buildPngExportFilename` + lokalny eksport 1:1 przez `canvas.toBlob('image/png')` i `URL.createObjectURL` / `revokeObjectURL`).
  - M4.9: `src/renderer/indexedTexture.ts` (`prepareIndexedTextureData` z zerowaniem nieużywanych kolumn `16..255` i deterministyczną skalą szarości dla `palettes: []`, oraz `uploadIndexedTexture` dla `R8` + `256×H RGBA8` z `NEAREST`, `CLAMP_TO_EDGE`, `UNPACK_ALIGNMENT = 1`, obsługą błędu drugiego `createTexture()` i idempotentnym `dispose()`).
- **Wynik:**
  - Pełna bramka jakościowa (`tsc --noEmit`, `eslint .`, `vitest`: `49/49` plików, `241/241` testów, `vite build`) oraz `7/7` testów Playwright E2E przeszły bez błędów konsoli i sieci przy nietkniętym głównym canvasie WebGL2.
  - Przeglądarkowy `extractMultiMemberGzip` zdekodował `24/24` członów `16 bpp` TIM z lokalnego `GT2.VOL` identycznie jak wcześniejsza ścieżka `node:zlib`.
- **Pewność:** **E3** dla obsługiwanych formatów wejściowych (`.tim`, `.tim.gz`, multi-gzip TIM, `.idx`, `GM\x03\x00`, `GTMP`); **E2** dla mapowania WebGL2 `R8` + `256×H RGBA8` wg Załącznika B.3 (do pełnego potwierdzenia wizualnego w M7).
- **Konsekwencje dla kodu:** Milestone M4 jest w pełni domknięty; `uploadIndexedTexture` jest gotowe do użycia przy teksturach aut (`.cdp/.cnp` w M6.7) i rendererze M7, a Eksplorator obsługuje przeglądanie i eksport wszystkich zweryfikowanych formatów 2D.
- **Otwarte pytania:** W kolejnym etapie rozpocząć M5 (baza danych gry w `*gtmode_data.dat*`, najpierw badania M5.1 zgodnie z protokołem 🔬 z §2.1).

## 2026-11-26 — M5.1 — Weryfikacja plików bazy danych GT2 i układu kontenera `GTDT`
- **Pytanie:** Jakie warianty regionalne/językowe plików bazy danych występują w `local_assets/GT2.VOL`, czy wszystkie są pojedynczymi strumieniami gzip (`1F 8B`), jak dokładnie wygląda nagłówek kontenera przed tablicą `(offset, size)` oraz czy wszystkie 24 nazwane struktury z `GT2DataExploder/structs.h` spełniają `size % elementSize === 0`?
- **Metoda:** Strumieniowy odczyt wpisów `local_assets/GT2.VOL` przez `Node.js` (`fs/promises` `FileHandle.read` bez ładowania archiwum do RAM) z użyciem `zlib.gunzipSync` oraz porównanie z `GT2DataExploder/structs.h` i `main.cpp` z `adeyblue/GTVolTools` (MIT, sklonowanym tymczasowo do `%TEMP%\gtvoltools-ref`).
- **Wynik (statystyki zagregowane bez list nazw plików gry):**
  - W katalogu bazy danych występuje `29 / 29` pojedynczych plików gzip (`1F 8B 08`, 100% poprawny rozpakowany strumień):
    - `7` standardowych baz aut `(<region>_)?gtmode_data.dat.gz` (`5` identycznych wariantów PAL: `eng`, `fra`, `ger`, `ita`, `spa` o rozmiarze `776 504 B` / `621` aut; `usa` `772 276 B` / `618` aut; bezprefiksowy JP `765 516 B` / `613` aut).
    - `7` standardowych baz wyścigów `(<region>_)?gtmode_race.dat.gz` (`5` identycznych PAL `171 334 B`, `usa` `170 566 B`, bezprefiksowy JP `169 606 B`: `248` wyścigów `RaceInfo` `0x9C`, `1228`/`1220`/`1210` przeciwników `OpponentInfo` `0x60`, `94` list ograniczeń `0x80`, `2 670 B` tablicy napisów).
    - `3` warianty `arcade_data` (`41 250 B`, `pairCount = 68`), `3` warianty `license_data` (`36 432 B`, `pairCount = 64`), `2` warianty deweloperskie `*_dev` (`gtmode_data_dev` z nazwami ASCII w 30 sekcjach + puste `[30]`; `gtmode_race_dev` `32 B` z zerami) oraz `7` baz napisów `WSDB` (`eng`, `fra`, `ger`, `ita`, `jpn`, `spa`, `usa`; `846` PAL / `851` USA / `764` JP napisów).
  - **Nagłówek `GTDT`:** `4 B` magic `"GTDT"`, `uint16 LE formatFlag = 0x006C` (`'l', '\0'`, `22/22` plików), `uint16 LE pairCount` (liczba par 8-bajtowych `(offset, size)` w katalogu — na `21/21` niepustych plikach `8 + pairCount * 8 === firstOffset`, a `GT2DataExploder` błędnie dzielił to pole przez `2`, co ukryły zera w parach `31..61`).
  - **Zgodność `gtmode_data` ze `structs.h`:** wszystkie `31` aktywnych par `[0..30]` są ułożone bez przerw (`gap = 0`) aż do dokładnego końca pliku (`diff = 0`), pary `[31..61]` to `(0, 0)`, a wszystkie `24` nazwane struktury (`CarBrakes` `0x0C` .. `CarData` `0x48`) mają `0` niezgodności `size % elementSize` we wszystkich `7/7` wariantach (`CarDimensions`, `CarEngineData`, `CarDrivetrain`, `CarData` dają spójne `621`/`618`/`613`).
- **Pewność:** **E3** dla kontenera `GTDT`, układu `31` tablic `gtmode_data`, `4` tablic `gtmode_race`, rozmiarów `24` struktur oraz nagłówka `WSDB`; **E1** dla znaczenia `formatFlag = 0x006C`; **E0** dla sekcji `2` i `24..29` (`ParseNothing`).
- **Konsekwencje dla kodu:** Nie wystąpił żaden warunek STOP — w M5.2 można zaimplementować deklaratywny parser układu `GTDT` (`src/formats/gtdb/layout.ts`) oraz wyszukiwarkę wariantów regionalnych `findGtdbEntries` bez hardcodowania prefiksu regionu (z wykluczeniem `*_dev`).
- **Otwarte pytania:** W M5.2 zweryfikować wszystkie wykryte warianty testem integracyjnym w Vitest; w M5.3–M5.4 zdekodować rekordy struktur i napisy `WSDB`.

## 2026-11-26 — M5.2 — Deklaratywny parser układu `GTDT` (`src/formats/gtdb/`) i walidacja spójności
- **Pytanie:** Jak dostarczyć czysty, niezależny od środowiska przeglądarkowego parser układu tablic bazy danych `GTDT` z twardą walidacją granic, nakładania niepustych sekcji oraz podzielności `size % elementSize === 0`, a także wzorcowe wyszukiwanie wariantów regionalnych bez hardcodowania jednego prefiksu?
- **Metoda:** Implementacja `src/formats/gtdb/` (`types.ts`, `layout.ts`, `index.ts`) z atrybucją MIT dla `adeyblue/GTVolTools`, aktualizacja `src/formats/registry.ts` o sygnaturę `GTDT` (`E3`), budowanie syntetycznych buforów w `tests/fixtures/buildGtdb.ts` oraz testy jednostkowe (`tests/unit/gtdbLayout.test.ts`) i strumieniowy test integracyjny (`tests/unit/gtdbRealArchive.test.ts`).
- **Wynik:**
  - `GTMODE_DATA_TABLE_SPECS` deklaruje `31` tablic (`0..30`, 24 nazwane struktury `E3` i 7 sekcji `E0` `unk_section_*`) w kolejności z `GT2DataExploder/structs.h`; `GTMODE_RACE_TABLE_SPECS` deklaruje `4` sekcje `gtmode_race`.
  - `parseGtdbLayout` waliduje magic `"GTDT"`, minimalny `pairCount`, granice katalogu i wszystkich sekcji, brak nakładania niepustych zakresów (z dopuszczeniem pustych sekcji `size === 0` oraz luk/paddingu między sekcjami) oraz `size % elementSize === 0` (rzucając typowany `GtdbError`).
  - `findGtdbEntries` wykrywa po wzorcach wszystkie warianty regionalne `gtmode_data`, `gtmode_race`, `unistrdb`, `arcade_data` i `license_data` z pominięciem stubów `*_dev`.
  - Test na realnym `local_assets/GT2.VOL` zweryfikował strumieniowo wszystkie `7/7` wariantów `gtmode_data` (spójna liczba rekordów `CarData === CarDimensions === CarEngineData === CarDrivetrain` oraz `CarTyres === CarRearTyres`) i `7/7` wariantów `gtmode_race`.
- **Pewność:** **E3** dla parsera układu `GTMODE_DATA_TABLE_SPECS` i `GTMODE_RACE_TABLE_SPECS` oraz sygnatury `GTDT` w `registry.ts`.
- **Konsekwencje dla kodu:** Fundament `src/formats/gtdb/` jest gotowy do implementacji dekoderów poszczególnych struktur (`CarDimensions`, `CarEngineData`, `CarGearbox`, `CarSuspension`, `CarTyres`, `CarData`) w M5.3.
- **Otwarte pytania:** W M5.3 zaimplementować dekodery rekordów struktur (z izolacją pól **E0** jako `unk_0x..`), a w M5.4 zbadać kodowanie i dekoder `WSDB` (`unistrdb`).

## 2026-11-26 — M5.3 — Dekodery 6 struktur bazy aut (`CarDimensions`, `CarEngineData`, `CarGearbox`, `CarSuspension`, `CarTyres`/`CarRearTyres`, `CarData`)
- **Pytanie:** Jakie są dokładne układy bajtowe, typy (`signed`/`unsigned`, tablice stałe) oraz spójność relacyjna 6 struktur bazy danych aut w `gtmode_data.dat.gz`, a także które pola ze `structs.h` mają niejasne, sprzeczne lub niepotwierdzone znaczenie (`E0`/`E2`)?
- **Metoda:** Weryfikacja względem `GT2DataExploder/structs.h` i `main.cpp` (`adeyblue/GTVolTools`, MIT, tymczasowo w `%TEMP%\gtvoltools-ref`, usunięte przed końcem sesji), implementacja czystych dekoderów w `src/formats/gtdb/` (`tableDecode.ts`, `carDimensions.ts`, `carEngineData.ts`, `carGearbox.ts`, `carSuspension.ts`, `carTyres.ts`, `carData.ts`) opartych wyłącznie na `DataView(..., true)` (LE), `30` syntetycznych testów jednostkowych (`tests/unit/car*.test.ts`) oraz strumieniowa weryfikacja w `tests/unit/gtdbRealArchive.test.ts` na wszystkich `7/7` wariantach `gtmode_data.dat.gz`.
- **Wynik (statystyki zagregowane na `local_assets/GT2.VOL`, zero nazw aut i zero zrzutów danych Sony > 64 B):**
  - **Liczności rekordów (`7/7` wariantów):** `621` aut (`5` wariantów PAL), `618` (`usa`), `613` (JP); `CarGearbox`: `2217` / `2205` / `2185`; `CarSuspension`: `2211` / `2199` / `2179`; `CarTyres` i `CarRearTyres`: `4720` / `4696` / `4661`.
  - **Spójność relacyjna:** `100%` zgodności zbiorów `carId` między `CarData` a wszystkimi `6` pozostałymi tabelami (`0` osieroconych lub brakujących `carId` w żadnym z `7` wariantów); indeksy części w `CarData` (`weightPartId`, `enginePartId`, `transmission`, `suspension`, `frontTyres`, `rearTyres`) mieszczą się w `100%` w granicach odpowiednich tabel.
  - **Zakresy niezmienników fizycznych:** `CarDimensions`: `length` `2790–5537 mm`, `height` `1016–1773 mm`, `weightKg` `425–2055 kg`, `rmWeightMultiplier` `17–79`; `CarEngineData`: `engineCc` `0–25230`, `ps` `23–1030`, `maxPowerRpmRaw` `0–1200`, `torqueKgmRaw` `0–954`, `bandPointCount` `7–16` (`≤ 16`); `CarGearbox`: `price` `0–11000`, `type` `0..3`, `finalGear` `2430–6666`; `CarSuspension`: `price` `0–20000`, `stage` `0..3`; `CarTyres` / `CarRearTyres`: `price` `0–18000` (przód), `type` `0..7`, `unk_0x09` / `unk_0x05` = `0`.
  - **Rozstrzygnięte rozbieżności `structs.h`:**
    1. `CarRearTyres` (`0x0C` B) ma inny układ niż `CarTyres` (`0x10` B) — pomija pole `price`; oba dekodery współdzielą `src/formats/gtdb/carTyres.ts`.
    2. `CarData` offset `0x0E`: sprzeczność między `CarData.weightDistribution` a `OpponentInfo.rmPartId` (zakres `0–1054` przy `1056` rekordach `CarRacingModification`) → pozostawione jako `unk_0x0e` (**E0**).
    3. `CarData` offsety `0x14` i `0x18`: błędne komentarze offsetów `16`/`1a` w `structs.h` pod `#include <pshpack1.h>`, a `naPart` (`0x18`) zawsze `0` na `621/621` autach → oba oraz `0x40` (`padding`) pozostawione jako `unk_0x14`, `unk_0x18`, `unk_0x40` (**E0**).
    4. `CarEngineData` offset `0x4B` (`significantUnks`): potwierdzone w `CalculateRealPS` jako liczba aktywnych punktów w obu tablicach pasm (`7–16`) → nazwane `bandPointCount` (**E2**).
- **Pewność:** **E3** dla układów, rozmiarów `C_ASSERT`, pól `carId`, `length`, `height`, `weightKg`, `rmWeightMultiplier`, `engineCc`, `ps`, `maxPowerRpmRaw`, `torqueKgmRaw`, `CarGearbox.price/type/finalGear`, `CarSuspension.price/stage`, `CarTyres.price/type`, `CarRearTyres.type` oraz zweryfikowanych indeksów/cen/roku w `CarData`; **E2** dla pól `bandAcceleration`, `baseUnits`, `bandRpms`, `bandPointCount`, `flywheel`, `rimsCode3`, `manufacturerId` oraz indeksów `unistrdb` (do pełnej weryfikacji w M5.4); **E0** dla wszystkich pól `unk_0x..`.
- **Konsekwencje dla kodu:** Kompletna warstwa czystych dekoderów 6 (+1) struktur w `src/formats/gtdb/` jest gotowa pod M5.4 (`unistrdb`/`WSDB`), M5.5 (`CarCatalog`) i M5.6 (UI).
- **Otwarte pytania:** W M5.4 rozszyfrować bazę napisów `unistrdb` (`WSDB`) i zweryfikować indeksy `nameFirstPartIndex`, `nameSecondPartIndex`, `engineTypeNameIndex`, `engineTypeName2Index`, `torqueRpmStringIndex`.
