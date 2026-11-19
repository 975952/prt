# StPageFlip

`page-flip.module.js` is the ES module distribution of `page-flip@2.0.7`,
https://github.com/Nodlik/StPageFlip, Copyright (c) 2020 Nodlik, MIT license.
The license is included in `page-flip.LICENSE`.

Used only for temporary rendered-page overlays during immersive page turns.
PDF parsing, text selection, references, and persistence remain in the reader.
The module loads locally without runtime network requests.

Local lifecycle corrections: stop the renderer's animation loop after its DOM
surface disconnects; remove resize handlers during destruction even with mouse
events disabled. These prevent a temporary page-turn overlay retaining callbacks.
