// fx-governance-allow-raw: Settings sidebar rows reuse the upstream `settings-nav-item` button so they look and behave exactly like their sibling rows in SettingsDialog (not a Fantay surface).
// SPDX-License-Identifier: AGPL-3.0-only
// Fantay row in the Settings sidebar (spec 07 §8): 账户 (TokenToSea).
import { FeatureIcon } from '../ui/feature-icon';
import { useT } from '../../i18n';

export interface FantaySettingsNavItemsProps {
  /** SettingsDialog's active section. */
  active: string;
  onSelect: (section: 'account') => void;
}

export function FantaySettingsNavItems({ active, onSelect }: FantaySettingsNavItemsProps) {
  const t = useT();
  const isActive = active === 'account';
  return (
    <button
      type="button"
      className={`settings-nav-item${isActive ? ' active' : ''}`}
      onClick={() => onSelect('account')}
      aria-current={isActive ? 'page' : undefined}
      data-testid="settings-nav-account"
    >
      <FeatureIcon name="account" slot={16} />
      <span>
        <strong>{t('fantay.account.nav')}</strong>
        <small>{t('fantay.account.navHint')}</small>
      </span>
    </button>
  );
}
