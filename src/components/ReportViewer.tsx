import { useState, useEffect } from 'react';
import { db, storage } from '../firebase';
import { doc, getDoc, collection, getDocs, addDoc, updateDoc, query, where, orderBy, serverTimestamp } from 'firebase/firestore';
import { ref, getDownloadURL } from 'firebase/storage';
import {
  InterviewSession, Student, Assignment, AnalysisReport, Flag,
  ResponseChunk, Snapshot, EducatorDecision,
} from '../types';
import {
  Loader2, Play, Pause, SkipForward, SkipBack, AlertTriangle,
  CheckCircle, Info, FileText, Camera, ChevronLeft, ChevronRight, Cpu,
} from 'lucide-react';
import { cn, formatDuration } from '../lib/utils';

interface Props {
  sessionId: string;
  onClose: () => void;
  onPrevStudent?: () => void;
  onNextStudent?: () => void;
  educatorId: string;
}

export default function ReportViewer({ sessionId, onClose, onPrevStudent, onNextStudent, educatorId }: Props) {
  const [session, setSession] = useState<InterviewSession | null>(null);
  const [student, setStudent] = useState<Student | null>(null);
  const [assignment, setAssignment] = useState<Assignment | null>(null);
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [flags, setFlags] = useState<Flag[]>([]);
  const [chunks, setChunks] = useState<ResponseChunk[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [existingDecision, setExistingDecision] = useState<EducatorDecision | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentChunkIndex, setCurrentChunkIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  const [decision, setDecision] = useState<'Accept' | 'Schedule Follow-up' | 'Escalate for Review' | null>(null);
  const [decisionNote, setDecisionNote] = useState('');
  const [submittingDecision, setSubmittingDecision] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [processError, setProcessError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const sessionDoc = await getDoc(doc(db, 'interviewSessions', sessionId));
        if (!sessionDoc.exists()) return;
        const sessionData = { id: sessionDoc.id, ...sessionDoc.data() } as InterviewSession;
        setSession(sessionData);

        const [studentDoc, assignmentDoc] = await Promise.all([
          getDoc(doc(db, 'students', sessionData.studentId)),
          getDoc(doc(db, 'assignments', sessionData.assignmentId)),
        ]);
        if (studentDoc.exists()) setStudent({ id: studentDoc.id, ...studentDoc.data() } as Student);
        if (assignmentDoc.exists()) setAssignment({ id: assignmentDoc.id, ...assignmentDoc.data() } as Assignment);

        const chunksSnap = await getDocs(collection(db, 'interviewSessions', sessionId, 'responseChunks'));
        setChunks(chunksSnap.docs.map(d => ({ id: d.id, ...d.data() } as ResponseChunk)).sort((a, b) => a.questionIndex - b.questionIndex));

        const snapshotsSnap = await getDocs(collection(db, 'interviewSessions', sessionId, 'snapshots'));
        setSnapshots(snapshotsSnap.docs.map(d => ({ id: d.id, ...d.data() } as Snapshot)).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()));

        const reportQuery = query(collection(db, 'analysisReports'), where('sessionId', '==', sessionId));
        const reportSnap = await getDocs(reportQuery);
        if (!reportSnap.empty) {
          const reportData = { id: reportSnap.docs[0].id, ...reportSnap.docs[0].data() } as AnalysisReport;
          setReport(reportData);
          const flagsSnap = await getDocs(collection(db, 'analysisReports', reportData.id, 'flags'));
          setFlags(flagsSnap.docs.map(d => ({ id: d.id, ...d.data() } as Flag)).sort((a, b) => b.severity - a.severity));
        }

        const decisionQuery = query(collection(db, 'educatorDecisions'), where('sessionId', '==', sessionId));
        const decisionSnap = await getDocs(decisionQuery);
        if (!decisionSnap.empty) {
          setExistingDecision({ id: decisionSnap.docs[0].id, ...decisionSnap.docs[0].data() } as EducatorDecision);
        }

        setLoading(false);
      } catch (err) {
        console.error(err);
        setLoading(false);
      }
    };
    fetchData();
  }, [sessionId]);

  useEffect(() => {
    if (!chunks[currentChunkIndex]) return;
    const fetchAudio = async () => {
      try {
        const chunk = chunks[currentChunkIndex];
        // Branch recordings use _branch suffix; main recordings do not
        const filename = `q${chunk.questionIndex}${chunk.isBranch ? '_branch' : ''}.webm`;
        const url = await getDownloadURL(ref(storage, `sessions/${sessionId}/${filename}`));
        setAudioUrl(url);
      } catch { setAudioUrl(null); }
    };
    fetchAudio();
  }, [currentChunkIndex, chunks, sessionId]);

  const handleSubmitDecision = async () => {
    if (!decision || !session || !report) return;
    setSubmittingDecision(true);
    setDecisionError(null);
    try {
      const decisionDoc = await addDoc(collection(db, 'educatorDecisions'), {
        sessionId,
        reportId: report.id,
        educatorId,
        decision,
        note: decisionNote.trim() || null,
        decidedAt: serverTimestamp(),
      });
      // Mark the session as REVIEWED so it leaves the AWAITING_REVIEW queue
      await updateDoc(doc(db, 'interviewSessions', sessionId), { status: 'REVIEWED' });
      setSession(prev => prev ? { ...prev, status: 'REVIEWED' } : prev);
      setExistingDecision({
        id: decisionDoc.id,
        sessionId,
        reportId: report.id,
        educatorId,
        decision,
        note: decisionNote.trim() || undefined,
        decidedAt: new Date().toISOString(),
      });
    } catch {
      setDecisionError('Failed to submit decision. Please try again.');
    } finally {
      setSubmittingDecision(false);
    }
  };

  const processSession = async () => {
    if (!session || !assignment) return;
    setProcessing(true);
    setProcessError(null);
    try {
      // Build audio URLs from Firebase Storage
      const audioUrls: { questionIndex: number; url: string }[] = [];
      for (const chunk of chunks) {
        try {
          const path = `sessions/${sessionId}/q${chunk.questionIndex}${chunk.isBranch ? '_branch' : ''}.webm`;
          const url = await getDownloadURL(ref(storage, path));
          audioUrls.push({ questionIndex: chunk.questionIndex, url });
        } catch { /* chunk may not have audio */ }
      }

      // Load all 6 questions with correct response indices:
      //   Open questions (per-student) → indices 0–2, stored on session.openQuestions
      //   MCQ questions (assignment-level) → indices 3–5, stored on assignment.questions
      // The open questions are stored on the session doc (set during startInterview()).
      // MCQ questions in the assignment doc have order 0–2 but were presented at index 3–5.
      let questions: { index: number; textEn: string }[] = [];
      const openQs = (session.openQuestions || [])
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map(q => ({ index: q.order ?? 0, textEn: q.textEn || '' }));

      const inlineQs = assignment.questions || [];
      const mcqQs = inlineQs.length > 0
        ? [...inlineQs]
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
            .map((q, i) => ({ index: 3 + i, textEn: q.textEn || '' }))
        : await getDocs(query(collection(db, 'assignments', assignment.id, 'questions'), orderBy('order')))
            .then(snap => snap.docs.map((d, i) => ({ index: 3 + i, textEn: (d.data().textEn as string) || '' })));

      questions = [...openQs, ...mcqQs];

      // Use stored rubric text if available; fall back to empty string (server will
      // regenerate a rubric from the brief if needed via ensureRubric())
      const rubricText = assignment.rubricText || '';

      // Retrieve student submission text from the session's submission chunk (if any)
      let submissionText = '';
      const submissionChunkSnap = await getDocs(
        query(collection(db, 'interviewSessions', sessionId, 'responseChunks'), where('isSubmission', '==', true))
      );
      if (!submissionChunkSnap.empty) {
        submissionText = (submissionChunkSnap.docs[0].data().transcriptText as string) || '';
      }

      const res = await fetch('/api/transcribe-and-analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questions, audioUrls, submissionText, rubricText }),
      });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const { transcripts, analysis } = await res.json() as {
        transcripts: { questionIndex: number; questionText: string; responseText: string }[];
        analysis: { comprehensionLevel: string; recommendedAction: string; summary: string; flags: any[] };
      };

      // Write transcripts back to each responseChunk document
      const chunksSnap = await getDocs(collection(db, 'interviewSessions', sessionId, 'responseChunks'));
      for (const chunkDoc of chunksSnap.docs) {
        const data = chunkDoc.data();
        const t = transcripts.find(t => t.questionIndex === data.questionIndex);
        if (t) {
          await updateDoc(chunkDoc.ref, { transcriptText: t.responseText });
        }
      }

      // Create or update analysis report
      const reportRef = await addDoc(collection(db, 'analysisReports'), {
        sessionId,
        comprehensionLevel: analysis.comprehensionLevel,
        recommendedAction: analysis.recommendedAction,
        summary: analysis.summary,
        processedAt: serverTimestamp(),
      });

      // Write flags
      for (const flag of (analysis.flags || [])) {
        await addDoc(collection(db, 'analysisReports', reportRef.id, 'flags'), flag);
      }

      // Update session status
      await updateDoc(doc(db, 'interviewSessions', sessionId), {
        status: 'AWAITING_REVIEW',
        processedAt: serverTimestamp(),
      });

      // Reload data
      const newReport = { id: reportRef.id, sessionId, ...analysis } as AnalysisReport;
      setReport(newReport);
      const newFlagsSnap = await getDocs(collection(db, 'analysisReports', reportRef.id, 'flags'));
      setFlags(newFlagsSnap.docs.map(d => ({ id: d.id, ...d.data() } as Flag)).sort((a, b) => b.severity - a.severity));

      // Refresh chunks with transcript text
      const updatedChunksSnap = await getDocs(collection(db, 'interviewSessions', sessionId, 'responseChunks'));
      setChunks(updatedChunksSnap.docs.map(d => ({ id: d.id, ...d.data() } as ResponseChunk)).sort((a, b) => a.questionIndex - b.questionIndex));
    } catch (err: any) {
      console.error('processSession error:', err);
      setProcessError(err?.message || 'Processing failed. Please try again.');
    } finally {
      setProcessing(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 animate-spin text-emerald-600" />
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex justify-between items-start">
        <div>
          <h2 className="text-3xl font-serif font-medium text-stone-900 mb-1">{student?.name}'s Report</h2>
          <p className="text-stone-500 text-sm">{assignment?.title} &bull; Completed {session?.completedAt ? new Date(session.completedAt).toLocaleString() : 'N/A'}</p>
        </div>
        <div className="flex items-center gap-2">
          {onPrevStudent && <button onClick={onPrevStudent} className="p-2 hover:bg-stone-100 rounded-xl"><ChevronLeft className="w-5 h-5 text-stone-400" /></button>}
          {onNextStudent && <button onClick={onNextStudent} className="p-2 hover:bg-stone-100 rounded-xl"><ChevronRight className="w-5 h-5 text-stone-400" /></button>}
          <div className={cn("px-6 py-3 rounded-2xl border flex flex-col items-center min-w-[130px]",
            report?.comprehensionLevel === 'High' ? "bg-emerald-50 border-emerald-100 text-emerald-700" :
            report?.comprehensionLevel === 'Medium' ? "bg-amber-50 border-amber-100 text-amber-700" :
            report?.comprehensionLevel === 'Low' ? "bg-red-50 border-red-100 text-red-700" :
            "bg-stone-50 border-stone-100 text-stone-500"
          )}>
            <span className="text-[10px] font-bold uppercase tracking-widest opacity-60 mb-1">Comprehension</span>
            <span className="text-xl font-serif font-bold">{report?.comprehensionLevel || 'Pending'}</span>
          </div>
        </div>
      </div>

      {session?.status === 'AWAITING_PROCESSING' && !report && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5 flex items-center gap-4">
          <Cpu className="w-6 h-6 text-amber-500 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-amber-800">Session ready for processing</p>
            <p className="text-xs text-amber-600 mt-0.5">
              Audio responses are stored. Click Process to run AI transcription and comprehension analysis.
            </p>
            {processError && <p className="text-xs text-red-600 mt-1">{processError}</p>}
          </div>
          <button
            onClick={processSession}
            disabled={processing}
            className="shrink-0 bg-amber-600 text-white px-5 py-2.5 rounded-xl text-sm font-semibold hover:bg-amber-500 disabled:opacity-50 flex items-center gap-2"
          >
            {processing ? <><Loader2 className="w-4 h-4 animate-spin" /> Processing…</> : 'Process Session'}
          </button>
        </div>
      )}

      {report?.recommendedAction && (
        <div className="bg-blue-50 border border-blue-100 rounded-2xl p-4 flex gap-3">
          <Info className="w-5 h-5 text-blue-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-bold text-blue-400 uppercase tracking-widest mb-1">Suggested Action (not a decision)</p>
            <p className="text-sm text-blue-800 font-medium">{report.recommendedAction}</p>
          </div>
        </div>
      )}

      {report?.summary && (
        <div className="bg-stone-50 border border-stone-100 rounded-2xl p-4">
          <p className="text-xs font-bold text-stone-400 uppercase tracking-widest mb-2">Summary</p>
          <p className="text-sm text-stone-700 leading-relaxed">{report.summary}</p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-8">
          <div className="bg-stone-900 rounded-[32px] p-8 text-white shadow-xl">
            <div className="flex items-center justify-between mb-6">
              <span className="text-xs font-bold uppercase tracking-widest text-stone-400">
                Response {currentChunkIndex + 1} of {chunks.length}{chunks[currentChunkIndex] ? ` — Q${chunks[currentChunkIndex].questionIndex + 1}` : ''}
              </span>
              <div className="flex gap-3">
                <button onClick={() => setCurrentChunkIndex(i => Math.max(0, i - 1))} disabled={currentChunkIndex === 0} className="text-stone-400 hover:text-white disabled:opacity-30"><SkipBack className="w-5 h-5" /></button>
                <button onClick={() => setIsPlaying(p => !p)} disabled={!audioUrl} className="w-12 h-12 bg-emerald-500 rounded-full flex items-center justify-center hover:bg-emerald-400 disabled:opacity-30">
                  {isPlaying ? <Pause className="w-6 h-6 fill-current" /> : <Play className="w-6 h-6 fill-current ml-1" />}
                </button>
                <button onClick={() => setCurrentChunkIndex(i => Math.min(chunks.length - 1, i + 1))} disabled={currentChunkIndex >= chunks.length - 1} className="text-stone-400 hover:text-white disabled:opacity-30"><SkipForward className="w-5 h-5" /></button>
              </div>
            </div>
            <div className="h-20 bg-stone-800/50 rounded-2xl mb-4 flex items-center justify-center overflow-hidden">
              <div className="flex gap-1 items-center h-full">
                {[...Array(60)].map((_, i) => (
                  <div key={i} className="w-1 bg-emerald-500/40 rounded-full" style={{ height: `${Math.random() * 60 + 10}%` }} />
                ))}
              </div>
            </div>
            {chunks[currentChunkIndex] && <p className="text-xs text-stone-500 text-center">Duration: {formatDuration(chunks[currentChunkIndex].duration)}</p>}
            {audioUrl && isPlaying && <audio src={audioUrl} autoPlay onEnded={() => setIsPlaying(false)} className="hidden" />}
          </div>

          <section>
            <h3 className="text-lg font-medium text-stone-900 mb-4 flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-500" />
              Observations ({flags.length})
            </h3>
            {flags.length === 0 && (
              <div className="bg-white rounded-3xl border border-stone-100 p-8 text-center text-stone-400 text-sm">
                {report ? 'No flags raised for this session.' : 'Analysis not yet complete.'}
              </div>
            )}
            <div className="space-y-4">
              {flags.map(flag => (
                <div key={flag.id} className="bg-white p-6 rounded-3xl border border-stone-200 flex gap-4 hover:shadow-md transition-shadow cursor-pointer"
                  onClick={() => { const ci = chunks.findIndex(c => c.questionIndex === flag.questionIndex); if (ci >= 0) { setCurrentChunkIndex(ci); setIsPlaying(true); } }}>
                  <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center shrink-0",
                    flag.classification === 'Hard Evidence' ? "bg-red-100 text-red-600" :
                    flag.classification === 'Soft Signal' ? "bg-amber-100 text-amber-600" : "bg-blue-100 text-blue-600")}>
                    {flag.classification === 'Hard Evidence' ? <AlertTriangle className="w-5 h-5" /> : flag.classification === 'Soft Signal' ? <Info className="w-5 h-5" /> : <CheckCircle className="w-5 h-5" />}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-bold uppercase tracking-wider text-stone-400">{flag.classification}</span>
                      <span className="text-stone-300">&bull;</span>
                      <span className="text-xs text-stone-500">Q{flag.questionIndex + 1}</span>
                      <span className="text-stone-300">&bull;</span>
                      <span className="text-xs text-stone-400">Severity {flag.severity}/5</span>
                    </div>
                    <p className="text-stone-800 leading-relaxed text-sm">{flag.description}</p>
                    <button className="mt-2 text-xs font-bold text-emerald-600 hover:underline">Jump to Recording</button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        <div className="space-y-8">
          {assignment?.captureMode === 'Snapshot' && snapshots.length > 0 && (
            <section>
              <h3 className="text-lg font-medium text-stone-900 mb-4 flex items-center gap-2"><Camera className="w-5 h-5 text-stone-400" /> Snapshots</h3>
              <div className="grid grid-cols-3 gap-2">
                {snapshots.map(snap => <SnapshotThumbnail key={snap.id} snapshot={snap} sessionId={sessionId} />)}
              </div>
            </section>
          )}

          <section>
            <h3 className="text-lg font-medium text-stone-900 mb-4 flex items-center gap-2"><FileText className="w-5 h-5 text-stone-400" /> Transcript</h3>
            <div className="bg-white rounded-3xl border border-stone-200 p-6 max-h-[340px] overflow-y-auto space-y-5">
              {chunks.length === 0 ? <p className="text-sm text-stone-400 text-center">No responses yet.</p> : chunks.map(chunk => (
                <div key={chunk.id} className="cursor-pointer hover:bg-stone-50 -mx-2 px-2 py-1 rounded-xl transition-colors"
                  onClick={() => { const ci = chunks.indexOf(chunk); setCurrentChunkIndex(ci); setIsPlaying(true); }}>
                  <div className="flex items-center gap-2 mb-1">
                    <p className="text-[10px] font-bold text-stone-400 uppercase tracking-widest">
                      Q{chunk.questionIndex + 1}{chunk.isBranch ? ' (follow-up)' : ''}{' '}
                      <span className={cn("ml-1", chunk.questionIndex < 3 ? "text-amber-500" : "text-blue-400")}>
                        {chunk.questionIndex < 3 ? 'Open' : 'MCQ'}
                      </span>
                    </p>
                    <span className="text-stone-200">·</span>
                    <p className="text-[10px] text-stone-400">{formatDuration(chunk.duration)}</p>
                    {chunk.transcriptLanguage && (
                      <span className="text-[10px] text-stone-300 uppercase">{chunk.transcriptLanguage}</span>
                    )}
                  </div>
                  {chunk.selectedOption && (
                    <p className="text-xs font-bold text-blue-600 mb-1">
                      Selected: Option {chunk.selectedOption.toUpperCase()}
                    </p>
                  )}
                  {chunk.transcriptText
                    ? <p className="text-sm text-stone-700 leading-relaxed">{chunk.transcriptText}</p>
                    : <p className="text-xs text-stone-400 italic">Audio recorded — process session to transcribe</p>
                  }
                </div>
              ))}
            </div>
          </section>

          <section>
            <h3 className="text-lg font-medium text-stone-900 mb-4">Your Decision</h3>
            {existingDecision ? (
              <div className="bg-stone-50 border border-stone-100 rounded-3xl p-6">
                <p className="text-xs font-bold text-stone-400 uppercase tracking-widest mb-2">Decision Submitted</p>
                <p className={cn("text-lg font-semibold mb-2",
                  existingDecision.decision === 'Accept' ? "text-emerald-700" :
                  existingDecision.decision === 'Schedule Follow-up' ? "text-amber-700" : "text-red-700")}>
                  {existingDecision.decision}
                </p>
                {existingDecision.note && <p className="text-sm text-stone-600 italic mb-3">"{existingDecision.note}"</p>}
                <p className="text-xs text-stone-400">Submitted {new Date(existingDecision.decidedAt).toLocaleString()}</p>
              </div>
            ) : (
              <div className="bg-white border border-stone-200 rounded-3xl p-6 space-y-4">
                <div className="space-y-2">
                  {(['Accept', 'Schedule Follow-up', 'Escalate for Review'] as const).map(opt => (
                    <label key={opt} className={cn("flex items-center gap-3 p-3 rounded-2xl border cursor-pointer transition-all",
                      decision === opt
                        ? opt === 'Accept' ? "bg-emerald-50 border-emerald-300" :
                          opt === 'Schedule Follow-up' ? "bg-amber-50 border-amber-300" : "bg-red-50 border-red-300"
                        : "border-stone-200 hover:border-stone-300")}>
                      <input type="radio" name="decision" value={opt} checked={decision === opt} onChange={() => setDecision(opt)} className="text-emerald-600" />
                      <span className="text-sm font-medium text-stone-800">{opt}</span>
                    </label>
                  ))}
                </div>
                <textarea
                  placeholder="Optional note..."
                  value={decisionNote}
                  onChange={e => setDecisionNote(e.target.value)}
                  rows={3}
                  className="w-full px-4 py-3 bg-stone-50 border border-stone-200 rounded-2xl text-sm resize-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                />
                {decisionError && <p className="text-xs text-red-600">{decisionError}</p>}
                <button
                  disabled={!decision || submittingDecision}
                  onClick={handleSubmitDecision}
                  className="w-full bg-stone-900 text-white py-3.5 rounded-2xl font-medium hover:bg-stone-800 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {submittingDecision && <Loader2 className="w-4 h-4 animate-spin" />}
                  Submit Decision
                </button>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function SnapshotThumbnail({ snapshot, sessionId }: { snapshot: Snapshot; sessionId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    // Prefer the explicit storagePath stored at upload time (new snapshots).
    // Fall back to timestamp reconstruction for legacy snapshots that pre-date this field.
    const path = snapshot.storagePath
      ? snapshot.storagePath
      : `sessions/${sessionId}/snap_${new Date(snapshot.timestamp).getTime()}.jpg`;
    getDownloadURL(ref(storage, path)).then(setUrl).catch(() => {});
  }, [snapshot, sessionId]);

  return (
    <>
      <div className="aspect-video bg-stone-100 rounded-xl overflow-hidden border border-stone-200 cursor-pointer hover:opacity-80 transition-opacity" onClick={() => url && setExpanded(true)}>
        {url ? <img src={url} alt="Snapshot" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : <div className="w-full h-full flex items-center justify-center"><Camera className="w-4 h-4 text-stone-300" /></div>}
      </div>
      {expanded && url && (
        <div className="fixed inset-0 bg-stone-900/80 flex items-center justify-center z-50 p-8" onClick={() => setExpanded(false)}>
          <img src={url} alt="Snapshot" className="max-w-2xl w-full rounded-2xl shadow-2xl" referrerPolicy="no-referrer" />
        </div>
      )}
    </>
  );
}
