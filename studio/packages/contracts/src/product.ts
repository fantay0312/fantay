/** Product-owned destinations. Upstream attribution belongs in THIRD_PARTY_NOTICES. */
export const FANTAY_WEBSITE_URL = 'https://design.tokentosea.com';
export const FANTAY_GITHUB_REPOSITORY = 'fantay0312/fantay';
export const FANTAY_GITHUB_REPO_URL = `https://github.com/${FANTAY_GITHUB_REPOSITORY}`;
export const FANTAY_SUPPORT_EMAIL = 'support@tokentosea.com';
export const FANTAY_FEISHU_COMMUNITY_URL = 'https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=262i1aad-be96-4bb2-a764-6ab7cc189efa';
export const FANTAY_FEEDBACK_URL = `${FANTAY_WEBSITE_URL}/feedback/`;
export const FANTAY_PRIVACY_URL = `${FANTAY_WEBSITE_URL}/privacy/`;
/** No environment variable or migrated preference may enable automatic reporting. */
export const FANTAY_AUTOMATIC_REPORTING_ENABLED: boolean = false;

/** Identify retired product infrastructure when reading inherited service settings. */
export function isRetiredOpenDesignServiceUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (host === 'open-design.ai' || host.endsWith('.open-design.ai') || host === 's3.nexu.space') {
    return true;
  }
  const githubHosts = ['github.com', 'api.github.com', 'raw.githubusercontent.com', 'codeload.github.com'];
  return githubHosts.includes(host) && /^\/(?:repos\/)?nexu-io\/open-design(?:\/|$)/i.test(url.pathname);
}
