import { FANTAY_PRIVACY_SECTIONS, FANTAY_PRIVACY_VERSION, FANTAY_PRIVACY_URL } from '@open-design/contracts';

export function PrivacyPolicyContent(): JSX.Element {
  return <details className="settings-subsection" data-testid="privacy-policy-offline" style={{ maxHeight: '50vh', overflowY: 'auto' }}>
    <summary>阅读 Fantay 隐私说明 · {FANTAY_PRIVACY_VERSION}</summary>
    <p className="hint">以下内容随应用提供，可离线阅读。<a href={FANTAY_PRIVACY_URL} target="_blank" rel="noopener noreferrer">查看官网版本</a></p>
    {FANTAY_PRIVACY_SECTIONS.map((section) => <section key={section.title}>
      <h4>{section.title}</h4>
      {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
    </section>)}
  </details>;
}
