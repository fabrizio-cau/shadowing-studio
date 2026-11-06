import { useCallback, useEffect, useRef, useState } from 'react';
import { PANEL_PORT, type PanelMessage } from '../shared/messages';
import type { Recording } from '../shared/types';

export interface AttemptPlayer {
  currentId: string | null;
  playing: boolean;
  /** Seconds into the current attempt. */
  position: number;
  error: string | null;
  play: (recording: Recording) => void;
  pause: () => void;
  stop: () => void;
}

/**
 * One shared <audio> element for attempts, so only one plays at a time. Blob URLs are revoked
 * whenever the source changes. MediaRecorder files lack a duration header unless fixed, so the
 * UI uses the stored duration rather than `audio.duration`.
 */
export function useAttemptPlayer(onStart?: () => void): AttemptPlayer {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const onStartRef = useRef(onStart);
  onStartRef.current = onStart;
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const audio = useCallback((): HTMLAudioElement => {
    if (!audioRef.current) {
      const a = new Audio();
      a.preload = 'auto';
      a.addEventListener('play', () => setPlaying(true));
      a.addEventListener('pause', () => setPlaying(false));
      a.addEventListener('ended', () => {
        setPlaying(false);
        setPosition(0);
      });
      a.addEventListener('timeupdate', () => setPosition(a.currentTime));
      a.addEventListener('error', () => {
        setPlaying(false);
        setError('This recording could not be played.');
      });
      audioRef.current = a;
    }
    return audioRef.current;
  }, []);

  const release = () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  };

  useEffect(
    () => () => {
      audioRef.current?.pause();
      release();
    },
    [],
  );

  const play = useCallback(
    (recording: Recording) => {
      const a = audio();
      setError(null);
      if (currentId !== recording.id) {
        a.pause();
        release();
        urlRef.current = URL.createObjectURL(recording.blob);
        a.src = urlRef.current;
        setCurrentId(recording.id);
        setPosition(0);
      } else if (a.ended) {
        a.currentTime = 0;
      }
      onStartRef.current?.();
      a.play().catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return; // superseded by another play
        setError(`Playback failed: ${String(err)}`);
      });
    },
    [audio, currentId],
  );

  const pause = useCallback(() => audioRef.current?.pause(), []);

  const stop = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    a.pause();
    if (a.src) a.currentTime = 0;
    setPosition(0);
  }, []);

  return { currentId, playing, position, error, play, pause, stop };
}

/**
 * Tells the service worker whether we are recording so it can show the toolbar "REC" badge.
 * The badge is bound to this port: it disappears when the panel closes. If the worker is
 * restarted the port drops, so we reconnect and resend.
 */
export function useRecordingIndicator(active: boolean): void {
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  const send = useCallback(() => {
    if (!portRef.current) {
      try {
        const port = chrome.runtime.connect({ name: PANEL_PORT });
        port.onDisconnect.addListener(() => {
          void chrome.runtime.lastError;
          portRef.current = null;
          if (activeRef.current) send();
        });
        portRef.current = port;
      } catch {
        return;
      }
    }
    try {
      portRef.current.postMessage({ type: 'recording', active: activeRef.current } satisfies PanelMessage);
    } catch {
      portRef.current = null;
    }
  }, []);

  useEffect(() => {
    send();
  }, [active, send]);

  useEffect(() => () => portRef.current?.disconnect(), []);
}

/** Re-renders every `ms` while `enabled` — only for on-screen clocks, never for logic. */
export function useTicker(enabled: boolean, ms: number): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(id);
  }, [enabled, ms]);
}
