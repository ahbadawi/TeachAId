import { useState, useEffect } from 'react';
import { db, storage } from '../firebase';
import {
  updateDoc, doc,
  serverTimestamp,
} from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { Assignment, Course } from '../types';
import {
  ArrowLeft, Edit3, Save, X, Upload, RefreshCw,
  Loader2, Users, Info, FileText,
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
  const [windowOpen, setWindowOpen] = useState((assignment.windowOpen || '').slice(0, 16));
  const [windowClose, setWindowClose] = useState((assignment.windowClose || '').slice(0, 16));
  const [questionCount, setQuestionCount] = useState(assignment.questionCount);
  const [saving, setSaving] = useState(false);

  // File re-upload
  const [uploadingBrief, setUploadingBrief] = useState(false);
  const [uploadingRubric, setUploadingRubric] = useState(false);

  // AI summary + rubric
  const [summary, setSummary] = useState(assignment.summaryText || '');
  const [rubric, setRubric] = useState(assignment.rubricText || '');
  const [generatingSummary, setGeneratingSummary] = useState(false);
  const [summaryStep, setSummaryStep] = useState('');
  const [summaryError, setSummaryError] = useState('');

  // Live assignment state (updated on Firestore changes)
  const [liveAssignment, setLiveAssignment] = useState(assignment);

  const course = courses.find(c => c.id === liveAssignment.courseId);

  // Sync from parent when prop changes
  useEffect(() => {
    setLiveAssignment(assignment);
    setSummary(assignment.summaryText || '');
    setTitle(assignment.title);
    setWindowOpen((assignment.windowOpen || '').slice(0, 16));
    setWindowClose((assignment.windowClose || '').slice(0, 16));
    setQuestionCount(assignment.questionCount);
  }, [assignment.id]);

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
      setSummaryStep('Generating summary and rubric with AI…');
      const { summaryText, rubricText: effectiveRubric, rubricIsAiGenerated } =
        await generateAssignmentSummary(briefText, rubricText);

      await updateDoc(doc(db, 'assignments', liveAssignment.id), {
        summaryText,
        rubricText: effectiveRubric,
        rubricIsAiGenerated,
        summaryGeneratedAt: serverTimestamp(),
      });
      setSummary(summaryText);
      setRubric(effectiveRubric);
      setLiveAssignment(prev => ({ ...prev, summaryText, rubricText: effectiveRubric, rubricIsAiGenerated }));
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
            <p className="text-sm text-stone-700">6 per student</p>
            <p className="text-xs text-stone-400 mt-0.5">Generated from each submission</p>
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
          <div className="space-y-4">
            <p className="text-sm text-stone-700 leading-relaxed">{summary}</p>
            {rubric && (
              <div className="border-t border-stone-100 pt-4">
                <div className="flex items-center gap-2 mb-3">
                  <p className="text-xs font-semibold text-stone-500 uppercase tracking-wide">Grading Rubric</p>
                  {liveAssignment.rubricIsAiGenerated === true && (
                    <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-violet-50 text-violet-600 border border-violet-200">AI-Generated</span>
                  )}
                  {liveAssignment.rubricIsAiGenerated === false && (
                    <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-200">Uploaded by you</span>
                  )}
                </div>
                <RubricDisplay text={rubric} />
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-stone-400 py-2">
            No summary yet.{liveAssignment.briefFileUrl ? ' Click "Generate" above.' : ' Upload a brief file first.'}
          </p>
        )}
      </div>

      {/* Students tab */}
      <div className="bg-white rounded-3xl border border-stone-200 overflow-hidden">
        <div className="flex border-b border-stone-100">
          <TabButton label="Students" icon={<Users className="w-4 h-4" />} active={tab === 'students'} onClick={() => setTab('students')} />
          <TabButton
            label="Interview Structure"
            icon={<Info className="w-4 h-4" />}
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
              <div className="bg-stone-50 rounded-2xl p-5 border border-stone-100">
                <p className="text-sm font-semibold text-stone-800 mb-1">6 questions per student — all from their submission</p>
                <p className="text-sm text-stone-500 leading-relaxed">
                  Questions are generated fresh when each student starts their interview, targeting specific passages in their own uploaded submission.
                  No questions are shared across students — each interview is unique.
                </p>
              </div>
              <div className="bg-amber-50 rounded-2xl p-4 border border-amber-100">
                <p className="text-xs font-bold text-amber-700 uppercase tracking-wide mb-1">How it works</p>
                <ol className="text-xs text-stone-600 space-y-1 list-decimal list-inside leading-relaxed">
                  <li>Student uploads their submission file</li>
                  <li>AI reads the submission and selects 6 notable passages</li>
                  <li>A question is generated for each passage (explain or "what if")</li>
                  <li>The passage is shown on screen while the student answers</li>
                  <li>Responses are recorded, transcribed, and analyzed for comprehension</li>
                </ol>
              </div>
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

// ─── Rubric renderer — markdown table → HTML table, plain text fallback ──────
function RubricDisplay({ text }: { text: string }) {
  // Detect markdown table: at least two lines containing '|'
  const lines = text.split('\n');
  const tableLines = lines.filter(l => l.includes('|'));
  if (tableLines.length >= 2) {
    const parseRow = (line: string) =>
      line.split('|').slice(1, -1).map(c => c.trim()).filter((_, i, arr) => arr.length > 1);
    // Filter out separator rows (e.g. |---|---|)
    const dataLines = tableLines.filter(l => !/^\|[\s\-|:]+\|$/.test(l.replace(/\s/g, '')));
    if (dataLines.length >= 2) {
      const [headerLine, ...rowLines] = dataLines;
      const headers = parseRow(headerLine);
      const rows = rowLines.map(parseRow).filter(r => r.length > 0);
      return (
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-stone-100">
                {headers.map((h, i) => (
                  <th key={i} className="px-3 py-2 text-left font-semibold text-stone-700 border border-stone-200 whitespace-normal">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri} className={ri % 2 === 0 ? 'bg-white' : 'bg-stone-50'}>
                  {row.map((cell, ci) => (
                    <td key={ci} className="px-3 py-2 text-stone-600 border border-stone-200 align-top whitespace-normal leading-relaxed">{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
  }
  // Fallback: plain text
  return <p className="text-sm text-stone-600 leading-relaxed whitespace-pre-wrap">{text}</p>;
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
