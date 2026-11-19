import { FANTAY_LATEST_RELEASE as release } from './fantay-releases.js';

/** Product-owned, offline release notes derived from the detailed release record. */
export const FANTAY_RELEASE_NOTES = {
  id: `fantay-${release.version}`,
  title: `Fantay ${release.version}`,
  body: release.summary.en.join('\n'),
  locales: {
    'zh-CN': {
      title: `Fantay ${release.version}`,
      body: release.summary['zh-CN'].join('\n'),
    },
    'zh-TW': {
      title: `Fantay ${release.version}`,
      body: release.summary['zh-TW'].join('\n'),
    },
  },
} as const;
