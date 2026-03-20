import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { GoogleGenerativeAI } from '@google/generative-ai';
import sharp from 'sharp';
import nodemailer from 'nodemailer';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();

// ── CORS ──────────────────────────────────────────────────────────────────────
const appUrl = process.env.APP_URL ? process.env.APP_URL.replace(/\/$/, '') : '';
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  // Render sets APP_URL — normalise to always have https:// prefix
  ...(appUrl ? [
    appUrl,
    appUrl.startsWith('https://') ? appUrl : `https://${appUrl}`,
    appUrl.startsWith('http://') ? appUrl : `http://${appUrl}`,
  ] : []),
  // Hard-code the Render domain as fallback so it always works
  'https://teachaid.onrender.com',
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));

app.use(express.json({ limit: '50mb' }));

const genai = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || '');

function gemini(systemInstruction?: string) {
  return genai.getGenerativeModel({
    model: 'gemini-2.0-flash',
    ...(systemInstruction ? { systemInstruction } : {}),
  });
}

function parseJsonResponse(text: string) {
  return text.replace(/^```[a-z]*\n?/gm, '').replace(/```$/gm, '').trim();
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ─── TTS — 3-tier chain ────────────────────────────────────────────────────────
// Tier 1: XTTS-V2 local Python (best quality, EN + AR). Start: python3 tts_server.py
// Tier 2: Kokoro-82M Docker (high quality, EN only). Set KOKORO_URL env var.
// Tier 3: 503 → client falls back to browser Web Speech API
const XTTS_URL   = process.env.XTTS_URL   || 'http://127.0.0.1:3002/tts';
const KOKORO_URL = process.env.KOKORO_URL;
const WHISPER_URL = process.env.WHISPER_URL || 'http://127.0.0.1:3003/transcribe';

app.post('/api/tts', async (req, res) => {
  const { text, lang } = req.body as { text: string; lang?: string };
  if (!text) { res.status(400).json({ error: 'text required' }); return; }
  const language = lang || 'en';

  try {
    const upstream = await fetch(XTTS_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, lang: language }),
      signal: AbortSignal.timeout(120_000),
    });
    if (upstream.ok) {
      const wav = Buffer.from(await upstream.arrayBuffer());
      res.set('Content-Type', 'audio/wav').set('Cache-Control', 'public, max-age=3600').send(wav);
      return;
    }
  } catch { /* try Kokoro */ }

  if (KOKORO_URL && language === 'en') {
    try {
      const upstream = await fetch(`${KOKORO_URL}/v1/audio/speech`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'kokoro', input: text, voice: 'af_heart', response_format: 'wav' }),
        signal: AbortSignal.timeout(30_000),
      });
      if (upstream.ok) {
        const wav = Buffer.from(await upstream.arrayBuffer());
        res.set('Content-Type', 'audio/wav').set('Cache-Control', 'public, max-age=3600').send(wav);
        return;
      }
    } catch { /* browser fallback */ }
  }

  res.status(503).json({ error: 'No server TTS available — browser fallback active.' });
});

// ─── STT — single audio upload ────────────────────────────────────────────────
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) { res.status(400).json({ error: 'audio file required (field: audio)' }); return; }
  try {
    const form = new FormData();
    form.append('audio', new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' }), req.file.originalname || 'recording.webm');
    if (req.body?.language) form.append('language', req.body.language);
    const upstream = await fetch(WHISPER_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
    if (!upstream.ok) throw new Error(`Whisper responded ${upstream.status}`);
    res.json(await upstream.json());
  } catch (err: any) {
    console.error('/api/transcribe error:', err?.message);
    res.status(503).json({ error: 'Local Whisper STT unavailable. Start: python3 whisper_server.py' });
  }
});

