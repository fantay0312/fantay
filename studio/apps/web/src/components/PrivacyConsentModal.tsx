import { useI18n } from '../i18n';
import { PrivacyPolicyContent } from './PrivacyPolicyContent';

interface Props { onShare: () => void; onDecline: () => void }

/** First-run information only: acknowledging never enables an upload. */
export function PrivacyConsentModal({ onDecline }: Props): JSX.Element {
  const { locale } = useI18n();
  const chinese = locale === 'zh-CN' || locale === 'zh-TW';
  return <div className="privacy-consent-banner" role="region" aria-labelledby="privacy-consent-title">
    <h3 id="privacy-consent-title">{chinese ? '你的创作，由你掌控' : 'Your work stays under your control'}</h3>
    <p>{chinese ? '自动统计与诊断上传已关闭。模型请求和作品分享仅在你主动使用相关功能时发生。' : 'Automatic analytics and diagnostic uploads are off. Model requests and publishing happen when you choose those features.'}</p>
    <PrivacyPolicyContent />
    <button type="button" className="privacy-consent-action privacy-consent-action--primary" onClick={onDecline}>
      {chinese ? '知道了' : 'Got it'}
    </button>
  </div>;
}
