import { useState, useEffect, useRef, useCallback } from 'react';
import { db, storage } from '../firebase';
import {
  doc, getDoc, collection, query, where, getDocs, updateDoc,
  addDoc, serverTimestamp, orderBy
} from 'firebase/firestore';
import { ref, uploadBytes } from 'firebase/storage';
import { InterviewSession, Student, Assignment, Question } from '../types';
import { Loader2, Mic, Upload, CheckCircle2, AlertCircle, Camera, Settings, X } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn, formatDuration } from '../lib/utils';
import { speakText, cancelSpeech } from '../lib/claude';
import { logAudit } from '../lib/audit';

interface Props {
  token: string;
}

type Step = 'loading' | 'consent' | 'audio-check' | 'upload' | 'interview' | 'final-comment' | 'completion';

export default function StudentPortal({ token }: Props) {
  const [step, setStep] = useState<Step>('loading');
  const [session, setSession] = useState<InterviewSession | null>(null);
  const [student, setStudent] = useState<Student | null>(null);
  const [assignment, setAssignment] = useState<Assignment | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [isBranchQuestion, setIsBranchQuestion] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [timeLeft, setTimeLeft] = useState(480); // 8 minutes for 6-question interview
  const [selectedOption, setSelectedOption] = useState<'a' | 'b' | 'c' | 'd' | null>(null);
  const [recordingAmplitude, setRecordingAmplitude] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [arabicEnabled, setArabicEnabled] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [isTestMode, setIsTestMode] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState<'idle' | 'uploading' | 'generating' | 'done'>('idle');
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [micStatus, setMicStatus] = useState<'testing' | 'pass' | 'fail'>('testing');
  const [questionPhase, setQuestionPhase] = useState<'playing' | 'countdown' | 'recording' | 'uploading'>('playing');
  const [tokenDocId, setTokenDocId] = useState<string | null>(null);
  const [recordingStartTime, setRecordingStartTime] = useState<number>(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const snapshotTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micAnimRef = useRef<number | null>(null);
  const recAnalyserRef = useRef<AnalyserNode | null>(null);
  const recAnimRef = useRef<number | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null); // holds stream until video element mounts
  const [micAmplitude, setMicAmplitude] = useState(0);

  const videoCallbackRef = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node;
    if (node && cameraStreamRef.current) {
      node.srcObject = cameraStreamRef.current;
      node.play().catch(() => {});
    }
  }, []);

  // ─── Detect test mode from URL ───────────────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('test') === 'true') setIsTestMode(true);
  }, []);

  // ─── Token validation ─────────────────────────────────────────────────────────
  useEffect(() => {
    const validateToken = async () => {
      try {
        // Hash the raw token before lookup — tokenHash stores SHA-256(rawToken)
        const encoder = new TextEncoder();
        const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(token));
        const tokenHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

        const tokenQuery = query(
          collection(db, 'inviteTokens'),
          where('tokenHash', '==', tokenHash)
        );
        const tokenSnapshot = await getDocs(tokenQuery);

        if (tokenSnapshot.empty) {
          setError('Invalid or expired access code. Please contact your educator for a new link.');
          return;
        }

        const tokenDoc = tokenSnapshot.docs[0];
        const tokenData = tokenDoc.data();

        if (tokenData.usedAt) {
          setError('This code has already been used. If your session was interrupted, please contact your teacher for a new code.');
          return;
        }

        // Check expiry
        if (tokenData.expiry && new Date(tokenData.expiry) < new Date()) {
          setError('This access code has expired. Please contact your educator for a new link.');
          return;
        }

        // Store the token doc ID so we can mark it used when the interview actually starts.
        // We do NOT mark usedAt here — if the student's machine crashes during the consent
        // or mic check steps they would be locked out permanently. The token is burned
        // atomically in startInterview() once the session record is created.
        setTokenDocId(tokenDoc.id);

        const [assignmentDoc, studentDoc] = await Promise.all([
          getDoc(doc(db, 'assignments', tokenData.assignmentId)),
          getDoc(doc(db, 'students', tokenData.studentId)),
        ]);

        if (!assignmentDoc.exists() || !studentDoc.exists()) {
          setError('Session data could not be loaded. Please contact your educator.');
          return;
        }

        const assignmentData = { id: assignmentDoc.id, ...assignmentDoc.data() } as Assignment;

        // Check interview window
        const now = new Date();
        if (new Date(assignmentData.windowClose) < now) {
          setError(`This interview window has closed (closed on ${new Date(assignmentData.windowClose).toLocaleDateString()}). Please contact your educator.`);
          return;
        }
        if (new Date(assignmentData.windowOpen) > now) {
          setError(`This interview window opens on ${new Date(assignmentData.windowOpen).toLocaleString()}. Please come back then.`);
          return;
        }

        setAssignment(assignmentData);
        setStudent({ id: studentDoc.id, ...studentDoc.data() } as Student);
        setTimeLeft(isTestMode ? 30 : 480); // 8 minutes for 6-question interview

        // Load questions — prefer inline array on assignment doc (no subcollection permission needed),
        // fall back to subcollection for backwards compatibility with older assignments.
        const inlineQs: Question[] = assignmentData.questions || [];
        if (inlineQs.length > 0) {
          const sorted = [...inlineQs].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
          setQuestions(sorted.map((q, i) => ({ ...q, id: q.id ?? String(i) })));
        } else {
          const qDocs = await getDocs(
            query(collection(db, 'assignments', assignmentDoc.id, 'questions'), orderBy('order'))
          );
          if (!qDocs.empty) {
            setQuestions(qDocs.docs.map(d => ({ id: d.id, ...d.data() } as Question)));
          } else {
            // Fallback placeholder questions
            setQuestions([
              { id: '1', textEn: 'Please explain the main argument of your submission in your own words.', textAr: 'يرجى شرح الحجة الرئيسية لعملك بكلماتك الخاصة.', order: 0 },
              { id: '2', textEn: 'What was the most challenging part of this assignment?', textAr: 'ما هو الجزء الأكثر تحديًا في هذا التكليف؟', order: 1 },
              { id: '3', textEn: 'How did you select your primary sources?', textAr: 'كيف اخترت مصادرك الأولية؟', order: 2 },
            ]);
          }
        }

        setStep('consent');
      } catch (err) {
        console.error(err);
        setError('Failed to load interview session. Please check your connection and try again.');
      }
    };

    validateToken();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // ─── Interview timer ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (step === 'interview' || step === 'final-comment') {
      if (isTestMode) return; // skip timer in test mode
      timerRef.current = setInterval(() => {
        setTimeLeft(prev => {
          if (prev <= 1) {
            handleTimerExpiry();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, isTestMode]);

  // ─── Clipboard blocking during interview ──────────────────────────────────────
  useEffect(() => {
    if (step !== 'interview' && step !== 'final-comment') return;
    const block = (e: ClipboardEvent) => e.preventDefault();
    document.addEventListener('copy', block);
    document.addEventListener('cut', block);
    document.addEventListener('paste', block);
    return () => {
      document.removeEventListener('copy', block);
      document.removeEventListener('cut', block);
      document.removeEventListener('paste', block);
    };
  }, [step]);

  // ─── Connect camera stream once the PiP <video> element mounts ───────────────
  useEffect(() => {
    if (step === 'interview' && videoRef.current && cameraStreamRef.current) {
      videoRef.current.srcObject = cameraStreamRef.current;
      videoRef.current.play().catch(() => {}); // force play; autoPlay alone can be blocked before user interaction
    }
  }, [step]); // runs right after step becomes 'interview' and DOM updates

  // ─── Auto-play question when index changes ────────────────────────────────────
  useEffect(() => {
    if (step === 'interview' && questions.length > 0) {
      playQuestion(currentQuestionIndex, isBranchQuestion);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, currentQuestionIndex]);

  // ─── Microphone check ─────────────────────────────────────────────────────────
  const startMicCheck = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;

      const data = new Uint8Array(analyser.frequencyBinCount);
      let signalDetected = false;

      const tick = () => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        setMicAmplitude(avg);
        if (avg > 5 && !signalDetected) {
          signalDetected = true;
          setMicStatus('pass');
        }
        micAnimRef.current = requestAnimationFrame(tick);
      };
      micAnimRef.current = requestAnimationFrame(tick);
      setMicStatus('testing');
    } catch {
      setMicStatus('fail');
    }
  }, []);

  useEffect(() => {
    if (step === 'audio-check') {
      startMicCheck();
    }
    return () => {
      if (micAnimRef.current) cancelAnimationFrame(micAnimRef.current);
      micStreamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, [step, startMicCheck]);

  // ─── Consent submit ───────────────────────────────────────────────────────────
  const handleConsent = async () => {
    if (!student || !assignment) return;
    // Log consent with timestamp
    await addDoc(collection(db, 'consentRecords'), {
      studentId: student.id,
      assignmentId: assignment.id,
      timestamp: serverTimestamp(),
    });
    await logAudit('Consent Given', `Student ${student.name} gave consent for ${assignment.title}`, student.id);
    setStep('audio-check');
  };

  // ─── File upload ──────────────────────────────────────────────────────────────
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const allowed = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'];
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (!allowed.includes(file.type) && !['pdf', 'docx', 'txt'].includes(ext || '')) {
      alert('Only PDF, DOCX, or TXT files are accepted.');
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      alert('File size must be under 20MB.');
      return;
    }
    setUploadedFile(file);
  };

  // ─── Start interview ──────────────────────────────────────────────────────────
  const startInterview = async () => {
    if (!student || !assignment || !uploadedFile) return;

    setUploadProgress('uploading');
    let workFileUrl = '';
    try {
      const storageRef = ref(storage, `submissions/${assignment.id}/${student.id}_${Date.now()}_${uploadedFile.name}`);
      await uploadBytes(storageRef, uploadedFile);
      workFileUrl = storageRef.fullPath;
    } catch {
      setUploadProgress('idle');
      alert('File upload failed. Please check your connection and try again.');
      return;
    }
    setUploadProgress('done');

    // Burn the token now — the interview is actually starting.
    // Doing this here (not on page load) allows students to fix technical issues
    // during consent/mic-check without losing their link.
    if (tokenDocId) {
      await updateDoc(doc(db, 'inviteTokens', tokenDocId), { usedAt: serverTimestamp() });
    }

    // Create session record
    const sessionRef = await addDoc(collection(db, 'interviewSessions'), {
      studentId: student.id,
      assignmentId: assignment.id,
      submissionId: '',
      workFileUrl,
      status: 'IN_PROGRESS',
      currentQuestionIndex: 0,
      startedAt: serverTimestamp(),
      arabicAudioEnabled: arabicEnabled,
      isTestMode,
    });

    const sessionData: InterviewSession = {
      id: sessionRef.id,
      status: 'IN_PROGRESS',
      currentQuestionIndex: 0,
      studentId: student.id,
      assignmentId: assignment.id,
      submissionId: '',
      arabicAudioEnabled: arabicEnabled,
    };
    setSession(sessionData);

    await logAudit('Interview Started', `Student ${student.name} started interview for ${assignment.title}`, student.id, { isTestMode });

    // ─── Generate per-student open questions from the uploaded submission ─────
    // 3 open questions (from student's own text) go first (orders 0–2),
    // then the 3 assignment-level MCQ questions (orders 3–5).
    setUploadProgress('generating');
    try {
      const { extractTextFromFile, pregenAudio: pregenAudioFn } = await import('../lib/claude');
      const submissionText = await extractTextFromFile(uploadedFile);

      // Generate 3 open questions targeting passages in this student's submission
      const qRes = await fetch('/api/generate-student-questions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          submissionText,
          briefText: assignment.summaryText || assignment.title,
          rubricText: assignment.rubricText || '',
        }),
      });
      const { questions: rawOpenQs } = await qRes.json();

      // Pre-generate audio — stored at sessions/{sessionId}/audio/q{n}_{en|ar}.mp3
      const openQsWithAudio = await pregenAudioFn(
        rawOpenQs,
        `sessions/${sessionRef.id}/audio`
      );

      // Assign orders 0–2 and persist on the session doc
      const openWithOrders = openQsWithAudio.map((q: Question, i: number) => ({ ...q, order: i }));
      await updateDoc(doc(db, 'interviewSessions', sessionRef.id), { openQuestions: openWithOrders });

      // Merge: open (0–2) + MCQ (3–5)
      const mcqQs = (assignment.questions || [])
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((q, i) => ({ ...q, id: q.id ?? String(3 + i), order: 3 + i }));
      let finalMcqQs = mcqQs;
      if (finalMcqQs.length === 0) {
        try {
          const mcqSnap = await getDocs(query(
            collection(db, 'assignments', assignment.id, 'questions'),
            orderBy('order', 'asc')
          ));
          finalMcqQs = mcqSnap.docs
            .map((d, i) => ({ ...(d.data() as Question), id: d.id, order: 3 + i }));
        } catch { /* subcollection may not exist */ }
      }
      setQuestions([
        ...openWithOrders.map((q: Question, i: number) => ({ ...q, id: String(i) })),
        ...finalMcqQs,
      ]);
    } catch (genErr) {
      console.warn('[startInterview] Per-student question generation failed:', genErr);
      // Fall back to MCQ-only
      try {
        const fallbackMcq = (assignment.questions || []).length > 0
          ? (assignment.questions || [])
              .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
              .map((q, i) => ({ ...q, id: q.id ?? String(i), order: i }))
          : await getDocs(query(collection(db, 'assignments', assignment.id, 'questions'), orderBy('order', 'asc')))
              .then(snap => snap.docs.map((d, i) => ({ ...(d.data() as Question), id: d.id, order: i })));
        setQuestions(fallbackMcq);
      } catch { /* no questions available */ }
    }

    // Start camera — store stream in ref; the video element only mounts after setStep('interview')
    // so we apply srcObject in a useEffect once the DOM element is available.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      cameraStreamRef.current = stream;

      // Periodic snapshot every 60 seconds
      snapshotTimerRef.current = setInterval(() => {
        takeSnapshot(sessionRef.id, currentQuestionIndex, false);
      }, isTestMode ? 10000 : 60000);
    } catch {
      // Camera denied — log but don't block
      await addDoc(collection(db, 'interviewSessions', sessionRef.id, 'notes'), {
        type: 'camera_denied',
        timestamp: serverTimestamp(),
      });
    }

    setStep('interview');
  };

  // ─── Question playback — uses pre-generated audio URLs when available ────────
  const playAudioUrl = (url: string): Promise<void> =>
    new Promise((resolve) => {
      const audio = new Audio(url);
      audio.onended = () => resolve();
      audio.onerror = () => resolve(); // failure → continue
      audio.play().catch(() => resolve());
    });

  const playQuestion = async (index: number, isBranch = false) => {
    setQuestionPhase('playing');
    setSelectedOption(null); // reset MCQ selection for new question
    cancelSpeech();

    const q = questions[index];

    try {
      if (!isBranch && q.audioUrlEn) {
        // Use pre-generated high-quality audio
        await playAudioUrl(q.audioUrlEn);
        if (arabicEnabled && q.audioUrlAr) {
          await new Promise(r => setTimeout(r, 1000));
          await playAudioUrl(q.audioUrlAr);
        }
      } else {
        // Fall back to live TTS (branch questions or missing pre-gen audio)
        const text = isBranch ? (q.followUpEn || q.textEn) : q.textEn;
        const textAr = isBranch ? (q.followUpAr || q.textAr) : q.textAr;
        await speakText(text, 'en');
        if (arabicEnabled) {
          await new Promise(r => setTimeout(r, 2000));
          await speakText(textAr, 'ar');
        }
      }
    } catch {
      // TTS failure — continue anyway
    }

    startCountdown();
  };

  const startCountdown = () => {
    setQuestionPhase('countdown');
    setCountdown(isTestMode ? 3 : 3);
    const iv = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(iv);
          startRecording();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  // ─── Recording ────────────────────────────────────────────────────────────────
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];
      setRecordingStartTime(Date.now());

      // Real-time audio level meter
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      recAnalyserRef.current = analyser;
      const data = new Uint8Array(analyser.frequencyBinCount);
      const poll = () => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        setRecordingAmplitude(avg);
        recAnimRef.current = requestAnimationFrame(poll);
      };
      recAnimRef.current = requestAnimationFrame(poll);

      mediaRecorder.ondataavailable = e => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        // Stop amplitude polling
        if (recAnimRef.current) cancelAnimationFrame(recAnimRef.current);
        setRecordingAmplitude(0);
        stream.getTracks().forEach(t => t.stop());
        const duration = (Date.now() - recordingStartTime) / 1000;
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        await uploadChunk(blob, duration);
      };

      mediaRecorder.start();
      setIsRecording(true);
      setQuestionPhase('recording');
    } catch {
      // mic error — advance anyway
      advanceAfterResponse(0);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  // ─── Upload response chunk ────────────────────────────────────────────────────
  const uploadChunk = async (blob: Blob, duration: number) => {
    if (!session) return;
    setQuestionPhase('uploading');
    setIsUploading(true);

    try {
      const storageRef = ref(storage, `sessions/${session.id}/q${currentQuestionIndex}${isBranchQuestion ? '_branch' : ''}.webm`);
      await uploadBytes(storageRef, blob);

      await addDoc(collection(db, 'interviewSessions', session.id, 'responseChunks'), {
        questionIndex: currentQuestionIndex,
        isBranch: isBranchQuestion,
        timestamp: serverTimestamp(),
        duration,
        uploadConfirmedAt: serverTimestamp(),
        ...(selectedOption ? { selectedOption } : {}),
      });

      // Snapshot at submission moment
      takeSnapshot(session.id, currentQuestionIndex, true);

      // Update session progress in Firestore
      await updateDoc(doc(db, 'interviewSessions', session.id), {
        currentQuestionIndex,
      });

      advanceAfterResponse(duration);
    } catch {
      // Upload failed — mark incomplete
      if (session) {
        await updateDoc(doc(db, 'interviewSessions', session.id), {
          status: 'INCOMPLETE',
          disruptionCause: 'upload_failed',
        });
      }
      setError('Your answer could not be saved. Please check your connection and contact your educator for a new code.');
    } finally {
      setIsUploading(false);
    }
  };

  // ─── Advance question or branch ───────────────────────────────────────────────
  const advanceAfterResponse = (duration: number) => {
    const MIN_DURATION = isTestMode ? 2 : 15;
    const currentQ = questions[currentQuestionIndex];
    const isMcq = currentQ?.questionType === 'mcq';

    // Branch logic skipped for MCQ questions (they always advance after one answer)
    if (!isMcq && !isBranchQuestion && duration < MIN_DURATION && currentQ?.followUpEn) {
      // Serve branch question
      setIsBranchQuestion(true);
      playQuestion(currentQuestionIndex, true);
      return;
    }

    setIsBranchQuestion(false);
    const nextIndex = currentQuestionIndex + 1;

    if (nextIndex >= questions.length) {
      // All questions done — play thank-you then open final comment window
      handleAllQuestionsAnswered();
    } else {
      setCurrentQuestionIndex(nextIndex);
      // The useEffect watching currentQuestionIndex will auto-play the next question
    }
  };

  const handleAllQuestionsAnswered = async () => {
    if (timerRef.current) clearInterval(timerRef.current);
    cancelSpeech();
    await speakText('Thank you for completing the interview. Is there anything else you would like to add?', 'en');
    if (arabicEnabled) {
      await speakText('شكرًا لإتمامك المقابلة. هل هناك أي شيء آخر تود إضافته؟', 'ar');
    }
    setStep('final-comment');
    startFinalRecording();
  };

  const startFinalRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = mr;
      audioChunksRef.current = [];
      mr.ondataavailable = e => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      mr.start();
      setIsRecording(true);

      // 60-second silence timeout
      timerRef.current = setTimeout(async () => {
        if (isRecording) await confirmEndSession();
      }, 60000) as any;
    } catch {
      await confirmEndSession();
    }
  };

  // ─── Timer expiry (session forced close) ─────────────────────────────────────
  const handleTimerExpiry = async () => {
    if (timerRef.current) clearInterval(timerRef.current);
    stopRecording();
    await completeSession();
    setStep('completion');
  };

  // ─── End session ─────────────────────────────────────────────────────────────
  const confirmEndSession = async () => {
    setShowEndConfirm(false);
    stopRecording();
    // Upload any pending final comment
    if (audioChunksRef.current.length > 0) {
      const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
      if (session) {
        const storageRef = ref(storage, `sessions/${session.id}/final_comment.webm`);
        await uploadBytes(storageRef, blob).catch(() => {});
      }
    }
    await completeSession();
    setStep('completion');
  };

  const completeSession = async () => {
    if (!session) return;
    if (snapshotTimerRef.current) clearInterval(snapshotTimerRef.current);
    // Release camera
    cameraStreamRef.current?.getTracks().forEach(t => t.stop());
    cameraStreamRef.current = null;
    await updateDoc(doc(db, 'interviewSessions', session.id), {
      status: 'AWAITING_PROCESSING',
      completedAt: serverTimestamp(),
    });
    await logAudit('Interview Completed', `Student ${student?.name} completed interview for ${assignment?.title}`, student?.id);
  };

  // ─── Snapshot ─────────────────────────────────────────────────────────────────
  const takeSnapshot = (sessionId: string, qIndex: number, isSubmission: boolean) => {
    if (!videoRef.current || !canvasRef.current) return;
    // readyState < 2 (HAVE_CURRENT_DATA) means no frame has decoded yet — drawImage would produce black
    if (videoRef.current.readyState < 2) return;
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(videoRef.current, 0, 0, 640, 480);
    canvasRef.current.toBlob(async blob => {
      if (!blob) return;
      // Use the same timestamp for both the filename and the Firestore record so
      // ReportViewer can reliably reconstruct the Storage path from storagePath.
      const storagePath = `sessions/${sessionId}/snap_${Date.now()}.jpg`;
      const snapshotRef = ref(storage, storagePath);
      await uploadBytes(snapshotRef, blob).catch(() => {});
      await addDoc(collection(db, 'interviewSessions', sessionId, 'snapshots'), {
        storagePath,            // stored path — avoids serverTimestamp vs Date.now() mismatch
        questionIndex: qIndex,
        isSubmissionSnapshot: isSubmission,
        timestamp: serverTimestamp(),
      });
    }, 'image/jpeg', 0.8);
  };

  // ─── Error screen ─────────────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="min-h-screen bg-stone-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white p-8 rounded-3xl shadow-xl text-center">
          <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
          <h2 className="text-xl font-medium text-stone-900 mb-2">Cannot Start Interview</h2>
          <p className="text-stone-500 mb-6">{error}</p>
        </div>
      </div>
    );
  }

  if (step === 'loading') {
    return (
      <div className="min-h-screen bg-stone-50 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-emerald-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-stone-50 flex flex-col">
      <header className="h-16 bg-white border-b border-stone-200 flex items-center px-8">
        <h1 className="text-xl font-serif font-medium text-emerald-700">TeachAId</h1>
        {isTestMode && (
          <span className="ml-4 px-3 py-1 bg-amber-100 text-amber-700 rounded-lg text-xs font-bold uppercase tracking-wider flex items-center gap-1">
            <Settings className="w-3 h-3" /> Testing Mode
          </span>
        )}
        <div className="mx-4 h-4 w-px bg-stone-200" />
        <p className="text-sm text-stone-500 font-medium truncate">{assignment?.title}</p>
      </header>

      {/* Hidden canvas for snapshot capture — video is shown as PiP inside the interview card */}
      <canvas ref={canvasRef} width="640" height="480" className="hidden" />

      <main className="flex-1 flex items-center justify-center p-4">
        <AnimatePresence mode="wait">

          {/* ── Consent ─────────────────────────────────────────────────────── */}
          {step === 'consent' && (
            <motion.div
              key="consent"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.05 }}
              className="max-w-2xl w-full bg-white p-10 rounded-[40px] shadow-xl shadow-stone-200/50"
            >
              <h2 className="text-3xl font-serif font-medium text-stone-900 mb-2">
                Welcome, {student?.name}
              </h2>
              <p className="text-stone-500 mb-8">
                Assignment: <span className="font-medium text-stone-700">{assignment?.title}</span>
              </p>

              <div className="prose prose-stone mb-6 text-sm text-stone-600 space-y-3">
                <p>This interview helps verify your understanding of the work you've submitted. Here's what to expect:</p>
                <ul className="list-disc pl-5 space-y-1">
                  <li>You will be asked {assignment?.questionCount || 12} questions about your submission.</li>
                  <li>Questions will be read aloud in English{arabicEnabled ? ' and Arabic' : ''}.</li>
                  <li>Your spoken responses will be recorded.</li>
                  <li>
                    {assignment?.captureMode === 'Video'
                      ? 'Continuous video of your webcam will be recorded throughout each response.'
                      : 'Periodic still photographs will be taken from your webcam for presence verification.'}
                  </li>
                  <li>The session will take up to 10 minutes.</li>
                </ul>
                <p className="text-xs text-stone-400 mt-4">
                  Your data will be reviewed only by your educator. Recordings are retained for one year after the assignment closes.
                  You may request deletion of your recordings at any time by contacting your educator.
                </p>
              </div>

              <div className="bg-stone-50 p-6 rounded-3xl mb-8 border border-stone-100">
                <label className="flex items-start gap-4 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={consentChecked}
                    onChange={e => setConsentChecked(e.target.checked)}
                    className="mt-1 w-5 h-5 rounded border-stone-300 text-emerald-600 focus:ring-emerald-500 cursor-pointer"
                  />
                  <span className="text-sm text-stone-700 leading-relaxed">
                    I have read and understood the above. I consent to the recording of my audio{' '}
                    {assignment?.captureMode === 'Video' ? 'and video' : 'and still snapshots'} for academic integrity purposes.
                  </span>
                </label>
              </div>

              <button
                disabled={!consentChecked}
                onClick={handleConsent}
                className="w-full bg-stone-900 text-white py-4 rounded-2xl font-medium hover:bg-stone-800 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                I Agree &amp; Continue
              </button>
            </motion.div>
          )}

          {/* ── Microphone Check ─────────────────────────────────────────────── */}
          {step === 'audio-check' && (
            <motion.div
              key="audio"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              className="max-w-md w-full bg-white p-10 rounded-[40px] shadow-xl text-center"
            >
              <div className={cn(
                "w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6 transition-colors",
                micStatus === 'pass' ? "bg-emerald-100" : micStatus === 'fail' ? "bg-red-100" : "bg-stone-100"
              )}>
                <Mic className={cn(
                  "w-10 h-10 transition-colors",
                  micStatus === 'pass' ? "text-emerald-600" : micStatus === 'fail' ? "text-red-500" : "text-stone-400"
                )} />
              </div>
              <h2 className="text-2xl font-serif font-medium text-stone-900 mb-4">Microphone Check</h2>
              <p className="text-stone-500 mb-8">
                {micStatus === 'fail'
                  ? 'Microphone access was denied. Please allow microphone access in your browser settings and reload.'
                  : micStatus === 'pass'
                    ? 'Microphone detected! You\'re ready to continue.'
                    : 'Please speak a few words into your microphone.'}
              </p>

              {/* Live amplitude bar */}
              <div className="h-16 bg-stone-50 rounded-2xl mb-8 flex items-center justify-center border border-stone-100 overflow-hidden px-4">
                <div className="flex gap-1 items-center w-full">
                  {[...Array(20)].map((_, i) => {
                    const h = Math.max(4, Math.min(48, (micAmplitude / 255) * 48 * (1 - Math.abs(i - 10) / 12)));
                    return (
                      <div
                        key={i}
                        className={cn("flex-1 rounded-full transition-all duration-75", micStatus === 'pass' ? "bg-emerald-400" : "bg-stone-300")}
                        style={{ height: `${h}px` }}
                      />
                    );
                  })}
                </div>
              </div>

              {micStatus === 'fail' ? (
                <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-sm text-amber-800 mb-6 text-left">
                  <p className="font-medium mb-2">How to allow microphone access:</p>
                  <ol className="list-decimal pl-4 space-y-1">
                    <li>Click the lock / camera icon in your browser's address bar.</li>
                    <li>Find "Microphone" and change it to "Allow".</li>
                    <li>Reload this page.</li>
                  </ol>
                </div>
              ) : null}

              <button
                onClick={() => setStep('upload')}
                disabled={micStatus !== 'pass'}
                className="w-full bg-stone-900 text-white py-4 rounded-2xl font-medium hover:bg-stone-800 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {micStatus === 'pass' ? 'Continue' : 'Waiting for microphone signal...'}
              </button>
            </motion.div>
          )}

          {/* ── File Upload ──────────────────────────────────────────────────── */}
          {step === 'upload' && (
            <motion.div
              key="upload"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              className="max-w-xl w-full bg-white p-10 rounded-[40px] shadow-xl"
            >
              <p className="text-xs font-bold text-stone-400 uppercase tracking-widest mb-2">{assignment?.title}</p>
              <h2 className="text-2xl font-serif font-medium text-stone-900 mb-2">Upload Your Work</h2>
              <p className="text-stone-500 mb-8">Upload the file you submitted for this assignment.</p>

              <label className={cn(
                "block border-2 border-dashed rounded-3xl p-12 text-center cursor-pointer transition-colors mb-8",
                uploadedFile ? "border-emerald-400 bg-emerald-50/40" : "border-stone-200 hover:border-emerald-300 bg-stone-50"
              )}>
                <input
                  type="file"
                  accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
                  className="hidden"
                  onChange={handleFileSelect}
                />
                {uploadedFile ? (
                  <>
                    <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-3" />
                    <p className="text-stone-800 font-medium">{uploadedFile.name}</p>
                    <p className="text-xs text-stone-400 mt-1">Click to change file</p>
                  </>
                ) : (
                  <>
                    <Upload className="w-10 h-10 text-stone-300 mx-auto mb-4" />
                    <p className="text-stone-600 font-medium">Click to upload or drag and drop</p>
                    <p className="text-xs text-stone-400 mt-2">PDF, DOCX, or TXT — maximum 20MB</p>
                  </>
                )}
              </label>

              {/* Arabic language option */}
              <div className="bg-stone-50 border border-stone-100 rounded-2xl p-4 mb-8">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    id="arabic"
                    checked={arabicEnabled}
                    onChange={e => setArabicEnabled(e.target.checked)}
                    className="mt-0.5 w-5 h-5 rounded border-stone-300 text-emerald-600 cursor-pointer"
                  />
                  <div>
                    <p className="text-sm font-medium text-stone-800">Enable Arabic prompts</p>
                    <p className="text-xs text-stone-500 mt-0.5 leading-relaxed">
                      All interview questions are delivered in English. Enabling this adds an Arabic version of each question immediately after. You may answer in English, Arabic, or both.
                    </p>
                  </div>
                </label>
              </div>

              <button
                onClick={startInterview}
                disabled={!uploadedFile || uploadProgress === 'uploading' || uploadProgress === 'generating'}
                className="w-full bg-stone-900 text-white py-4 rounded-2xl font-medium hover:bg-stone-800 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {(uploadProgress === 'uploading' || uploadProgress === 'generating') && (
                  <Loader2 className="w-5 h-5 animate-spin" />
                )}
                {uploadProgress === 'uploading' ? 'Uploading…' :
                 uploadProgress === 'generating' ? 'Preparing your questions… (~30s)' :
                 'Start Interview'}
              </button>
            </motion.div>
          )}

          {/* ── Interview ────────────────────────────────────────────────────── */}
          {step === 'interview' && (() => {
            const currentQ = questions[currentQuestionIndex];
            const isMcq = currentQ?.questionType === 'mcq';
            return (
            <div className="max-w-3xl w-full bg-white rounded-[40px] shadow-2xl flex flex-col overflow-hidden border border-stone-100">
              {/* Header */}
              <div className="px-8 py-5 border-b border-stone-100 flex justify-between items-center">
                <div className="flex items-center gap-3">
                  <span className="px-3 py-1 bg-stone-100 text-stone-600 text-xs font-bold rounded-full uppercase tracking-wider">
                    Q {currentQuestionIndex + 1}/{questions.length}
                    {isBranchQuestion && ' ↩'}
                  </span>
                  {isMcq && <span className="px-3 py-1 bg-blue-50 text-blue-600 text-xs font-bold rounded-full uppercase tracking-wider">MCQ</span>}
                  <div className="flex items-center gap-1.5 text-red-500 font-mono text-sm">
                    <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                    {formatDuration(timeLeft)}
                  </div>
                </div>
                {/* Live camera preview */}
                <div className="flex items-center gap-3">
                  <div className="relative w-24 h-16 rounded-xl overflow-hidden bg-stone-900 border border-stone-200">
                    <video ref={videoCallbackRef} autoPlay muted playsInline className="w-full h-full object-cover" />
                    <div className="absolute bottom-1 right-1">
                      <Camera className="w-3 h-3 text-white opacity-60" />
                    </div>
                  </div>
                  <button onClick={() => setShowEndConfirm(true)} className="text-stone-400 hover:text-red-500 text-xs font-medium transition-colors">
                    End
                  </button>
                </div>
              </div>

              {/* Main content */}
              <div className="flex-1 flex flex-col items-center px-8 py-6 relative overflow-y-auto">
                {/* Countdown overlay */}
                {questionPhase === 'countdown' && countdown > 0 && (
                  <motion.div
                    initial={{ scale: 0.5, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className="absolute inset-0 flex items-center justify-center z-10 bg-white/90 backdrop-blur-sm rounded-b-[40px]"
                  >
                    <span className="text-9xl font-serif font-bold text-emerald-600">{countdown}</span>
                  </motion.div>
                )}

                {/* Status row */}
                <div className="flex items-center gap-3 mb-5 w-full justify-center">
                  <div className={cn(
                    "w-10 h-10 rounded-full flex items-center justify-center border transition-all duration-300",
                    questionPhase === 'recording' ? "bg-red-50 border-red-200" :
                    questionPhase === 'playing' ? "bg-emerald-50 border-emerald-200" :
                    "bg-stone-50 border-stone-200"
                  )}>
                    {questionPhase === 'recording' ? <div className="w-3 h-3 bg-red-500 rounded-sm animate-pulse" /> :
                     questionPhase === 'uploading' ? <Loader2 className="w-4 h-4 text-stone-400 animate-spin" /> :
                     <Mic className="w-4 h-4 text-stone-300" />}
                  </div>
                  <p className="text-sm font-medium text-stone-600">
                    {questionPhase === 'playing' ? 'Listening to question…' :
                     questionPhase === 'countdown' ? 'Get ready to answer…' :
                     questionPhase === 'recording' ? 'Recording — speak your answer' :
                     'Saving…'}
                  </p>
                </div>

                {/* Submission extract (open questions) */}
                {!isMcq && currentQ?.submissionExtract && questionPhase !== 'uploading' && (
                  <div className="w-full bg-amber-50 border border-amber-200 rounded-2xl p-4 mb-4 text-left">
                    <p className="text-xs font-bold text-amber-700 uppercase tracking-wide mb-1">From your submission</p>
                    <p className="text-sm text-stone-700 italic leading-relaxed">"{currentQ.submissionExtract}"</p>
                  </div>
                )}

                {/* Question text (always visible during recording) */}
                {questionPhase !== 'uploading' && currentQ && (
                  <div className="w-full bg-stone-50 border border-stone-200 rounded-2xl p-4 mb-4 text-left">
                    <p className="text-sm font-semibold text-stone-800 leading-relaxed">{currentQ.textEn}</p>
                    {arabicEnabled && <p className="text-sm text-stone-600 mt-2 leading-relaxed text-right" dir="rtl">{currentQ.textAr}</p>}
                  </div>
                )}

                {/* MCQ options */}
                {isMcq && currentQ?.options && questionPhase === 'recording' && (
                  <div className="w-full space-y-2 mb-4">
                    <p className="text-xs text-amber-600 font-semibold text-center mb-2">
                      Select your answer AND explain verbally — verbal explanation is required
                    </p>
                    {(['a', 'b', 'c', 'd'] as const).map(opt => (
                      <button
                        key={opt}
                        onClick={() => setSelectedOption(opt)}
                        className={cn(
                          "w-full text-left px-4 py-3 rounded-xl border text-sm font-medium transition-all",
                          selectedOption === opt
                            ? "bg-emerald-600 text-white border-emerald-600 shadow-md"
                            : "bg-white text-stone-700 border-stone-200 hover:border-emerald-300 hover:bg-emerald-50"
                        )}
                      >
                        <span className="font-bold uppercase mr-2">{opt}.</span>
                        {currentQ.options![opt]}
                        {arabicEnabled && currentQ.options![`${opt}Ar` as keyof typeof currentQ.options] && (
                          <span className="block text-xs mt-0.5 opacity-70 text-right" dir="rtl">
                            {currentQ.options![`${opt}Ar` as keyof typeof currentQ.options]}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}

                {/* Real-time audio level meter */}
                <div className="w-full max-w-md h-12 flex items-center justify-center gap-0.5 mt-2">
                  {[...Array(40)].map((_, i) => {
                    const center = 20;
                    const dist = Math.abs(i - center) / center;
                    const maxH = recordingAmplitude > 0
                      ? Math.max(3, (recordingAmplitude / 255) * 44 * (1 - dist * 0.5))
                      : 3;
                    return (
                      <div
                        key={i}
                        className={cn("w-1 rounded-full transition-all duration-75",
                          questionPhase === 'recording' ? "bg-emerald-500" : "bg-stone-200")}
                        style={{ height: `${questionPhase === 'recording' ? maxH : 3}px`, opacity: questionPhase === 'recording' ? 0.8 : 0.4 }}
                      />
                    );
                  })}
                </div>
              </div>

              {/* Footer */}
              <div className="px-8 py-5 bg-stone-50 border-t border-stone-100 flex justify-center">
                <button
                  disabled={questionPhase !== 'recording' || isUploading || (isMcq && !selectedOption)}
                  onClick={stopRecording}
                  className="bg-stone-900 text-white px-10 py-3.5 rounded-2xl font-medium hover:bg-stone-800 shadow-lg shadow-stone-200 disabled:opacity-30 flex items-center gap-2 text-sm"
                >
                  {isUploading && <Loader2 className="w-4 h-4 animate-spin" />}
                  {isMcq && !selectedOption && questionPhase === 'recording' ? 'Select an option first' : 'Done, Next Question'}
                </button>
              </div>

              {/* canvas is rendered at top-level above AnimatePresence */}
            </div>
            );
          })()}

          {/* ── Final Comment ─────────────────────────────────────────────────── */}
          {step === 'final-comment' && (
            <motion.div
              key="final"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="max-w-md w-full bg-white p-10 rounded-[40px] shadow-xl text-center"
            >
              <div className="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-6">
                <Mic className="w-10 h-10 text-emerald-600" />
              </div>
              <h2 className="text-2xl font-serif font-medium text-stone-900 mb-4">Any final comments?</h2>
              <p className="text-stone-500 mb-8">
                You may speak any additional comments now, or simply click End Session to finish.
                The session will close automatically after 60 seconds of silence.
              </p>
              <div className="flex items-center justify-center gap-2 mb-8 text-sm text-stone-400">
                <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                Recording
              </div>
              <button
                onClick={() => setShowEndConfirm(true)}
                className="w-full bg-stone-900 text-white py-4 rounded-2xl font-medium hover:bg-stone-800"
              >
                End Session
              </button>
            </motion.div>
          )}

          {/* ── Completion ───────────────────────────────────────────────────── */}
          {step === 'completion' && (
            <motion.div
              key="completion"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="max-w-md w-full bg-white p-10 rounded-[40px] shadow-xl text-center"
            >
              <div className="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-6">
                <CheckCircle2 className="w-10 h-10 text-emerald-600" />
              </div>
              <h2 className="text-2xl font-serif font-medium text-stone-900 mb-2">
                Thank you, {student?.name}
              </h2>
              <p className="text-stone-500 mb-8">
                Your interview for <span className="font-medium text-stone-700">{assignment?.title}</span> has been completed.
                Your educator will review the session and may follow up with you.
              </p>

              <div className="bg-stone-50 p-4 rounded-2xl mb-6 border border-stone-100">
                <p className="text-xs text-stone-400 uppercase tracking-widest font-bold mb-1">Reference Number</p>
                <p className="text-lg font-mono font-bold text-stone-700">{session?.id.substring(0, 8).toUpperCase()}</p>
                <p className="text-xs text-stone-400 mt-1">Keep this number for any follow-up queries.</p>
              </div>

              <p className="text-xs text-stone-400">
                Your recordings are retained for one year after this assignment closes.
                To request deletion of your data, contact your educator.
              </p>
            </motion.div>
          )}

        </AnimatePresence>
      </main>

      {/* ── End Session Confirmation Modal ────────────────────────────────────── */}
      {showEndConfirm && (
        <div className="fixed inset-0 bg-stone-900/60 flex items-center justify-center z-50 p-4">
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-white rounded-[32px] p-8 max-w-sm w-full shadow-2xl"
          >
            <h3 className="text-xl font-serif font-medium text-stone-900 mb-3">End your session?</h3>
            <p className="text-stone-500 text-sm mb-8 leading-relaxed">
              Are you sure you want to end your session? <strong>You will not be able to restart it.</strong>
            </p>
            <div className="flex flex-col gap-3">
              {/* Cancel is the visually primary option per requirements */}
              <button
                onClick={() => setShowEndConfirm(false)}
                className="w-full bg-stone-900 text-white py-3.5 rounded-2xl font-medium hover:bg-stone-800"
              >
                Cancel, continue interview
              </button>
              <button
                onClick={confirmEndSession}
                className="w-full bg-white text-red-600 border border-red-200 py-3.5 rounded-2xl font-medium hover:bg-red-50"
              >
                Yes, end session
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
}