// ─── Dev helper: serve test PDFs from /tmp ────────────────────────────────────
import { readFileSync } from 'fs';
app.get('/dev-pdf/:name', (req, res) => {
  try {
    const buf = readFileSync(`/tmp/${req.params.name}`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:3000');
    res.send(buf);
  } catch { res.status(404).json({ error: 'not found' }); }
});

// ─── Generate rubric from brief if none provided ─────────────────────────────
async function ensureRubric(briefText: string, rubricText?: string): Promise<string> {
  if (rubricText?.trim()) return rubricText;
  const result = await gemini('Academic grading rubric writer.').generateContent(
    `Create a concise grading rubric (4–6 criteria, each 0–100 points) for this assignment:\n\n${briefText}\n\n` +
    'Return plain text only — no JSON, no markdown headers. Format: "Criterion: weight% — description"'
  );
  return result.response.text().trim();
}

// ─── Submission Analysis (PDF pages → Gemini Vision → questions + grade) ─────
app.post('/api/analyze-submission', async (req, res) => {
  try {
    const { pages, briefText, rubricText, count = 8, fileName } = req.body as {
      pages: string[]; briefText: string; rubricText?: string; count?: number; fileName?: string;
    };
    if (!pages?.length) { res.status(400).json({ error: 'pages array is required.' }); return; }

    const effectiveRubric = await ensureRubric(briefText, rubricText);
    const rubricSource = rubricText?.trim() ? 'provided' : 'ai-generated';

    const pagesToAnalyze = pages.slice(0, 10);
    const parts: ({ text: string } | { inlineData: { mimeType: string; data: string } })[] = [];
    pagesToAnalyze.forEach((b64, idx) => {
      parts.push({ text: `--- PAGE ${idx + 1} (pageIndex ${idx}) ---` });
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: b64 } });
    });
    parts.push({
      text:
        `Assignment brief: ${briefText}\n` +
        `Grading rubric (${rubricSource}): ${effectiveRubric}\n\n` +
        `Pages above are a student submission${fileName ? ` ("${fileName}")` : ''}.\n\n` +
        `1. Grade against the brief and rubric. Be strict and specific.\n` +
        `2. Flag any signs of AI-generated content (overly formal phrasing, generic arguments, uniform sentence length, lack of personal examples).\n` +
        `3. Select exactly ${count} sections for targeted interview questions.\n` +
        `Each question must quote specific text — never generic topic questions.\n` +
        `Regions: normalized 0–1, (0,0)=top-left, keep tight.\n\n` +
        `Return ONLY valid JSON:\n` +
        `{ "grade": { "score": 78, "breakdown": "...", "feedback": "...", "rubricUsed": "${rubricSource}" },\n` +
        `  "suspicionFlags": [{ "type": "ai_content"|"plagiarism_risk", "severity": 1-5, "description": "..." }],\n` +
        `  "questions": [{ "pageIndex": 0, "region": {"x1":0.05,"y1":0.30,"x2":0.95,"y2":0.46},\n` +
        `    "textEn": "You wrote \\"phrase\\" — explain...", "textAr": "...",\n` +
        `    "followUpEn": "...", "followUpAr": "...", "order": 0 }] }`,
    });

    const result = await gemini('Academic integrity examiner. Generate targeted interview questions verifying genuine authorship. Every question references specific submission content.').generateContent(parts);
    const parsed = JSON.parse(parseJsonResponse(result.response.text())) as {
      grade: { score: number; breakdown: string; feedback: string; rubricUsed: string };
      suspicionFlags?: { type: string; severity: number; description: string }[];
      questions: { pageIndex: number; region: { x1: number; y1: number; x2: number; y2: number }; textEn: string; textAr: string; followUpEn?: string; followUpAr?: string; order: number }[];
    };

    const questionsWithImages = await Promise.all(parsed.questions.map(async (q, i) => {
      try {
        const b64 = pagesToAnalyze[q.pageIndex];
        if (!b64 || !q.region) return { ...q, id: `q-${i}` };
        const buf = Buffer.from(b64, 'base64');
        const { width: w, height: h } = await sharp(buf).metadata();
        if (!w || !h) return { ...q, id: `q-${i}` };
        const l = Math.max(0, Math.round(q.region.x1 * w) - 8);
        const t = Math.max(0, Math.round(q.region.y1 * h) - 8);
        const r = Math.min(w, Math.round(q.region.x2 * w) + 8);
        const b = Math.min(h, Math.round(q.region.y2 * h) + 8);
        if (r - l < 10 || b - t < 10) return { ...q, id: `q-${i}` };
        const cropped = await sharp(buf).extract({ left: l, top: t, width: r - l, height: b - t }).jpeg({ quality: 88 }).toBuffer();
        return { ...q, id: `q-${i}`, sectionImageBase64: cropped.toString('base64') };
      } catch { return { ...q, id: `q-${i}` }; }
    }));

    res.json({
      questions: questionsWithImages,
      grade: { ...parsed.grade, rubricText: effectiveRubric },
      suspicionFlags: parsed.suspicionFlags || [],
    });
  } catch (err: any) {
    console.error('/api/analyze-submission error:', err);
    res.status(500).json({ error: 'Submission analysis failed.', detail: String(err?.message || err) });
  }
});

