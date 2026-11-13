/* SPDX-License-Identifier: AGPL-3.0-only */
/* Settings ▸ 隐私. Four blocks in the settings language: what never leaves the device, the one thing the user can send
   (a diagnostics file), what goes online only when the user acts, and the offline policy as a list of disclosures. */
import { useState, type Dispatch, type SetStateAction } from 'react';
import { ArrowUpRight, ChevronRight, Cpu, Plug, RefreshCw, Share2, ShieldCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { FANTAY_PRIVACY_SECTIONS, FANTAY_PRIVACY_URL, FANTAY_PRIVACY_VERSION } from '@open-design/contracts';
import { Icon } from '../fantay/ui';
import { useI18n } from '../i18n';
import type { AppConfig } from '../types';
import { ExportDiagnosticsRow } from './ExportDiagnosticsButton';

interface Props { cfg: AppConfig; setCfg: Dispatch<SetStateAction<AppConfig>> }

interface OnlineUse { icon: LucideIcon; label: string; hint: string }

export function PrivacySection(_props: Props): JSX.Element {
  const { locale } = useI18n();
  const zh = locale === 'zh-CN' || locale === 'zh-TW';

  const kept = zh
    ? ['使用统计', '安装归因', '崩溃报告', '对话内容', '工具记录']
    : ['Usage analytics', 'Install attribution', 'Crash reports', 'Conversations', 'Tool logs'];

  const online: OnlineUse[] = zh
    ? [
        { icon: Cpu, label: '模型请求', hint: '提示词、选定附件和相关上下文发送给你选择的服务：TokenToSea、自带密钥或本机 Agent。' },
        { icon: Share2, label: '作品分享', hint: '只有你主动发布时，所选作品和运行所需资源才会上传到分享服务。' },
        { icon: Plug, label: '插件与连接器', hint: '联网行为由插件或连接器本身和你授予的权限决定，启用前请检查来源。' },
        { icon: RefreshCw, label: '检查更新', hint: '只请求版本信息，不附带项目、对话或诊断文件。' },
      ]
    : [
        { icon: Cpu, label: 'Model requests', hint: 'Prompts, chosen attachments and context go to the service you pick: TokenToSea, your own key or a local agent.' },
        { icon: Share2, label: 'Published work', hint: 'Only work you publish, with the assets it needs to run, is uploaded to the sharing service.' },
        { icon: Plug, label: 'Plugins and connectors', hint: 'Their network use follows their own implementation and the permissions you grant.' },
        { icon: RefreshCw, label: 'Update checks', hint: 'Ask for version info only, without projects, conversations or diagnostics.' },
      ];

  return (
    <section className="settings-section settings-privacy">
      <div className="settings-privacy-status">
        <div className="settings-privacy-status-head">
          <span className="settings-privacy-status-icon" aria-hidden="true">
            <Icon icon={ShieldCheck} size="lg" />
          </span>
          <div className="settings-privacy-status-copy">
            <h4>{zh ? '自动统计与诊断上传已关闭' : 'Automatic analytics and diagnostic uploads are off'}</h4>
            <p className="hint">
              {zh
                ? '项目、素材、对话和日志保存在这台设备上，Fantay 不会在后台上传任何数据。'
                : 'Projects, assets, conversations and logs stay on this device. Fantay uploads nothing in the background.'}
            </p>
          </div>
        </div>
        <div className="settings-privacy-kept">
          <span className="settings-privacy-kept-label">{zh ? '从不自动上传' : 'Never uploaded'}</span>
          <ul>
            {kept.map(item => <li key={item}>{item}</li>)}
          </ul>
        </div>
      </div>

      <div className="settings-privacy-block">
        <div className="settings-privacy-block-head">
          <h3>{zh ? '诊断日志' : 'Diagnostics'}</h3>
        </div>
        <div className="settings-about-group">
          <div className="settings-about-diagnostics">
            <div className="settings-about-diagnostics-text">
              <h4>{zh ? '导出到本机' : 'Export to this device'}</h4>
              <p className="hint">
                {zh
                  ? '生成包含版本、错误和运行记录的 ZIP。先检查内容，再决定是否发给支持。'
                  : 'Creates a ZIP with versions, errors and run logs. Review it before deciding whether to send it to support.'}
              </p>
            </div>
            <ExportDiagnosticsRow />
          </div>
        </div>
      </div>

      <div className="settings-privacy-block">
        <div className="settings-privacy-block-head">
          <h3>{zh ? '只在你操作时联网' : 'Online only when you act'}</h3>
          <p className="hint">{zh ? '下列请求按你选择的服务和授权处理。' : 'These follow the services and permissions you choose.'}</p>
        </div>
        <ul className="settings-privacy-online">
          {online.map(item => (
            <li key={item.label}>
              <span className="settings-privacy-online-icon" aria-hidden="true">
                <Icon icon={item.icon} size="md" />
              </span>
              <span className="settings-privacy-online-copy">
                <strong>{item.label}</strong>
                <span className="hint">{item.hint}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <PrivacyPolicyList zh={zh} />
    </section>
  );
}

function PrivacyPolicyList({ zh }: { zh: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="settings-privacy-block">
      <div className="settings-privacy-block-head settings-privacy-block-head--row">
        <div>
          <h3>{zh ? '隐私说明' : 'Privacy notice'}</h3>
          <p className="hint">{zh ? `版本 ${FANTAY_PRIVACY_VERSION} · 随应用提供，可离线阅读` : `Version ${FANTAY_PRIVACY_VERSION} · bundled for offline reading`}</p>
        </div>
        <a className="settings-privacy-site-link" href={FANTAY_PRIVACY_URL} target="_blank" rel="noopener noreferrer">
          {zh ? '官网版本' : 'Website'}
          <Icon icon={ArrowUpRight} size="sm" />
        </a>
      </div>
      <div className="settings-privacy-policy" data-testid="privacy-policy-offline">
        {FANTAY_PRIVACY_SECTIONS.map((section, index) => {
          const expanded = open === section.title;
          const panelId = `privacy-policy-panel-${index}`;
          const closed: Record<string, string> = expanded ? {} : { inert: '' };
          return (
            <div key={section.title} className="settings-privacy-policy-item" data-open={expanded || undefined}>
              <button
                type="button"
                className="settings-privacy-policy-trigger"
                aria-expanded={expanded}
                aria-controls={panelId}
                onClick={() => setOpen(expanded ? null : section.title)}
              >
                <span className="settings-privacy-policy-index">{String(index + 1).padStart(2, '0')}</span>
                <span className="settings-privacy-policy-title">{section.title}</span>
                <Icon icon={ChevronRight} size="sm" className="settings-privacy-policy-chevron" />
              </button>
              <div id={panelId} className="settings-privacy-policy-panel" role="region" aria-label={section.title} {...closed}>
                <div className="settings-privacy-policy-body">
                  {section.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
