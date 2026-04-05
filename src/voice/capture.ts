/**
 * Layer 12 — Voice: Audio capture & transcription
 *
 * Push-to-talk voice input: capture mic audio, send to speech-to-text,
 * inject transcribed text as user message.
 *
 * Transcription backends:
 * 1. MiniMax Speech-to-Text API (if available)
 * 2. OpenAI Whisper API (if OPENAI_API_KEY set)
 * 3. Local whisper.cpp via Bash (if installed)
 *
 * Audio capture uses system `arecord` (Linux) or `sox` (cross-platform).
 * No native Node.js audio dependency — keeps it lightweight.
 */

import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// ─── Voice Configuration ────────────────────────────────

export interface VoiceConfig {
  /** Transcription backend */
  backend: 'whisper-api' | 'whisper-local' | 'minimax';
  /** OpenAI API key for Whisper API */
  whisperApiKey?: string;
  /** MiniMax API key */
  minimaxApiKey?: string;
  /** Path to local whisper.cpp binary */
  whisperBinaryPath?: string;
  /** Recording sample rate */
  sampleRate: number;
  /** Max recording duration in seconds */
  maxDuration: number;
}

export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  backend: 'whisper-api',
  sampleRate: 16000,
  maxDuration: 30,
};

// ─── Audio Recording ────────────────────────────────────

export interface Recording {
  filePath: string;
  durationMs: number;
  cleanup: () => Promise<void>;
}

/**
 * Record audio from the microphone.
 * Returns when the user stops (Ctrl+C or max duration).
 */
export async function recordAudio(
  durationSeconds: number = 30,
  abortSignal?: AbortSignal,
): Promise<Recording> {
  const tempPath = join(tmpdir(), `pcc-voice-${randomUUID().slice(0, 8)}.wav`);
  const startTime = Date.now();

  // Try sox first (cross-platform), then arecord (Linux)
  const recorder = await detectRecorder();

  return new Promise((resolve, reject) => {
    let args: string[];

    if (recorder === 'sox') {
      args = ['-d', '-t', 'wav', '-r', '16000', '-c', '1', '-b', '16', tempPath, 'trim', '0', String(durationSeconds)];
    } else if (recorder === 'arecord') {
      args = ['-f', 'S16_LE', '-r', '16000', '-c', '1', '-d', String(durationSeconds), tempPath];
    } else {
      reject(new Error('No audio recorder found. Install sox (rec command) or arecord.'));
      return;
    }

    const child = spawn(recorder === 'sox' ? 'rec' : 'arecord', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        child.kill('SIGINT'); // Graceful stop — saves the recorded audio
      }, { once: true });
    }

    child.on('error', () => {
      reject(new Error(`Failed to start ${recorder}. Is it installed?`));
    });

    child.on('close', () => {
      const durationMs = Date.now() - startTime;
      resolve({
        filePath: tempPath,
        durationMs,
        cleanup: async () => { try { await unlink(tempPath); } catch {} },
      });
    });
  });
}

// ─── Transcription ──────────────────────────────────────

/**
 * Transcribe audio to text.
 */
export async function transcribe(
  recording: Recording,
  config: VoiceConfig,
): Promise<string> {
  switch (config.backend) {
    case 'whisper-api':
      return transcribeWhisperAPI(recording.filePath, config.whisperApiKey ?? '');
    case 'whisper-local':
      return transcribeWhisperLocal(recording.filePath, config.whisperBinaryPath);
    case 'minimax':
      return transcribeMiniMax(recording.filePath, config.minimaxApiKey ?? '');
    default:
      throw new Error(`Unknown transcription backend: ${config.backend}`);
  }
}

// ─── Whisper API (OpenAI) ───────────────────────────────

async function transcribeWhisperAPI(audioPath: string, apiKey: string): Promise<string> {
  if (!apiKey) throw new Error('OPENAI_API_KEY required for Whisper API transcription');

  const { readFile: rf } = await import('node:fs/promises');
  const audioData = await rf(audioPath);

  const formData = new FormData();
  formData.append('file', new Blob([audioData], { type: 'audio/wav' }), 'audio.wav');
  formData.append('model', 'whisper-1');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Whisper API error: ${response.status} ${await response.text()}`);
  }

  const result = await response.json() as { text: string };
  return result.text;
}

// ─── Local Whisper.cpp ──────────────────────────────────

async function transcribeWhisperLocal(audioPath: string, binaryPath?: string): Promise<string> {
  const bin = binaryPath ?? 'whisper';

  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-f', audioPath, '--no-timestamps', '-l', 'auto'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    });

    let stdout = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.on('error', () => reject(new Error('whisper binary not found. Install whisper.cpp.')));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`whisper exited with code ${code}`));
    });
  });
}

// ─── MiniMax Speech-to-Text ─────────────────────────────

async function transcribeMiniMax(audioPath: string, apiKey: string): Promise<string> {
  if (!apiKey) throw new Error('MINIMAX_API_KEY required for MiniMax transcription');

  const { readFile: rf } = await import('node:fs/promises');
  const audioData = await rf(audioPath);

  // MiniMax Speech-to-Text API (if available — fallback to Whisper)
  try {
    const formData = new FormData();
    formData.append('file', new Blob([audioData], { type: 'audio/wav' }), 'audio.wav');

    const response = await fetch('https://api.minimax.io/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: formData,
    });

    if (response.ok) {
      const result = await response.json() as { text: string };
      return result.text;
    }
  } catch {
    // Fallback to local
  }

  return transcribeWhisperLocal(audioPath);
}

// ─── Helpers ────────────────────────────────────────────

async function detectRecorder(): Promise<'sox' | 'arecord' | null> {
  for (const cmd of ['rec', 'arecord'] as const) {
    const name = cmd === 'rec' ? 'sox' : 'arecord';
    const found = await commandExists(cmd);
    if (found) return name;
  }
  return null;
}

function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(process.platform === 'win32' ? 'where' : 'which', [cmd], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}