// ─── Question Generation (text submissions) ───────────────────────────────────
app.post('/api/generate-questions', async (req, res) => {
  try {
    const { briefText, rubricText, submissionText, count = 12 } = req.body as {
      briefText: string; rubricText?: string; submissionText?: string; count?: number;
    };
    if (!briefText) { res.status(400).json({ error: 'briefText is required.' }); return; }

    const effectiveRubric = await ensureRubric(briefText, rubricText);

    const prompt = `Generate exactly ${count} oral interview questions.\n\nAssignment brief:\n${briefText}\n\nGrading rubric:\n${effectiveRubric}\n\n` +
      (submissionText ? `Submission content:\n${submissionText}\n\n` : '') +
      'Return JSON array ONLY. Each: { "textEn", "textAr", "order", "followUpEn", "followUpAr" }';

    const result = await gemini('Academic integrity interviewer. Generate oral questions verifying student understanding. Test reasoning, not recall.').generateContent(prompt);
    const questions = JSON.parse(parseJsonResponse(result.response.text()));
    if (!Array.isArray(questions)) throw new Error('AI returned non-array');
    res.json({ questions, rubricGenerated: !rubricText?.trim(), rubricText: effectiveRubric });
  } catch (err) {
    console.error('/api/generate-questions error:', err);
    res.status(500).json({ error: 'Question generation failed.' });
  }
});

