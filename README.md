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
* Mikrofon oder Line-In (bitte Kopfhörer verwenden)
* **Aufnahme**: Live-Mitschnitt des Ausgangs (WebM/Opus)
* **WAV rendern**: Die aktuelle Quelle wird offline inklusive Hall-Tail als 24-Bit-WAV gerendert.

Presets: 15 Werks-Presets und eigene Presets. Eigene Presets werden im `localStorage` gespeichert und lassen sich als
JSON exportieren und importieren.

Tastatur: `Leertaste` Play/Stop · `B` Bypass · `H` Hold · `←`/`→` Presets · Doppelklick auf einen Regler setzt den
Standardwert · `Shift` beim Ziehen = Feinregelung

## Projektstruktur

```
index.html, css/style.css      Oberfläche
js/main.js                     App: Audio-Graph, Presets, Morph, Aufnahme, Rendern
js/params.js, js/presets.js    Parameter-Definitionen & Werks-Presets
js/ui/knob.js, js/ui/display.js  Drehregler & Display (Spektrum, RT60, Meter)
js/sources.js, js/wav.js       Demo-Synthese, WAV-Encoder
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
