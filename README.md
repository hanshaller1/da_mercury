# Da Mercury – Algorithmic Stereo Reverb

Ein algorithmischer Stereo-Hall in Studioqualität, der im Browser läuft. Die Bedienung orientiert sich an modernen
High-End-Reverb-Pedalen: eine modulare Signalkette, sieben Hall-Algorithmen, Shimmer, Swell, Ducking, Freeze, Presets
und ein Expression-Morph. Der gesamte DSP-Code ist selbst geschrieben und läuft sampleweise in einem `AudioWorklet`.
Es gibt keine Abhängigkeiten und keinen Build-Schritt.

## Starten

```bash
npm start
```

Danach http://localhost:8080 öffnen. AudioWorklets funktionieren nur über `http(s)://` und nicht über `file://`.
Jeder andere statische Webserver tut es auch, zum Beispiel `python3 -m http.server`. Auch GitHub Pages funktioniert.

```bash
npm test
```

Die Tests laufen in Node ≥ 18. Geprüft werden die Engine, die Stabilität und die Performance.

## Veröffentlichte Version

Die App ist auch als claude.ai-Artifact veröffentlicht: https://claude.ai/artifact/2fNqyd9Qg7gen5DJ3mKCuL

Dieses Bundle wird gebaut mit:

```bash
node tools/build-artifact.mjs
```

Das Skript schreibt einen eigenständigen Build nach `dist/`. In der gehosteten Version gibt es keinen Live-Eingang
und keinen WAV-Export, weil die Sandbox beides nicht erlaubt. Aufnahmen und Preset-Exporte laufen dort über die
Download-Bestätigung der Plattform.

## Algorithmen

| Algorithmus | Technik |
|---|---|
| **Room** | FDN mit 8 Delay-Lines (7–41 ms), kräftige Early Reflections |
| **Hall** | FDN mit 16 Delay-Lines, Hadamard-Feedback-Matrix, In-Loop-Allpässe, Delay-Modulation |
| **Plate** | Achter-Tank nach Dattorro mit 3-Band-Decay, stufenlos skalierbar |
| **Spring** | Drei „Federn“: Feedback-Schleifen über Kaskaden von Allpässen 1. Ordnung, dadurch die typischen dispersiven Chirps |
| **Cathedral** | FDN mit 16 Lines und sehr langen Wegen (47–211 ms), weit gespreizte Early Reflections |
| **Cloud** | FDN mit 16 Lines, 6-stufiger Input-Diffusor, starke Chorus-Modulation, ideal für Ambient |
| **Reverse** | Hall-Tail, der blockweise rückwärts ausgespielt wird (zwei überlappende Köpfe), dadurch schwillt er an |

Beim Umschalten klingt der alte Algorithmus aus (Spillover), während der neue eingeblendet wird.

## Signalkette

```
IN ─┬───────────────────────────────────────────────────────────── dry ─┐
    └ Swell ─ Drive ─ Pre-Delay ─ Pitch ─┬ Early Refl. ┐                │
                ▲                        └──► Reverb ◄─┘                │
                └──────── Shimmer-Feedback ◄─────┘                      │
                                       EQ ─ Width ─ Ducking ─ Mix ──────┴─ OUT
```

* **Decay / Lo Decay / Hi Decay**: RT60 von 0,1 bis 60 s. Bass- und Höhen-Nachhall werden getrennt als Multiplikator
  eingestellt (3-Band-Filter in jeder Feedback-Schleife). Das Display zeigt die resultierende RT60-Kurve über der
  Frequenz.
* **Size**: skaliert alle Laufzeiten stufenlos. Beim Drehen gleitet die Tonhöhe kurz wie bei einem Bandgerät, es knackt
  nicht.
* **Diffusion, Early, Mod Rate/Depth**: Dichte, frühe Reflexionen, Chorus im Tank.
* **Pitch / Shimmer**: Pitch-Shifter (−24 … +24 Halbtöne). Im Modus *Feedback* liegt er in der Rückkopplung (klassischer
  Shimmer, mit automatischer Pegelregelung gegen Aufschaukeln). Im Modus *Input* wird nur das Eingangssignal
  transponiert.
* **Swell**: automatisches Einblenden bei jedem Anschlag, wahlweise nur für den Hall oder für das ganze Signal.
* **Drive**: weiche Sättigung im Hall-Send.
* **Ducking**: Der Hall wird leiser, solange man spielt, und blüht in den Pausen auf.
* **EQ**: Low Cut und High Cut für den Hallanteil.
* **Width, Output, Input**.
* **HOLD**: Freeze. Kurz tippen rastet ein, gedrückt halten wirkt nur so lange wie der Druck. Der Tail bleibt endlos
  stehen, und man kann darüber spielen.