// ─── Transcribe + Analyze (Faster Whisper → Claude) ──────────────────────────
// Downloads audio from Firebase Storage URLs, transcribes with local Faster Whisper
// (large-v3, no API key, handles EN+AR mixed speech + heavy accents),
// then analyses comprehension with Claude. Sequential — large-v3 needs full CPU memory.
app.post('/api/transcribe-and-analyze', async (req, res) => {
  try {
    const { questions, audioUrls, submissionText, rubricText } = req.body as {
      questions: { index: number; textEn: string }[];
      audioUrls: { questionIndex: number; url: string }[];
      submissionText: string; rubricText: string;
    };

    const transcripts: { questionIndex: number; questionText: string; responseText: string }[] = [];

    for (const { questionIndex, url } of audioUrls) {
      try {
        const audioRes = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (!audioRes.ok) { console.warn(`Audio download failed q${questionIndex}: ${audioRes.status}`); continue; }

        const form = new FormData();
        form.append('audio', new Blob([await audioRes.arrayBuffer()], { type: 'audio/webm' }), `q${questionIndex}.webm`);
        // Vocabulary primer: biases Whisper toward domain terms in the submission
        const hint = submissionText?.slice(0, 200).replace(/\n/g, ' ').trim();
        if (hint) form.append('prompt', hint);
        // No language field — auto-detect per segment for EN/AR code-switching

        const whisperRes = await fetch(WHISPER_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(300_000) });
        if (!whisperRes.ok) { console.warn(`Whisper ${whisperRes.status} for q${questionIndex}`); continue; }

        const { transcript, language, confidence } = await whisperRes.json() as { transcript: string; language: string; confidence: number };
        console.log(`[STT] q${questionIndex}: ${language} (${Math.round((confidence ?? 0) * 100)}%) — "${transcript.slice(0, 80)}"`);

        const questionText = questions.find(q => q.index === questionIndex)?.textEn ?? '';
        if (transcript.trim()) transcripts.push({ questionIndex, questionText, responseText: transcript.trim() });
      } catch (e) { console.error(`Whisper failed q${questionIndex}:`, e); }
    }

    const transcriptText = questions.map(q => {
      const t = transcripts.find(t => t.questionIndex === q.index);
      return `Q${q.index + 1}: ${q.textEn}\nStudent: ${t?.responseText || '[No transcript — review audio]'}`;
    }).join('\n\n');

    const analysisPrompt =
      'Submission:\n' + submissionText + '\n\nRubric:\n' + (rubricText || 'None') + '\n\nInterview transcript:\n' + transcriptText + '\n\n' +
      'Analyze the interview thoroughly. Return JSON ONLY:\n' +
      '{\n' +
      '  "comprehensionLevel": "High"|"Medium"|"Low",\n' +
      '  "recommendedAction": "Accept"|"Schedule Follow-up"|"Escalate for Review",\n' +
      '  "summary": "2-3 sentence overall assessment",\n' +
      '  "toneAnalysis": { "overall": "confident|nervous|evasive|rehearsed|natural", "description": "..." },\n' +
      '  "directness": { "score": 1-5, "description": "How directly the student answered questions" },\n' +
      '  "clarity": { "score": 1-5, "description": "Clarity and coherence of explanations" },\n' +
      '  "audioIssues": [{ "questionIndex": 0, "issue": "excessive_noise"|"multiple_speakers"|"inaudible"|"very_short_response"|"no_response", "description": "..." }],\n' +
      '  "flags": [{ "questionIndex": 0, "classification": "Hard Evidence"|"Soft Signal"|"Data Quality Issue", "severity": 1-5, "description": "..." }]\n' +
      '}';

    const analysisResult = await gemini().generateContent(analysisPrompt);
    res.json({ transcripts, analysis: JSON.parse(parseJsonResponse(analysisResult.response.text())) });
  } catch (err) {
    console.error('/api/transcribe-and-analyze error:', err);
    res.status(500).json({ error: 'Transcription/analysis failed.' });
  }
});

// ─── Extract text from a Firebase Storage URL ────────────────────────────────
app.post('/api/extract-text', async (req, res) => {
  try {
    const { url } = req.body as { url: string };
    if (!url) { res.status(400).json({ error: 'url required' }); return; }
    const fileRes = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!fileRes.ok) { res.status(502).json({ error: `Failed to fetch file: ${fileRes.status}` }); return; }
    const contentType = fileRes.headers.get('content-type') || '';
    const buffer = Buffer.from(await fileRes.arrayBuffer());
    // Plain text / markdown
    if (contentType.includes('text/') || url.endsWith('.txt') || url.endsWith('.md')) {
      res.json({ text: buffer.toString('utf-8').slice(0, 20000) });
      return;
    }
    // For PDF / DOCX: use Gemini to extract visible text from first few pages
    const base64 = buffer.toString('base64');
    const mimeType = contentType.split(';')[0] || 'application/octet-stream';
    const result = await gemini('Document text extractor.').generateContent([
      { inlineData: { mimeType, data: base64 } },
      { text: 'Extract all text from this document. Return plain text only, no markdown, no commentary.' },
    ]);
    res.json({ text: result.response.text().slice(0, 20000) });
  } catch (err: any) {
    console.error('/api/extract-text error:', err);
    res.status(500).json({ error: 'Text extraction failed.', detail: String(err?.message || err) });
  }
});

