// Client-side helpers that proxy all AI work through the Express server.
// The Anthropic API key NEVER leaves the server — this file contains no secrets.

const API_BASE = '/api';

export interface GeneratedQuestion {
  textEn: string;
  textAr: string;
  order: number;
  followUpEn?: string;
  followUpAr?: string;
}

export interface SessionAnalysis {
  comprehensionLevel: 'High' | 'Medium' | 'Low';
  recommendedAction: 'Accept' | 'Schedule Follow-up' | 'Escalate for Review';
  summary: string;
  flags: {
    questionIndex: number;
    classification: 'Hard Evidence' | 'Soft Signal' | 'Data Quality Issue';
    severity: number;
    description: string;
  }[];
}

export async function generateQuestions(
  briefText: string,
  rubricText: string,
  submissionText: string,
  count = 12
): Promise<GeneratedQuestion[]> {
  const res = await fetch(`${API_BASE}/generate-questions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ briefText, rubricText, submissionText, count }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || 'Question generation failed');
  }
  const data = await res.json();
  return data.questions as GeneratedQuestion[];
}

export async function analyzeSession(
  transcript: { questionIndex: number; questionText: string; responseText: string }[],
  submissionText: string,
  rubricText: string
): Promise<SessionAnalysis> {
  const res = await fetch(`${API_BASE}/analyze-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript, submissionText, rubricText }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || 'Analysis failed');
  }
  return res.json() as Promise<SessionAnalysis>;
}

// ─── Web Speech TTS (no API key required) ────────────────────────────────────

export function speakText(text: string, lang: 'en' | 'ar' = 'en'): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!('speechSynthesis' in window)) {
      resolve(); // silently skip if not supported
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang === 'ar' ? 'ar-SA' : 'en-US';
    utterance.rate = 0.9;
    utterance.onend = () => resolve();
    utterance.onerror = () => reject(new Error('TTS error'));
    window.speechSynthesis.speak(utterance);
  });
}

export function cancelSpeech(): void {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
}
