// Client-side helpers that proxy all AI work through the Express server.
// The Google Gemini API key NEVER leaves the server — this file contains no secrets.

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

// ─── TTS — server first, browser SpeechSynthesis fallback ────────────────────
// Tries /api/tts (XTTS-V2 or Kokoro, high-quality) first.
// Falls back to Web Speech API automatically when the server returns 503
// (no TTS server configured) or is unreachable.

function speakWithBrowser(text: string, lang: 'en' | 'ar'): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!('speechSynthesis' in window)) { resolve(); return; }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang === 'ar' ? 'ar-SA' : 'en-US';
    utterance.rate = 0.9;
    utterance.onend = () => resolve();
    utterance.onerror = () => reject(new Error('Browser TTS error'));
    window.speechSynthesis.speak(utterance);
  });
}

export async function speakText(text: string, lang: 'en' | 'ar' = 'en'): Promise<void> {
  // Try server TTS first — gets the high-quality XTTS-V2 or Kokoro voice when available
  try {
    const res = await fetch(`${API_BASE}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, lang }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const audioBlob = await res.blob();
      const url = URL.createObjectURL(audioBlob);
      return new Promise((resolve, reject) => {
        const audio = new Audio(url);
        audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
        audio.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Audio playback error')); };
        audio.play().catch(reject);
      });
    }
    // 503 = no server TTS configured → fall through to browser
  } catch {
    // Server unreachable → fall through to browser
  }
  return speakWithBrowser(text, lang);
}

export function cancelSpeech(): void {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
}

// ─── Extract text from a file URL (brief/rubric) ─────────────────────────────
// Sends the Firebase Storage URL to the server so the server downloads the file
// directly. This avoids browser CORS issues when fetching from Firebase Storage.
export async function extractTextFromUrl(url: string): Promise<string> {
  const res = await fetch(`${API_BASE}/extract-text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error((errData as any).detail || (errData as any).error || 'Text extraction failed');
  }
  const data = await res.json();
  return (data as any).text as string;
}

// ─── Generate assignment summary + generic questions ─────────────────────────
export async function generateAssignmentSummary(
  briefText: string, rubricText: string, questionCount: number
): Promise<{ summaryText: string; questions: GeneratedQuestion[]; rubricText: string }> {
  const res = await fetch(`${API_BASE}/generate-assignment-summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ briefText, rubricText, questionCount }),
  });
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(
      (errData as any).detail || (errData as any).error || `Summary generation failed (${res.status})`
    );
  }
  return res.json() as Promise<{ summaryText: string; questions: GeneratedQuestion[]; rubricText: string }>;
}

// ─── Generate per-student questions from their submission ─────────────────────
export async function generateStudentQuestions(
  submissionText: string, briefText: string, rubricText: string,
  genericQuestions: GeneratedQuestion[], courseOutline?: string, count = 8
): Promise<GeneratedQuestion[]> {
  const res = await fetch(`${API_BASE}/generate-student-questions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ submissionText, briefText, rubricText, genericQuestions, courseOutline, count }),
  });
  if (!res.ok) throw new Error('Student question generation failed');
  const data = await res.json();
  return (data as any).questions as GeneratedQuestion[];
}

// ─── Send invite emails ───────────────────────────────────────────────────────
export interface InvitePayload {
  studentId: string;
  email: string;
  name: string;
  inviteUrl: string;
}

export async function getSmtpAccounts(): Promise<{ key: string; label: string; from: string }[]> {
  const res = await fetch(`${API_BASE}/smtp-accounts`);
  if (!res.ok) return [];
  // Server returns { accounts: [...] } — unwrap to the array
  const data = await res.json();
  return Array.isArray(data) ? data : (data.accounts ?? []);
}

export async function sendInvites(
  invites: InvitePayload[], assignmentTitle: string, subject: string, body: string,
  fromAccount?: string
): Promise<{ studentId: string; status: 'sent' | 'failed'; error?: string }[]> {
  const res = await fetch(`${API_BASE}/send-invites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ invites, assignmentTitle, subject, body, fromAccount }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || 'Send invites failed');
  }
  const data = await res.json();
  return (data as any).results;
}