// ─── Generate assignment summary + generic questions ─────────────────────────
app.post('/api/generate-assignment-summary', async (req, res) => {
  try {
    const { briefText, rubricText, questionCount = 12 } = req.body as {
      briefText: string; rubricText?: string; questionCount?: number;
    };
    if (!briefText) { res.status(400).json({ error: 'briefText required' }); return; }
    const effectiveRubric = await ensureRubric(briefText, rubricText);

    // Summary paragraph
    const summaryResult = await gemini('Academic assignment analyst.').generateContent(
      `Write a concise 2–3 sentence summary of this assignment for the professor's dashboard:\n\n${briefText}\n\nFocus on learning objectives, deliverables, and assessment criteria. Plain text only.`
    );
    const summaryText = summaryResult.response.text().trim();

    // Generic questions
    const prompt =
      `Generate exactly ${questionCount} oral interview questions suitable for ANY student doing this assignment.\n\n` +
      `Assignment brief:\n${briefText}\n\nGrading rubric:\n${effectiveRubric}\n\n` +
      'These are generic questions asked before submission-specific questions. Focus on understanding, not recall.\n' +
      'Return JSON array ONLY. Each: { "textEn", "textAr", "order", "followUpEn", "followUpAr" }';
    const qResult = await gemini('Academic integrity interviewer.').generateContent(prompt);
    const questions = JSON.parse(parseJsonResponse(qResult.response.text()));

    res.json({ summaryText, questions, rubricText: effectiveRubric });
  } catch (err: any) {
    console.error('/api/generate-assignment-summary error:', err);
    res.status(500).json({ error: 'Summary generation failed.', detail: String(err?.message || err) });
  }
});

// ─── Generate per-student questions from their submission ─────────────────────
app.post('/api/generate-student-questions', async (req, res) => {
  try {
    const { submissionText, briefText, rubricText, genericQuestions = [], courseOutline, count = 8 } = req.body as {
      submissionText: string; briefText: string; rubricText?: string;
      genericQuestions?: { textEn: string }[]; courseOutline?: string; count?: number;
    };
    if (!submissionText || !briefText) { res.status(400).json({ error: 'submissionText and briefText required' }); return; }
    const effectiveRubric = await ensureRubric(briefText, rubricText);

    const genericList = genericQuestions.map((q, i) => `${i + 1}. ${q.textEn}`).join('\n');
    const prompt =
      `You are generating oral interview questions SPECIFIC to one student's submission.\n\n` +
      `Assignment brief:\n${briefText}\n\nRubric:\n${effectiveRubric}\n` +
      (courseOutline ? `\nCourse outline:\n${courseOutline}\n` : '') +
      `\nGeneric questions already asked:\n${genericList}\n\n` +
      `Student submission:\n${submissionText}\n\n` +
      `Generate exactly ${count} questions that reference specific content from THIS student's submission. ` +
      `Quote exact phrases they wrote. Do NOT duplicate the generic questions above.\n` +
      'Return JSON array ONLY. Each: { "textEn", "textAr", "order", "followUpEn", "followUpAr" }';

    const result = await gemini('Academic integrity interviewer. Generate targeted per-student questions.').generateContent(prompt);
    const questions = JSON.parse(parseJsonResponse(result.response.text()));
    res.json({ questions });
  } catch (err: any) {
    console.error('/api/generate-student-questions error:', err);
    res.status(500).json({ error: 'Student question generation failed.', detail: String(err?.message || err) });
  }
});

