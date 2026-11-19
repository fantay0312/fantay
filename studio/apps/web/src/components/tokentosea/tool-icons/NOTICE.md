# Tool purpose icons

Brand-free function icons for TokenToSea and Fantay. User decision: 2026-11-14.
Lucide geometry is copied without redrawing from the installed package recorded
in `provenance.json`; original ISC/MIT notices are preserved in `LICENSE.txt`.
Only scale, stroke width and current text color change at rendering time.

`catalog.json` maps public tool IDs to purposes reviewed against the public tool
catalog and operation descriptions. Specific purpose takes priority over legacy
categories. Multi-purpose tools retain a general, truthful icon. Unknown tools
use a name-based purpose or category fallback; unrecognized categories use Wrench.
Supplier names, provider logos, remote image URLs and credentials are never read.

Canonical source: TokenToSea `packages/shared/src/tool-icons/`. Regenerate with
`node tooling/sync-tool-purpose-icons.mjs --lucide-root <installed-lucide-react>`;
add `--fantay-root <studio>` to synchronize the portable renderer copy. Keep
`resolve.ts`, `rules.json`, `catalog.json` and `nodes.json` identical in both products.
