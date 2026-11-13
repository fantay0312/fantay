// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import { Mic, Square } from 'lucide-react';
import { useT } from '../../i18n';
import { Icon, IconButton, Spinner, toast, VisuallyHidden } from '../ui';
import { usePaTransport } from './pa-transport';

const MIME = 'audio/webm;codecs=opus';

interface Recording {
  abort: AbortController;
  recorder?: MediaRecorder;
  stream?: MediaStream;
  timer?: ReturnType<typeof setTimeout>;
}

function release(recording: Recording) {
  clearTimeout(recording.timer);
  recording.stream?.getTracks().forEach(track => track.stop());
}

async function encodeAudio(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw);
}

export function PaVoiceInput({
  disabled,
  className,
  onTranscript,
}: {
  disabled: boolean;
  className?: string;
  onTranscript(text: string): void;
}) {
  const t = useT();
  const send = usePaTransport();
  const current = useRef<Recording | null>(null);
  const [state, setState] = useState<'idle' | 'permission' | 'recording' | 'transcribing'>('idle');
  useEffect(() => () => {
    const recording = current.current;
    if (!recording) return;
    current.current = null;
    recording.abort.abort();
    if (recording.recorder?.state === 'recording') recording.recorder.stop();
    release(recording);
  }, []);
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported(MIME) || !navigator.mediaDevices?.getUserMedia) return null;

  const toggle = async () => {
    if (current.current) {
      if (current.current.recorder?.state === 'recording') current.current.recorder.stop();
      return;
    }
    const recording: Recording = { abort: new AbortController() };
    current.current = recording;
    setState('permission');
    const finish = () => {
      release(recording);
      if (current.current === recording) {
        current.current = null;
        setState('idle');
      }
    };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      recording.stream = stream;
      if (recording.abort.signal.aborted) { release(recording); return; }
      const recorder = new MediaRecorder(stream, { mimeType: MIME, audioBitsPerSecond: 32000 });
      recording.recorder = recorder;
      const parts: Blob[] = [];
      recorder.ondataavailable = event => { if (event.data.size) parts.push(event.data); };
      recorder.onerror = () => {
        if (recording.abort.signal.aborted) return;
        recording.abort.abort();
        toast({ tone: 'danger', title: t('pa.voice.failed') });
        finish();
      };
      recorder.onstop = async () => {
        release(recording);
        if (recording.abort.signal.aborted) return;
        setState('transcribing');
        try {
          const blob = new Blob(parts, { type: MIME });
          if (!blob.size) throw new Error(t('pa.voice.empty'));
          const audio = await encodeAudio(blob);
          const result = await send<{ text: string }>('/voice', 'POST', { audio, format: 'webm' }, recording.abort.signal);
          if (!recording.abort.signal.aborted && result.text) onTranscript(result.text);
        } catch (error) {
          if (!recording.abort.signal.aborted) toast({ tone: 'danger', title: error instanceof Error ? error.message : t('pa.voice.failed') });
        } finally {
          finish();
        }
      };
      recorder.start();
      recording.timer = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, 60000);
      setState('recording');
    } catch {
      if (!recording.abort.signal.aborted) toast({ tone: 'danger', title: t('pa.voice.permission') });
      finish();
    }
  };
  const label = t(state === 'recording' ? 'pa.voice.stop' : state === 'transcribing' ? 'pa.voice.processing' : 'pa.voice.start');
  return (
    <>
      <IconButton
        variant={state === 'recording' ? 'danger' : 'quiet'}
        shape="round"
        size="md"
        className={className}
        data-recording={state === 'recording' ? '' : undefined}
        aria-label={label}
        aria-pressed={state === 'recording'}
        disabled={state === 'permission' || state === 'transcribing' || (disabled && state !== 'recording')}
        onClick={() => void toggle()}
      >
        {state === 'transcribing' ? <Spinner size="sm" /> : <Icon icon={state === 'recording' ? Square : Mic} size="md" />}
      </IconButton>
      <VisuallyHidden role="status">{state === 'recording' ? t('pa.voice.recording') : state === 'transcribing' ? label : ''}</VisuallyHidden>
    </>
  );
}
