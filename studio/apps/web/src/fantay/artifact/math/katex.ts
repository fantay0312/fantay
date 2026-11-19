// SPDX-License-Identifier: AGPL-3.0-only
// KaTeX with its style sheet and fonts, as one chunk: whatever loads the engine (`engine.ts`) gets
// the layout rules with it, so a typeset formula can never be shown without them.
import katex from 'katex';

import 'katex/dist/katex.min.css';

export default katex;
