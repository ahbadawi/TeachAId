import { useState } from 'react';
import { db, storage } from '../firebase';
import { collection, addDoc, serverTimestamp, updateDoc, doc } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { Course } from '../types';
import { X, Upload, Loader2, Info, CheckCircle2 } from 'lucide-react';
import { motion } from 'motion/react';
import { extractTextFromUrl, generateAssignmentSummary } from '../lib/claude';
import { logAudit } from '../lib/audit';
import { cn } from '../lib/utils';

interface Props {
  courses: Course[];
  onClose: () => void;
  educatorId: string;
}

type QuestionMode = 'AI-Generated' | 'Manual' | 'Mixed';
type ProcessingStep = 'idle' | 'uploading' | 'generating' | 'done' | 'error';

export default function CreateAssignment({ courses, onClose, educatorId }: Props) {
  const [title, setTitle] = useState('');
  const [courseId, setCourseId] = useState(courses[0]?.id || '');
  const [briefFile, setBriefFile] = useState<File | null>(null);
  const [rubricFile, setRubricFile] = useState<File | null>(null);
  const [questionCount, setQuestionCount] = useState(12);
  const [questionMode, setQuestionMode] = useState<QuestionMode>('AI-Generated');
  const [captureMode, setCaptureMode] = useState<'Snapshot' | 'Video'>('Snapshot');
  const [windowOpen, setWindowOpen] = useState(() => new Date().toISOString().slice(0, 16));
  const [windowClose, setWindowClose] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 16);
  });
  const [processingStep, setProcessingStep] = useState<ProcessingStep>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!briefFile || !courseId || !title) return;
    if (new Date(windowClose) <= new Date(windowOpen)) {
      setErrorMessage('Interview close date must be after the open date.');
      return;
    }

    setProcessingStep('uploading');
    setErrorMessage('');

    try {
      // Upload files to Firebase Storage
      const briefStorageRef = ref(storage, `assignments/briefs/${Date.now()}_${briefFile.name}`);
      const briefSnap = await uploadBytes(briefStorageRef, briefFile);
      const briefUrl = await getDownloadURL(briefSnap.ref);

      let rubricUrl: string | undefined;
      if (rubricFile) {
        const rubricStorageRef = ref(storage, `assignments/rubrics/${Date.now()}_${rubricFile.name}`);
        const rubricSnap = await uploadBytes(rubricStorageRef, rubricFile);
        rubricUrl = await getDownloadURL(rubricSnap.ref);
      }

      // Create assignment document
      const assignmentRef = await addDoc(collection(db, 'assignments'), {
        title,
        courseId,
        educatorId,
        briefFileUrl: briefUrl,
        ...(rubricUrl ? { rubricFileUrl: rubricUrl } : {}),
        questionCount,
        questionMode,
        captureMode,
        windowOpen: new Date(windowOpen).toISOString(),
        windowClose: new Date(windowClose).toISOString(),
        responseTimeLimit: 60,
        status: 'Processing',
        createdAt: serverTimestamp(),
      });

      // Generate summary + questions by extracting real text from uploaded files
      if (questionMode === 'AI-Generated' || questionMode === 'Mixed') {
        setProcessingStep('generating');
        try {
          // Extract text from the already-uploaded Firebase Storage files.
          // extractTextFromUrl downloads the file in the browser (the token in the URL
          // grants access) and sends bytes to the server for Gemini/mammoth processing.
          // This replaces the old stub that returned "[File: x.pdf — placeholder]".
          const [briefText, rubricText] = await Promise.all([
            extractTextFromUrl(briefUrl),
            rubricUrl ? extractTextFromUrl(rubricUrl) : Promise.resolve(''),
          ]);

          const { summaryText, questions: generatedQuestions, rubricText: effectiveRubric } =
            await generateAssignmentSummary(briefText, rubricText, questionCount);

          // Save questions to subcollection
          const questionsCol = collection(db, 'assignments', assignmentRef.id, 'questions');
          for (let i = 0; i < generatedQuestions.length; i++) {
            await addDoc(questionsCol, {
              textEn: generatedQuestions[i].textEn,
              textAr: generatedQuestions[i].textAr,
              followUpEn: generatedQuestions[i].followUpEn || null,
              followUpAr: generatedQuestions[i].followUpAr || null,
              order: i,
            });
          }

          // Persist summary, effective rubric text, and mark ready.
          // rubricText is stored so processSession can cross-reference answers against it
          // without needing to re-download and re-parse the rubric file.
          await updateDoc(doc(db, 'assignments', assignmentRef.id), {
            status: 'Active',
            summaryText,
            rubricText: effectiveRubric,
            summaryGeneratedAt: serverTimestamp(),
          });
        } catch (genErr: any) {
          console.error('Summary/question generation failed:', genErr);
          // Mark active even without questions so the assignment is usable
          await updateDoc(doc(db, 'assignments', assignmentRef.id), { status: 'Active' });
          const rawMsg: string = genErr?.message || 'unknown error';
          // Distinguish the three failure modes:
          // 1. "Failed to fetch" (exact browser TypeError) → Express server not running
          // 2. "429" in the Gemini error detail → API quota exhausted
          // 3. Anything else → surface the server error directly
          const serverDown = rawMsg === 'Failed to fetch' || rawMsg === 'NetworkError when attempting to fetch resource';
          const quotaExceeded = rawMsg.includes('429') || rawMsg.toLowerCase().includes('quota') || rawMsg.toLowerCase().includes('rate limit');
          setErrorMessage(
            serverDown
              ? 'Assignment created, but the API server is not running. ' +
                'Run "npm start" (starts both Vite and the Express server together), then open the assignment to generate questions.'
              : quotaExceeded
              ? 'Assignment created, but the AI question generation hit a quota limit (Gemini 429). ' +
                'Wait a minute and then open the assignment to retry, or check your Google AI Studio quota at ai.google.dev.'
              : `Assignment created, but AI question generation failed: ${rawMsg}. ` +
                'Open the assignment and click "Generate" to retry.'
          );
          setProcessingStep('error');
          return;
        }
      } else {
        // Manual mode — just mark active, no questions generated
        await updateDoc(doc(db, 'assignments', assignmentRef.id), { status: 'Active' });
      }

      await logAudit('Assignment Created', `Assignment "${title}" created`, educatorId);
      setProcessingStep('done');

      setTimeout(() => onClose(), 1500);
    } catch (err) {
      console.error(err);
      setErrorMessage('Failed to create assignment. Please try again.');
      setProcessingStep('error');
    }
  };

  const isProcessing = processingStep === 'uploading' || processingStep === 'generating';

  return (
    <div className="fixed inset-0 bg-stone-900/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-white w-full max-w-2xl rounded-[32px] shadow-2xl overflow-hidden"
      >
        <div className="p-6 border-b border-stone-100 flex justify-between items-center">
          <h2 className="text-xl font-serif font-medium text-stone-900">New Assignment</h2>
          <button onClick={onClose} className="p-2 hover:bg-stone-100 rounded-full transition-colors">
            <X className="w-5 h-5 text-stone-400" />
          </button>
        </div>

        {processingStep === 'done' ? (
          <div className="p-12 text-center">
            <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto mb-4" />
            <h3 className="text-xl font-medium text-stone-900 mb-2">Assignment Created</h3>
            <p className="text-stone-500">Questions generated and ready.</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-8 space-y-6 overflow-y-auto max-h-[80vh]">
            {/* Title */}
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">Assignment Title *</label>
              <input
                required type="text" value={title} onChange={e => setTitle(e.target.value)}
                placeholder="e.g. Mid-term Research Paper Verification"
                className="w-full px-4 py-3 bg-stone-50 border border-stone-200 rounded-2xl text-sm focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
              />
            </div>

            {/* Course */}
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">Course *</label>
              <select required value={courseId} onChange={e => setCourseId(e.target.value)}
                className="w-full px-4 py-3 bg-stone-50 border border-stone-200 rounded-2xl text-sm focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500">
                {courses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>

            {/* Files */}
            <div className="grid grid-cols-2 gap-4">
              <FileUploadZone label="Assignment Brief *" file={briefFile} onFileSelect={setBriefFile} description="Task instructions for students" />
              <FileUploadZone label="Grading Rubric (optional)" file={rubricFile} onFileSelect={setRubricFile} description="If omitted, AI generates one" />
            </div>

            {/* Interview window */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1">Interview Opens</label>
                <input type="datetime-local" value={windowOpen} onChange={e => setWindowOpen(e.target.value)}
                  className="w-full px-4 py-3 bg-stone-50 border border-stone-200 rounded-2xl text-sm focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1">Interview Closes</label>
                <input type="datetime-local" value={windowClose} onChange={e => setWindowClose(e.target.value)}
                  className="w-full px-4 py-3 bg-stone-50 border border-stone-200 rounded-2xl text-sm focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
              </div>
            </div>

            {/* Question mode */}
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-2">Question Mode</label>
              <div className="grid grid-cols-3 gap-2">
                {(['AI-Generated', 'Manual', 'Mixed'] as QuestionMode[]).map(mode => (
                  <button key={mode} type="button" onClick={() => setQuestionMode(mode)}
                    className={cn("py-2.5 px-3 rounded-xl border text-xs font-medium transition-all",
                      questionMode === mode ? "bg-emerald-600 text-white border-emerald-600" : "bg-stone-50 text-stone-600 border-stone-200 hover:border-stone-300")}>
                    {mode}
                  </button>
                ))}
              </div>
              <p className="text-xs text-stone-400 mt-2">
                {questionMode === 'AI-Generated' && 'Questions generated from each student\'s submission and the rubric.'}
                {questionMode === 'Manual' && 'You write the questions. Same questions asked to all students.'}
                {questionMode === 'Mixed' && 'Fixed questions asked to all students, plus AI-generated per-student questions.'}
              </p>
            </div>

            {/* Question count */}
            <div className="grid grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1">
                  Number of Questions: <span className="text-emerald-600 font-bold">{questionCount}</span>
                </label>
                <input type="range" min="8" max="16" value={questionCount} onChange={e => setQuestionCount(parseInt(e.target.value))}
                  className="w-full accent-emerald-600" />
                <div className="flex justify-between text-xs text-stone-400 mt-1"><span>8</span><span>16</span></div>
              </div>

              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1">Capture Mode</label>
                <div className="flex bg-stone-100 p-1 rounded-xl">
                  {(['Snapshot', 'Video'] as const).map(mode => (
                    <button key={mode} type="button" onClick={() => setCaptureMode(mode)}
                      className={cn("flex-1 py-1.5 text-xs font-medium rounded-lg transition-all",
                        captureMode === mode ? "bg-white text-stone-900 shadow-sm" : "text-stone-500")}>
                      {mode}
                    </button>
                  ))}
                </div>
                {captureMode === 'Video' && <p className="text-xs text-amber-600 mt-1">Video records continuously during each response.</p>}
              </div>
            </div>

            {processingStep !== 'idle' && processingStep !== 'error' && (
              <div className="bg-emerald-50 p-4 rounded-2xl flex gap-3 items-center">
                <Loader2 className="w-5 h-5 text-emerald-600 animate-spin shrink-0" />
                <div>
                  <p className="text-sm font-medium text-emerald-800">
                    {processingStep === 'uploading' && 'Uploading files…'}
                    {processingStep === 'generating' && 'Generating interview questions…'}
                  </p>
                  <p className="text-xs text-emerald-600 mt-0.5">This may take up to 30 seconds.</p>
                </div>
              </div>
            )}

            {processingStep === 'idle' && (
              <div className="bg-stone-50 p-4 rounded-2xl flex gap-3">
                <Info className="w-5 h-5 text-stone-400 shrink-0" />
                <p className="text-xs text-stone-600 leading-relaxed">
                  TeachAId will generate {questionCount} interview questions from the brief{rubricFile ? ' and rubric' : ' — a rubric will be auto-generated if none is uploaded'}. Students upload their own work during the interview.
                </p>
              </div>
            )}

            {errorMessage && <p className="text-sm text-red-600">{errorMessage}</p>}

            <button
              disabled={isProcessing || !briefFile || !title}
              className="w-full bg-stone-900 text-white py-4 rounded-2xl font-medium hover:bg-stone-800 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isProcessing && <Loader2 className="w-5 h-5 animate-spin" />}
              Create Assignment
            </button>
          </form>
        )}
      </motion.div>
    </div>
  );
}

function FileUploadZone({ label, file, onFileSelect, description }: { label: string; file: File | null; onFileSelect: (f: File) => void; description: string }) {
  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-stone-700">{label}</label>
      <label className={cn("block border-2 border-dashed rounded-2xl p-6 text-center transition-all cursor-pointer",
        file ? "border-emerald-500 bg-emerald-50/30" : "border-stone-200 hover:border-stone-300 bg-stone-50")}>
        <input type="file" accept=".pdf,.docx,.txt" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) onFileSelect(f); }} />
        <Upload className={cn("w-6 h-6 mx-auto mb-2", file ? "text-emerald-500" : "text-stone-300")} />
        <p className="text-xs font-medium text-stone-600 truncate px-2">{file ? file.name : 'Select File'}</p>
        <p className="text-[10px] text-stone-400 mt-1">{description}</p>
      </label>
    </div>
  );
}