* **BYPASS** mit optionalen **Trails**: Der Hall klingt nach dem Ausschalten natürlich aus.
* **Expression / Morph**: Sound A und Sound B speichern und dann stufenlos zwischen allen Parametern überblenden.

## Quellen und Export

* Synthetische Demos (Gitarre, Keys, Drums, Synth, Snare, Impuls). Es werden keine Samples mitgeliefert.
* Eigene Audiodatei über den Datei-Dialog oder per Drag & Drop
* **Live-Eingang**: Audio-Interface, Synths und Drum-Machines über USB-Audio (z. B. ein Elektron Syntakt), Line-In
  oder Mikrofon. Details siehe unten.
* **Aufnahme**: Live-Mitschnitt des Ausgangs (WebM/Opus)
* **WAV rendern**: Die aktuelle Quelle wird offline inklusive Hall-Tail als 24-Bit-WAV gerendert.

Presets: 15 Werks-Presets und eigene Presets. Eigene Presets werden im `localStorage` gespeichert und lassen sich als
JSON exportieren und importieren.

Tastatur: `Leertaste` Play/Stop · `B` Bypass · `H` Hold · `←`/`→` Presets · Doppelklick auf einen Regler setzt den
Standardwert · `Shift` beim Ziehen = Feinregelung

## Live-Eingang: Audio-Interface, Syntakt & Co.

Im Tab **Live-Eingang** auf Play drücken und den Zugriff erlauben. Danach stehen diese Einstellungen zur Verfügung:

* **Eingang**: jedes Audiogerät, das das Betriebssystem kennt (Interface, USB-Synth, Line-In, Mikrofon). Die
  Sprachverarbeitung des Browsers (Echo- und Rauschunterdrückung, automatische Pegelregelung) ist abgeschaltet.
* **Kanäle**: bei Mehrkanal-Geräten ein Stereopaar (1/2, 3/4, …) oder ein einzelner Kanal als Mono-Quelle, z. B.
  eine Gitarre an Input 1. Wie viele Kanäle ankommen, entscheidet der Browser. Chrome und Edge liefern je nach
  Treiber oft nur die ersten 2.
* **Ausgang**: das Ausgabegerät, z. B. zurück ins Interface (Chrome/Edge, `AudioContext.setSinkId`).
* **Kill Dry** (I/O-Bereich): Es wird nur der Hall ausgegeben. Das ist für den Parallelbetrieb gedacht, wenn das
  Direktsignal schon über das Direct Monitoring des Interfaces oder über das Mischpult läuft.
* Unter den Auswahlfeldern stehen Gerätename, Kanalzahl, Samplerate und die geschätzte Latenz.

Die Einstellungen werden gespeichert. Wird ein Gerät abgesteckt, aktualisiert sich die Liste automatisch.

Hinweise zum Elektron Syntakt: Unter macOS und Linux erscheint er per USB als class-compliant Audiogerät (Main Out
L/R). Unter Windows braucht er den Overbridge-Treiber. Alternativ gehen seine Main Outs in die Line-Inputs des
Interfaces. Für möglichst wenig Latenz eine kleine Puffergröße im Interface-Treiber wählen. Die App läuft mit
128-Sample-Blöcken.

Live-Eingänge setzen `http://localhost` oder HTTPS voraus. In der eingebetteten Artifact-Version sperrt die Sandbox
den Zugriff.

## Projektstruktur

```
index.html, css/style.css      Oberfläche
js/main.js                     App: Audio-Graph, Presets, Morph, Aufnahme, Rendern
js/params.js, js/presets.js    Parameter-Definitionen & Werks-Presets
js/ui/knob.js, js/ui/display.js  Drehregler & Display (Spektrum, RT60, Meter)
js/sources.js, js/wav.js       Demo-Synthese, WAV-Encoder
js/live-input.js               Live-Eingang: Geräte, Kanal-Routing, Latenz
js/worklet/reverb-processor.js AudioWorklet-Wrapper
js/dsp/                        DSP-Engine, ohne Web-Audio-Abhängigkeit, in Node testbar
  engine.js   komplette Signalkette
  fdn.js      Feedback-Delay-Network (Room/Hall/Cathedral/Cloud)
  plate.js    Plate
  spring.js   Spring
  effects.js  Pitch-Shifter, Reverse-Buffer, Early Reflections, Envelope-Follower
  primitives.js Delay-Lines, Allpässe, Biquads, Hadamard …
test/dsp.test.mjs              Tests (Nachhallzeit, Pegel, Stabilität, Freeze, Shimmer, Performance)
```
