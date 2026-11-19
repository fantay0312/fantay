// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceInputButton } from '../../../src/components/composer/VoiceInputButton';
import { transcribeVoiceInput } from '../../../src/providers/voice-input';

vi.mock('../../../src/providers/voice-input', () => ({ transcribeVoiceInput: vi.fn() }));
const stopTrack = vi.fn();
class Recorder {
  static isTypeSupported() { return true; }
  state = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable?: (event: { data: Blob }) => void;
  onstop?: () => void;
  onerror?: () => void;
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['audio']) });
    this.onstop?.();
  }
}
beforeEach(() => {
  vi.stubGlobal('MediaRecorder', Recorder);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('voice input recording', () => {
  it('releases the microphone and returns the transcript only after stopping', async () => {
    vi.mocked(transcribeVoiceInput).mockResolvedValue({ text: 'voice draft', model: 'asr' });
    const onTranscript = vi.fn();
    render(<VoiceInputButton onTranscript={onTranscript} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
    await screen.findByRole('button', { name: 'Stop and transcribe' });
    expect(onTranscript).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop and transcribe' }));
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('voice draft'));
    expect(stopTrack).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Start voice input' })).toBeTruthy();
  });
  it('cancels recognition and ignores a late response', async () => {
    let resolve!: (value: { text: string; model: string }) => void;
    vi.mocked(transcribeVoiceInput).mockImplementation(() => new Promise(done => { resolve = done; }));
    const onTranscript = vi.fn();
    render(<VoiceInputButton onTranscript={onTranscript} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop and transcribe' }));
    await screen.findByRole('button', { name: 'Transcribing…' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel voice input' }));
    await act(async () => { resolve({ text: 'late', model: 'asr' }); });
    expect(onTranscript).not.toHaveBeenCalled();
    expect(vi.mocked(transcribeVoiceInput).mock.calls[0]![1].aborted).toBe(true);
  });
  it('releases a microphone granted after the component unmounts', async () => {
    let resolve!: (value: MediaStream) => void;
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(() => new Promise(done => { resolve = done; }));
    const view = render(<VoiceInputButton onTranscript={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
    view.unmount();
    await act(async () => { resolve({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream); });
    expect(stopTrack).toHaveBeenCalled();
    expect(transcribeVoiceInput).not.toHaveBeenCalled();
  });
  it('shows a recoverable permission failure', async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValue(new DOMException('No', 'NotAllowedError'));
    render(<VoiceInputButton onTranscript={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Microphone access was denied');
    expect(screen.getByRole('button', { name: 'Start voice input' })).toBeEnabled();
  });
  it('automatically stops and transcribes at the two-minute limit', async () => {
    vi.useFakeTimers();
    vi.mocked(transcribeVoiceInput).mockResolvedValue({ text: 'finished', model: 'asr' });
    const onTranscript = vi.fn();
    render(<VoiceInputButton onTranscript={onTranscript} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start voice input' })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(onTranscript).toHaveBeenCalledWith('finished');
    expect(stopTrack).toHaveBeenCalled();
  });
});
