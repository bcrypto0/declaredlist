# Fonts

The site serves its typefaces from its own folder (`dist/fonts/`, copied from `build/fonts/` by the build), so a page makes no request to another domain. The Content Security Policy allows them with `font-src 'self'`.

Every family is under the SIL Open Font License, Version 1.1. Each licence file sits beside the font files it covers and is served with them.

| Family | Use on the site | Files | Weights and styles | Licence |
|---|---|---|---|---|
| Libre Caslon Text | prose, labels, notes | `LibreCaslonText-wght.woff2`, `LibreCaslonText-Italic-wght.woff2` | variable weight 400 to 700, roman and italic | SIL OFL 1.1, `LibreCaslonText-OFL.txt` |
| Libre Caslon Display | heads, the count, numerals | `LibreCaslonDisplay-Regular.woff2` | 400 | SIL OFL 1.1, `LibreCaslonDisplay-OFL.txt` |
| DM Mono | machine values: hashes, state codes, versions, commands, times | `DMMono-Regular.woff2` | 400 | SIL OFL 1.1, `DMMono-OFL.txt` |

## Source

All files come from the google/fonts repository, at commit `869789e84da92782c144d83d69b64cec54905b5f` (20 November 2026):

* https://github.com/google/fonts/tree/869789e84da92782c144d83d69b64cec54905b5f/ofl/librecaslontext (`LibreCaslonText[wght].ttf`, `LibreCaslonText-Italic[wght].ttf`, `OFL.txt`; upstream https://github.com/thundernixon/Libre-Caslon)
* https://github.com/google/fonts/tree/869789e84da92782c144d83d69b64cec54905b5f/ofl/librecaslondisplay (`LibreCaslonDisplay-Regular.ttf`, `OFL.txt`; upstream https://github.com/impallari/Libre-Caslon-Display)
* https://github.com/google/fonts/tree/869789e84da92782c144d83d69b64cec54905b5f/ofl/dmmono (`DMMono-Regular.ttf`, `OFL.txt`; upstream https://github.com/googlefonts/dm-mono)

## How the WOFF2 files were made

The TTF files were converted to WOFF2 and cut to the Latin range with fontTools 4.68 (`pyftsubset`), keeping every OpenType layout feature and the weight axis of the variable fonts:

```
pyftsubset <file>.ttf --unicodes="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD" --layout-features='*' --flavor=woff2 --output-file=<file>.woff2
```

Under the licence these are Modified Versions of the Font Software. They keep the original font names, which the licence allows because none of the families declares a Reserved Font Name. Text outside the Latin range (publisher text in other scripts) is shown in the reader's own fonts.
