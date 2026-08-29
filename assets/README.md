# Public image assets

Public-facing images for the repository and DSH marketplace. The walkthrough images use only synthetic scenario text and values already recorded in [`docs/LOCAL_ACCEPTANCE.md`](../docs/LOCAL_ACCEPTANCE.md); they contain no private prompt, raw transcript, file content, credential, or session identifier.

| Asset | Role and provenance | SHA-256 |
| --- | --- | --- |
| `social/completion-guard-hero.png` | Language-neutral 1600×900 mechanism illustration for the README and marketplace cover. Generated with the built-in image generator from an author-owned style reference; the composition depicts contract clauses and bounded evidence passing through a checkpoint before a completion certificate is issued. | `2f346ec687770ba25e648acf2e5b0f9f375b1fb2336602b3887fbe273edbd5e7` |
| `screenshots/certification-walkthrough-en.png` | English 1280×800 storefront walkthrough. Deterministically rendered from the synthetic native-acceptance scenario: requirement `R001`, evidence `E0038`, 6 files / 138 passing tests, and the certified revision-1 checkpoint. | `37330e4e7cd2df2fc0d4b040c90efd18b0e55ec73945e3bd84a554f0d4534e5f` |
| `screenshots/certification-walkthrough-zh.png` | Chinese 1280×800 edition of the same synthetic walkthrough and evidence scope. | `3a9954c48dfea01081759b880deba9a99a7141c9d886b017a6ea949afa25757b` |

The root [`screenshots.json`](../screenshots.json) declares the marketplace order. Paths remain repository-relative so the awesome-dsh-plugin catalog and dsh-market can refresh them from the plugin repository without a separate screenshot PR.
