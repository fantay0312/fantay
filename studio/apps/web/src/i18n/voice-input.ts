import { useI18n } from './index';

const en = {
  title: 'Voice input', provider: 'Recognition provider', custom: 'Custom / BYOK', model: 'Recognition model',
  automatic: 'Automatic', refresh: 'Refresh models', loading: 'Loading…', save: 'Save', saved: 'Voice input settings saved.',
  intro: 'Record up to 2 minutes. Recognized text is inserted into your draft for review before sending.',
  privacy: 'Audio is sent to the selected recognition service when you finish recording.',
  baseUrl: 'Base URL', modelId: 'Model ID', apiKey: 'API key', keySaved: 'Saved · enter a new key to replace',
  clearKey: 'Clear saved key', reuseByok: 'Use current BYOK address and key',
  compatible: 'Use a service with an OpenAI-compatible audio/transcriptions endpoint. The model must support speech recognition.',
  noModels: 'No compatible speech recognition models are available for this account. Refresh the list or configure a custom service.',
  start: 'Start voice input', stop: 'Stop and transcribe', cancel: 'Cancel voice input', close: 'Dismiss',
  recording: 'Recording', processing: 'Transcribing…', permission: 'Waiting for microphone permission…',
  unsupported: 'Microphone recording is unavailable in this environment.',
  denied: 'Microphone access was denied. Allow microphone access in system settings, then try again.',
  unavailable: 'Could not start recording. Check that a microphone is connected and available.',
  empty: 'No audio was recorded. Please try again.', failed: 'Voice recognition failed. Check your voice input settings and try again.',
} as const;
type Copy = { [K in keyof typeof en]: string };
const zh: Copy = {
  title: '语音输入', provider: '识别服务', custom: '自定义 / BYOK', model: '识别模型',
  automatic: '自动选择', refresh: '刷新模型', loading: '正在加载…', save: '保存', saved: '语音输入设置已保存。',
  intro: '每段最多录音 2 分钟。识别文字会填入草稿，可检查后再发送。',
  privacy: '结束录音后，音频将发送到所选的语音识别服务。',
  baseUrl: '服务地址', modelId: '模型 ID', apiKey: 'API 密钥', keySaved: '已保存，输入新密钥可替换',
  clearKey: '清除已保存的密钥', reuseByok: '沿用当前 BYOK 地址和密钥',
  compatible: '支持 OpenAI 兼容的 audio/transcriptions 接口，请填写语音识别模型。',
  noModels: '当前账号暂无兼容的语音识别模型，可刷新列表或配置自定义服务。',
  start: '开始语音输入', stop: '停止并识别', cancel: '取消语音输入', close: '关闭提示',
  recording: '正在录音', processing: '正在识别…', permission: '正在等待麦克风权限…',
  unsupported: '当前环境无法使用麦克风录音。',
  denied: '麦克风权限未开启，请在系统设置中允许麦克风访问后重试。',
  unavailable: '无法开始录音，请检查麦克风是否已连接且可用。',
  empty: '没有录到声音，请重新录制。', failed: '语音识别失败，请检查语音输入设置后重试。',
};
const ja: Copy = {
  ...en, title: '音声入力', provider: '音声認識サービス', custom: 'カスタム / BYOK', model: '認識モデル',
  automatic: '自動選択', refresh: 'モデルを更新', loading: '読み込み中…', save: '保存', saved: '音声入力の設定を保存しました。',
  intro: '録音は最大2分です。認識したテキストは下書きに挿入され、確認してから送信できます。',
  privacy: '録音終了後、音声は選択した音声認識サービスに送信されます。',
  baseUrl: 'ベース URL', modelId: 'モデル ID', apiKey: 'API キー', keySaved: '保存済み · 新しいキーで置き換え',
  clearKey: '保存したキーを削除', reuseByok: '現在の BYOK アドレスとキーを使用',
  compatible: 'OpenAI 互換の audio/transcriptions エンドポイントと音声認識モデルを指定してください。',
  noModels: '利用できる音声認識モデルがありません。更新するか、カスタムサービスを設定してください。',
  start: '音声入力を開始', stop: '録音を終了して認識', cancel: '音声入力をキャンセル', close: '閉じる',
  recording: '録音中', processing: '認識中…', permission: 'マイクのアクセス許可を待っています…',
  unsupported: 'この環境ではマイク録音を利用できません。',
  denied: 'マイクへのアクセスが拒否されました。システム設定で許可してから再試行してください。',
  unavailable: '録音を開始できません。マイクの接続を確認してください。', empty: '音声が録音されませんでした。再試行してください。',
  failed: '音声認識に失敗しました。音声入力の設定を確認してください。',
};

export function useVoiceInputCopy(): Copy {
  const { locale } = useI18n();
  return locale.startsWith('zh') ? zh : locale === 'ja' ? ja : en;
}
