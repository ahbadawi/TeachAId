import { useState, useEffect } from 'react';
import { db, storage } from '../firebase';
import {
  collection, onSnapshot, updateDoc, doc, addDoc,
  serverTimestamp, getDocs, deleteDoc,
} from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { Assignment, Course, Question } from '../types';
import {
  ArrowLeft, Edit3, Save, X, Upload, RefreshCw,
  Loader2, FileText, Users,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { extractTextFromUrl, generateAssignmentSummary } from '../lib/claude';
import StudentList from './StudentList';

interface Props {
  assignment: Assignment;
  courses: Course[];
  onBack: () => void;
  onAssignmentUpdated: (a: Assignment) => void;
}

export default function AssignmentDetail({ assignment, courses, onBack, onAssignmentUpdated }: Props) {
  const [tab, setTab] = useState<'students' | 'questions'>('students');
  const [editing, setEditing] = useState(false);

  // Editable fields
  const [title, setTitle] = useState(assignment.title);
  const [windowOpen, setWindowOpen] = useState(assignment.windowOpen.slice(0, 16));
  const [windowClose, setWindowClose] = useState(assignment.windowClose.slice(0, 16));
  const [questionCount, setQuestionCount] = useState(assignment.questionCount);
  const [saving, setSaving] = useState(false);

  // File re-upload
  const [uploadingBrief, setUploadingBrief] = useState(false);
  const [uploadingRubric, setUploadingRubric] = useState(false);

  // AI summary
  const [summary, setSummary] = useState(assignment.summaryText || '');
  const [generatingSummary, setGeneratingSummary] = useState(false);
  const [summaryStep, setSummaryStep] = useState('');
  const [summaryError, setSummaryError] = useState('');

  // Questions subcollection
  const [questions, setQuestions] = useState<(Question & { id: string })[]>([]);
  const [loadingQuestions, setLoadingQuestions] = useState(true);

  // Live assignment state (updated on Firestore changes)
  const [liveAssignment, setLiveAssignment] = useState(assignment);

  const course = courses.find(c => c.id === liveAssignment.courseId);

  // Sync from parent when prop changes
  useEffect(() => {
    setLiveAssignment(assignment);
    setSummary(assignment.summaryText || '');
    setTitle(assignment.title);
    setWindowOpen(assignment.windowOpen.slice(0, 16));
    setWindowClose(assignment.windowClose.slice(0, 16));
    setQuestionCount(assignment.questionCount);
  }, [assignment.id]);

  // Load questions — prefer inline array on assignment doc (no subcollection needed)
  useEffect(() => {
    const inlineQs: Question[] = liveAssignment.questions || [];
    if (inlineQs.length > 0) {
      const sorted = [...inlineQs].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      setQuestions(sorted.map((q, i) => ({ ...q, id: q.id ?? String(i) })));
      setLoadingQuestions(false);
    } else {
      // Fall back to subcollection for older assignments
      setLoadingQuestions(true);
      const unsub = onSnapshot(
        collection(db, 'assignments', liveAssignment.id, 'questions'),
        snap => {
          const qs = snap.docs.map(d => ({ id: d.id, ...d.data() } as Question & { id: string }));
          qs.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
          setQuestions(qs);
          setLoadingQuestions(false);
        }
      );
      return unsub;
    }
  }, [liveAssignment.id, liveAssignment.questions]);

  const saveEdits = async () => {
    setSaving(true);
    try {
      const updates = {
        title,
        windowOpen: new Date(windowOpen).toISOString(),
        windowClose: new Date(windowClose).toISOString(),
        questionCount,
      };
      await updateDoc(doc(db, 'assignments', liveAssignment.id), updates);
      const updated = { ...liveAssignment, ...updates };
      setLiveAssignment(updated);
      onAssignmentUpdated(updated);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const reuploadFile = async (file: File, type: 'brief' | 'rubric') => {
    const setUploading = type === 'brief' ? setUploadingBrief : setUploadingRubric;
    setUploading(true);
    try {
      const folder = type === 'brief' ? 'briefs' : 'rubrics';
      const storageRef = ref(storage, `assignments/${folder}/${Date.now()}_${file.name}`);
      const snap = await uploadBytes(storageRef, file);
      const url = await getDownloadURL(snap.ref);
      const field = type === 'brief' ? 'briefFileUrl' : 'rubricFileUrl';
      await updateDoc(doc(db, 'assignments', liveAssignment.id), {
        [field]: url,
        summaryText: '',
        summaryGeneratedAt: null,
      });
      const updated = { ...liveAssignment, [field]: url, summaryText: '' };
      setLiveAssignment(updated);
      onAssignmentUpdated(updated);
      setSummary('');
    } finally {
      setUploading(false);
    }
  };

  const generateSummary = async () => {
    if (!liveAssignment.briefFileUrl) {
      setSummaryError('Upload a brief file first.');
      return;
    }
    setGeneratingSummary(true);
    setSummaryError('');
    setSummaryStep('Downloading and reading files…');
    try {
      const [briefText, rubricText] = await Promise.all([
        extractTextFromUrl(liveAssignment.briefFileUrl),
        liveAssignment.rubricFileUrl ? extractTextFromUrl(liveAssignment.rubricFileUrl) : Promise.resolve(''),
      ]);
      if (!briefText.trim()) throw new Error('Could not extract text from the brief file. Ensure it is a readable PDF, DOCX, or TXT.');
      setSummaryStep(`Generating summary and ${liveAssignment.questionCount} questions with AI…`);
      const { summaryText, questions: newQs } = await generateAssignmentSummary(briefText, rubricText, liveAssignment.questionCount);

      // Save summary to Firestore
      await updateDoc(doc(db, 'assignments', liveAssignment.id), {
        summaryText,
        summaryGeneratedAt: serverTimestamp(),
      });
      setSummary(summaryText);
      setLiveAssignment(prev => ({ ...prev, summaryText }));

      // Save questions inline on the assignment doc (avoids subcollection permission issues)
      const questionsArray = newQs.map((q, i) => ({
        textEn: q.textEn, textAr: q.textAr,
        followUpEn: q.followUpEn || null, followUpAr: q.followUpAr || null,
        order: i,
      }));
      await updateDoc(doc(db, 'assignments', liveAssignment.id), { questions: questionsArray });
      setLiveAssignment(prev => ({ ...prev, questions: questionsArray }));
    } catch (err: any) {
      setSummaryError(err?.message || 'Failed to generate summary.');
    } finally {
      setGeneratingSummary(false);
      setSummaryStep('');
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="text-stone-400 hover:text-stone-600 text-sm flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" />
          All Assignments
        </button>
        {!editing ? (
          <button onClick={() => setEditing(true)}
            className="flex items-center gap-2 text-sm text-emerald-600 hover:text-emerald-700 font-medium">
            <Edit3 className="w-4 h-4" />
            Edit
          </button>
        ) : (
          <div className="flex gap-2">
            <button onClick={() => { setEditing(false); setTitle(liveAssignment.title); }}
              className="text-sm text-stone-400 hover:text-stone-600 px-3 py-1.5 rounded-xl hover:bg-stone-100">
              Cancel
            </button>
            <button onClick={saveEdits} disabled={saving}
              className="flex items-center gap-1.5 text-sm bg-emerald-600 text-white px-4 py-1.5 rounded-xl hover:bg-emerald-700 disabled:opacity-50">
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
              Save
            </button>
          </div>
        )}
      </div>

      {/* Assignment metadata card */}
      <div className="bg-white rounded-3xl border border-stone-200 p-6 space-y-5">
        {/* Title */}
        <div>
          {editing ? (
            <input value={title} onChange={e => setTitle(e.target.value)}
              className="text-xl font-serif font-medium text-stone-900 w-full bg-stone-50 border border-stone-200 rounded-xl px-3 py-2 focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
          ) : (
            <h2 className="text-xl font-serif font-medium text-stone-900">{liveAssignment.title}</h2>
          )}
          {course && <p className="text-sm text-stone-400 mt-1">{course.name}</p>}
        </div>

        {/* Dates */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Interview Opens</label>
            {editing ? (
              <input type="datetime-local" value={windowOpen} onChange={e => setWindowOpen(e.target.value)}
                className="w-full px-3 py-2 bg-stone-50 border border-stone-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
            ) : (
              <p className="text-sm text-stone-700">{new Date(liveAssignment.windowOpen).toLocaleString()}</p>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Interview Closes</label>
            {editing ? (
              <input type="datetime-local" value={windowClose} onChange={e => setWindowClose(e.target.value)}
                className="w-full px-3 py-2 bg-stone-50 border border-stone-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
            ) : (
              <p className="text-sm text-stone-700">{new Date(liveAssignment.windowClose).toLocaleString()}</p>
            )}
          </div>
        </div>

        {/* Question count + metadata */}
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Questions</label>
            {editing ? (
              <input type="number" min="4" max="20" value={questionCount}
                onChange={e => setQuestionCount(parseInt(e.target.value))}
                className="w-full px-3 py-2 bg-stone-50 border border-stone-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
            ) : (
              <p className="text-sm text-stone-700">{liveAssignment.questionCount}</p>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Mode</label>
            <p className="text-sm text-stone-700">{liveAssignment.questionMode}</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Status</label>
            <span className={cn('px-2 py-0.5 text-xs font-bold uppercase rounded-md',
              liveAssignment.status === 'Active' ? 'bg-emerald-100 text-emerald-700' :
              liveAssignment.status === 'Processing' ? 'bg-amber-100 text-amber-700' :
              'bg-stone-100 text-stone-500')}>
              {liveAssignment.status}
            </span>
          </div>
        </div>

        {/* Files */}
        <div className="grid grid-cols-2 gap-4 pt-4 border-t border-stone-100">
          <FileSlot
            label="Assignment Brief"
            url={liveAssignment.briefFileUrl}
            uploading={uploadingBrief}
            onFile={f => reuploadFile(f, 'brief')}
          />
          <FileSlot
            label="Grading Rubric"
            url={liveAssignment.rubricFileUrl}
            uploading={uploadingRubric}
            onFile={f => reuploadFile(f, 'rubric')}
            optional
          />
        </div>
      </div>

      {/* AI Summary */}
      <div className="bg-white rounded-3xl border border-stone-200 p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-bold text-stone-400 uppercase tracking-wider">AI Assignment Summary</h3>
            <p className="text-xs text-stone-400 mt-0.5">Auto-generated from the brief. Regenerate when files change.</p>
          </div>
          <button
            onClick={generateSummary}
            disabled={generatingSummary || !liveAssignment.briefFileUrl}
            className="flex items-center gap-1.5 text-xs text-emerald-600 hover:text-emerald-700 font-medium disabled:opacity-40 bg-emerald-50 hover:bg-emerald-100 px-3 py-1.5 rounded-xl transition-colors"
          >
            {generatingSummary ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            {summary ? 'Regenerate' : 'Generate'}
          </button>
        </div>
        {summaryError && (
          <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-xl px-3 py-2 mb-3">
            {summaryError}
          </div>
        )}
        {generatingSummary ? (
          <div className="flex items-center gap-2 text-sm text-stone-400 py-4">
            <Loader2 className="w-4 h-4 animate-spin" />
            {summaryStep || 'Working…'}
          </div>
        ) : summary ? (
          <p className="text-sm text-stone-700 leading-relaxed">{summary}</p>
        ) : (
          <p className="text-sm text-stone-400 py-2">
            No summary yet.{liveAssignment.briefFileUrl ? ' Click "Generate" above.' : ' Upload a brief file first.'}
          </p>
        )}
      </div>

      {/* Students / Questions tabs */}
      <div className="bg-white rounded-3xl border border-stone-200 overflow-hidden">
        <div className="flex border-b border-stone-100">
          <TabButton label="Students" icon={<Users className="w-4 h-4" />} active={tab === 'students'} onClick={() => setTab('students')} />
          <TabButton
            label={`Generic Questions${questions.length > 0 ? ` (${questions.length})` : ''}`}
            icon={<FileText className="w-4 h-4" />}
            active={tab === 'questions'}
            onClick={() => setTab('questions')}
          />
        </div>

        <div className="p-6">
          {tab === 'students' && (
            <StudentList assignment={liveAssignment} onClose={() => {}} />
          )}
          {tab === 'questions' && (
            <div className="space-y-3">
              {loadingQuestions ? (
                <div className="flex items-center gap-2 text-stone-400 text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" />Loading…
                </div>
              ) : questions.length === 0 ? (
                <div className="py-6 text-center">
                  <p className="text-sm text-stone-400 mb-3">No generic questions yet.</p>
                  <button onClick={generateSummary} disabled={generatingSummary || !liveAssignment.briefFileUrl}
                    className="flex items-center gap-2 text-sm text-emerald-600 hover:text-emerald-700 font-medium mx-auto disabled:opacity-40">
                    {generatingSummary ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                    Generate from Brief
                  </button>
                </div>
              ) : (
                <>
                  {questions.map((q, i) => (
                    <div key={q.id} className="bg-stone-50 rounded-2xl p-4">
                      <p className="text-[10px] text-stone-400 font-bold uppercase tracking-wider mb-1">Q{i + 1}</p>
                      <p className="text-sm text-stone-800">{q.textEn}</p>
                      {q.textAr && (
                        <p className="text-xs text-stone-500 mt-1.5 text-right" dir="rtl">{q.textAr}</p>
                      )}
                      {q.followUpEn && (
                        <p className="text-xs text-stone-400 mt-2 italic border-t border-stone-100 pt-2">
                          ↳ {q.followUpEn}
                        </p>
                      )}
                    </div>
                  ))}
                  <button onClick={generateSummary} disabled={generatingSummary || !liveAssignment.briefFileUrl}
                    className="flex items-center gap-2 text-sm text-emerald-600 hover:text-emerald-700 font-medium mt-2 disabled:opacity-40">
                    {generatingSummary ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                    Regenerate Questions from Brief
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TabButton({ label, icon, active, onClick }: { label: string; icon: React.ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className={cn('flex-1 py-4 text-sm font-medium transition-colors flex items-center justify-center gap-2',
        active ? 'text-emerald-700 border-b-2 border-emerald-600' : 'text-stone-400 hover:text-stone-600')}>
      {icon}
      {label}
    </button>
  );
}

function FileSlot({ label, url, uploading, onFile, optional }: {
  label: string; url?: string; uploading: boolean; onFile: (f: File) => void; optional?: boolean;
}) {
  return (
    <div>
      <p className="text-xs font-medium text-stone-500 mb-2">{label}{optional ? ' (optional)' : ''}</p>
      <div className="flex items-center gap-3">
        {url ? (
          <a href={url} target="_blank" rel="noreferrer"
            className="text-xs text-emerald-600 hover:text-emerald-700 flex items-center gap-1">
            <FileText className="w-3 h-3" />
            View current
          </a>
        ) : (
          <span className="text-xs text-stone-400 flex items-center gap-1">
            <X className="w-3 h-3" />
            Not uploaded
          </span>
        )}
        <label className="text-xs text-stone-500 hover:text-stone-700 cursor-pointer flex items-center gap-1">
          {uploading ? <Loader2 className="w-3 h-3 animate-spin text-emerald-600" /> : <Upload className="w-3 h-3" />}
          {url ? 'Replace' : 'Upload'}
          <input type="file" accept=".pdf,.docx,.txt" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
        </label>
      </div>
    </div>
  );
}