// ─── Send invite emails ───────────────────────────────────────────────────────
function buildInviteEmailHtml(studentName: string, assignmentTitle: string, inviteUrl: string): string {
  return `<!DOCTYPE html>
<html>
<body style="font-family: Georgia, serif; color: #1c1917; max-width: 600px; margin: 40px auto; padding: 0 20px;">
  <h2 style="color: #059669; font-weight: normal;">TeachAId — Interview Invitation</h2>
  <p>Dear ${studentName},</p>
  <p>You have been invited to complete an integrity interview for the following assignment:</p>
  <p style="background:#f5f5f4; border-left: 3px solid #059669; padding: 12px 16px; border-radius: 4px;">
    <strong>${assignmentTitle}</strong>
  </p>
  <p>Please click the link below to start your interview session. The link is personal and single-use.</p>
  <p style="margin: 24px 0;">
    <a href="${inviteUrl}" style="background: #059669; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-size: 15px;">
      Start My Interview
    </a>
  </p>
  <p style="color: #78716c; font-size: 13px;">If the button doesn't work, copy and paste this link:<br>
    <a href="${inviteUrl}" style="color: #059669;">${inviteUrl}</a>
  </p>
  <hr style="border: none; border-top: 1px solid #e7e5e4; margin: 32px 0;" />
  <p style="color: #a8a29e; font-size: 12px;">This email was sent by your professor via TeachAId. Do not reply to this email.</p>
</body>
</html>`;
}

app.post('/api/send-invites', async (req, res) => {
  try {
    const { invites, assignmentTitle, subject, body } = req.body as {
      invites: { studentId: string; email: string; name: string; inviteUrl: string }[];
      assignmentTitle: string;
      subject: string;
      body: string;
    };
    if (!invites?.length) { res.status(400).json({ error: 'invites array required' }); return; }

    const smtpHost = process.env.SMTP_HOST;
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    const smtpFrom = process.env.SMTP_FROM || smtpUser;
    const smtpPort = parseInt(process.env.SMTP_PORT || '587');

    if (!smtpHost || !smtpUser || !smtpPass) {
      res.status(503).json({ error: 'Email not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM in environment.' });
      return;
    }

    const transporter = nodemailer.createTransport({
      host: smtpHost, port: smtpPort, secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass },
    });

    const results: { studentId: string; status: 'sent' | 'failed'; error?: string }[] = [];
    for (const invite of invites) {
      try {
        const personalizedSubject = subject.replace(/\{\{name\}\}/g, invite.name).replace(/\{\{assignment\}\}/g, assignmentTitle);
        const personalizedBody = body
          .replace(/\{\{name\}\}/g, invite.name)
          .replace(/\{\{assignment\}\}/g, assignmentTitle)
          .replace(/\{\{link\}\}/g, invite.inviteUrl);
        const htmlBody = buildInviteEmailHtml(invite.name, assignmentTitle, invite.inviteUrl);
        // Use professor's custom body if it differs from default, else use HTML template
        const useCustom = body.trim().length > 0;
        await transporter.sendMail({
          from: smtpFrom, to: invite.email,
          subject: personalizedSubject,
          text: useCustom ? personalizedBody : `Dear ${invite.name},\n\nYou are invited to complete an integrity interview for: ${assignmentTitle}\n\nStart here: ${invite.inviteUrl}`,
          html: useCustom ? `<pre style="font-family: inherit;">${personalizedBody}</pre>` : htmlBody,
        });
        results.push({ studentId: invite.studentId, status: 'sent' });
      } catch (err: any) {
        results.push({ studentId: invite.studentId, status: 'failed', error: err.message });
      }
    }
    res.json({ results });
  } catch (err: any) {
    console.error('/api/send-invites error:', err);
    res.status(500).json({ error: 'Send invites failed.', detail: String(err?.message || err) });
  }
});

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => { res.json({ ok: true }); });

// ─── Static frontend (production) ─────────────────────────────────────────────
const distDir = join(__dirname, 'dist');
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (_req, res) => { res.sendFile(join(distDir, 'index.html')); });
}

const PORT = process.env.PORT || process.env.API_PORT || 3001;
app.listen(PORT, () => { console.log(`TeachAId API listening on port ${PORT}`); });
