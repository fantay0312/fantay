import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Mic, Square, X } from 'lucide-react';
import { VOICE_INPUT_MAX_SECONDS } from '@open-design/contracts/api/voice-input';
import { transcribeVoiceInput } from '../../providers/voice-input';
import { useVoiceInputCopy } from '../../i18n/voice-input';

type State = 'idle' | 'permission' | 'recording' | 'transcribing';
interface Recording {
  abort: AbortController;
  recorder?: MediaRecorder;
  stream?: MediaStream;
  timer?: ReturnType<typeof setInterval>;
}
function release(recording: Recording) {
  clearInterval(recording.timer);
  recording.stream?.getTracks().forEach(track => track.stop());
}

export function VoiceInputButton({ disabled = false, onTranscript, onActiveChange }: {
  disabled?: boolean;
  onTranscript(text: string): void;
  onActiveChange?(active: boolean): void;
}) {
  const copy = useVoiceInputCopy();
  const [state, setState] = useState<State>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState('');
  const current = useRef<Recording | null>(null);
  const transcriptRef = useRef(onTranscript);
  transcriptRef.current = onTranscript;

  useEffect(() => { onActiveChange?.(state !== 'idle'); }, [state, onActiveChange]);
  useEffect(() => () => {
    const recording = current.current;
    current.current = null;
    if (recording) {
      recording.abort.abort();
      if (recording.recorder?.state === 'recording') recording.recorder.stop();
      release(recording);
    }
    onActiveChange?.(false);
  }, [onActiveChange]);

  function cancel() {
    const recording = current.current;
    current.current = null;
    if (recording) {
      recording.abort.abort();
      if (recording.recorder?.state === 'recording') recording.recorder.stop();
      release(recording);
    }
    setState('idle');
  }
  useEffect(() => {
    if (state === 'idle') return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [state]);

  const supported = typeof MediaRecorder !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
  async function toggle() {
    if (current.current) {
      if (current.current.recorder?.state === 'recording') current.current.recorder.stop();
      return;
    }
    const recording: Recording = { abort: new AbortController() };
    current.current = recording;
    setError('');
    setState('permission');
    setSeconds(0);
    const finish = () => {
      release(recording);
      if (current.current === recording) { current.current = null; setState('idle'); }
    };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      recording.stream = stream;
      if (recording.abort.signal.aborted) { release(recording); return; }
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 64000 });
      recording.recorder = recorder;
      const chunks: Blob[] = [];
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => {
        if (recording.abort.signal.aborted) return;
        recording.abort.abort();
        setError(copy.unavailable);
        finish();
      };
      recorder.onstop = async () => {
        release(recording);
        if (recording.abort.signal.aborted) return;
        setState('transcribing');
        try {
          const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
          if (!blob.size) throw new Error(copy.empty);
          const result = await transcribeVoiceInput(blob, recording.abort.signal);
          if (!recording.abort.signal.aborted) transcriptRef.current(result.text);
        } catch (cause) {
          if (!recording.abort.signal.aborted) setError(cause instanceof Error ? cause.message : copy.failed);
        } finally { finish(); }
      };
      recorder.start();
      const startedAt = Date.now();
      recording.timer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        setSeconds(elapsed);
        if (elapsed >= VOICE_INPUT_MAX_SECONDS && recorder.state === 'recording') recorder.stop();
      }, 250);
      setState('recording');
    } catch (cause) {
      if (!recording.abort.signal.aborted) setError(cause instanceof DOMException && cause.name === 'NotAllowedError' ? copy.denied : copy.unavailable);
      finish();
    }
  }
  const busy = state === 'permission' || state === 'transcribing';
  const label = state === 'recording' ? copy.stop : state === 'permission' ? copy.permission : state === 'transcribing' ? copy.processing : supported ? copy.start : copy.unsupported;
  const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return <div className="voice-input">
    <button type="button" className="voice-input__button" data-recording={state === 'recording' || undefined}
      aria-label={label} title={label} aria-pressed={state === 'recording'}
      disabled={!supported || busy || (disabled && state !== 'recording')} onClick={() => void toggle()}>
      {busy ? <LoaderCircle size={18} className="voice-input__spinner" /> : state === 'recording' ? <Square size={16} fill="currentColor" /> : <Mic size={18} />}
    </button>
    {state !== 'idle' || error ? <div className="voice-input__status">
      <span role={error ? 'alert' : 'status'}>{error || (state === 'recording' ? `${copy.recording} ${time} / 2:00` : label)}</span>
      <button type="button" className="voice-input__button" aria-label={error ? copy.close : copy.cancel}
        onClick={() => { cancel(); setError(''); }}><X size={16} /></button>
    </div> : null}
  </div>;
}
