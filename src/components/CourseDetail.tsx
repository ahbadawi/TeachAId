import { useState, useRef } from 'react';
import { db, storage } from '../firebase';
import { doc, updateDoc } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { Course, Assignment, CourseContextFile } from '../types';
import { ArrowLeft, Save, Upload, Trash2, FileText, Loader2, BookOpen } from 'lucide-react';
import { cn } from '../lib/utils';

interface Props {
  course: Course;
  assignments: Assignment[];
  isDev: boolean;
  onBack: () => void;
  onSelectAssignment: (a: Assignment) => void;
  onCourseUpdated: (updated: Course) => void;
}

export default function CourseDetail({ course, assignments, isDev, onBack, onSelectAssignment, onCourseUpdated }: Props) {
  const [name, setName] = useState(course.name);
  const [description, setDescription] = useState(course.description ?? '');
  const [defaultLanguagePair, setDefaultLanguagePair] = useState(course.defaultLanguagePair);
  const [defaultQuestionCount, setDefaultQuestionCount] = useState(course.defaultQuestionCount);
  const [defaultCaptureMode, setDefaultCaptureMode] = useState<'Snapshot' | 'Video'>(course.defaultCaptureMode);
  const [contextFiles, setContextFiles] = useState<CourseContextFile[]>(course.contextFiles ?? []);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const courseAssignments = assignments.filter(a => a.courseId === course.id);

  const handleSave = async () => {
    setSaving(true);
    const updated: Course = { ...course, name, description, defaultLanguagePair, defaultQuestionCount, defaultCaptureMode, contextFiles };
    if (!isDev) {
      try {
        await updateDoc(doc(db, 'courses', course.id), { name, description, defaultLanguagePair, defaultQuestionCount, defaultCaptureMode, contextFiles });
      } catch (e) {
        console.error('Save failed:', e);
      }
    }
    onCourseUpdated(updated);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    setUploading(true);
    const newFiles: CourseContextFile[] = [];

    for (const file of files) {
      if (isDev) {
        // In dev mode, simulate upload with a fake URL
        newFiles.push({
          name: file.name,
          url: `dev://context/${course.id}/${file.name}`,
          size: file.size,
          uploadedAt: new Date().toISOString(),
        });
      } else {
        try {
          const storageRef = ref(storage, `courses/${course.id}/context/${file.name}`);
          await uploadBytes(storageRef, file);
          const url = await getDownloadURL(storageRef);
          newFiles.push({ name: file.name, url, size: file.size, uploadedAt: new Date().toISOString() });
        } catch (err) {
          console.error('Upload failed:', err);
        }
      }
    }

    setContextFiles(prev => [...prev, ...newFiles]);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setUploading(false);
  };

  const removeFile = (index: number) => {
    setContextFiles(prev => prev.filter((_, i) => i !== index));
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="space-y-8 max-w-3xl">
      <div className="flex items-center gap-4">
        <button onClick={onBack} className="flex items-center gap-1.5 text-stone-400 hover:text-stone-600 text-sm transition-colors">
          <ArrowLeft className="w-4 h-4" />
          Back to Courses
        </button>
      </div>

      {/* Course Identity */}
      <section className="bg-white rounded-3xl border border-stone-200 p-6 space-y-5">
        <h2 className="text-sm font-bold text-stone-400 uppercase tracking-wider">Course Info</h2>

        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">Course Name</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            className="w-full px-4 py-3 bg-stone-50 border border-stone-200 rounded-2xl focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all text-stone-900"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">Description <span className="text-stone-400 font-normal">(optional — used as AI context)</span></label>
          <textarea
            rows={3}
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Briefly describe the course goals, topics, and assessment style..."
            className="w-full px-4 py-3 bg-stone-50 border border-stone-200 rounded-2xl focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all text-stone-900 resize-none"
          />
        </div>
      </section>

      {/* Context Files */}
      <section className="bg-white rounded-3xl border border-stone-200 p-6 space-y-5">
        <div>
          <h2 className="text-sm font-bold text-stone-400 uppercase tracking-wider">Context Files</h2>
          <p className="text-xs text-stone-400 mt-1">Upload syllabi, rubrics, lecture notes, or past papers. These are fed to the AI when generating interview questions for assignments in this course.</p>
        </div>

        {contextFiles.length > 0 && (
          <ul className="space-y-2">
            {contextFiles.map((f, i) => (
              <li key={i} className="flex items-center gap-3 p-3 bg-stone-50 rounded-2xl border border-stone-100">
                <FileText className="w-4 h-4 text-emerald-600 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-stone-800 truncate">{f.name}</p>
                  <p className="text-xs text-stone-400">{formatSize(f.size)} · {new Date(f.uploadedAt).toLocaleDateString()}</p>
                </div>
                <button onClick={() => removeFile(i)} className="p-1.5 text-stone-300 hover:text-red-400 transition-colors rounded-lg hover:bg-red-50">
                  <Trash2 className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.doc,.docx,.txt,.md"
            onChange={handleFileUpload}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex items-center gap-2 px-4 py-2.5 border-2 border-dashed border-stone-200 rounded-2xl text-sm text-stone-500 hover:border-emerald-300 hover:text-emerald-600 hover:bg-emerald-50 transition-all w-full justify-center"
          >
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {uploading ? 'Uploading…' : 'Upload files (PDF, DOCX, TXT, MD)'}
          </button>
          {isDev && <p className="text-xs text-amber-600 mt-2 text-center">Dev mode: uploads are simulated, not stored in Firebase.</p>}
        </div>
      </section>

      {/* Defaults */}
      <section className="bg-white rounded-3xl border border-stone-200 p-6 space-y-5">
        <h2 className="text-sm font-bold text-stone-400 uppercase tracking-wider">Assignment Defaults</h2>

        <div>
          <label className="block text-sm font-medium text-stone-700 mb-2">Capture Mode</label>
          <div className="flex bg-stone-100 p-1 rounded-xl w-48">
            {(['Snapshot', 'Video'] as const).map(m => (
              <button key={m} onClick={() => setDefaultCaptureMode(m)}
                className={cn('flex-1 py-1.5 text-xs font-medium rounded-lg transition-all',
                  defaultCaptureMode === m ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-500')}>
                {m}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">
            Default Question Count: <span className="text-emerald-600 font-bold">{defaultQuestionCount}</span>
          </label>
          <input type="range" min="8" max="16" value={defaultQuestionCount}
            onChange={e => setDefaultQuestionCount(parseInt(e.target.value))}
            className="w-full accent-emerald-600 max-w-xs" />
          <div className="flex justify-between text-xs text-stone-400 mt-1 max-w-xs"><span>8</span><span>16</span></div>
        </div>

        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">Language</label>
          <select value={defaultLanguagePair} onChange={e => setDefaultLanguagePair(e.target.value)}
            className="px-4 py-2.5 bg-stone-50 border border-stone-200 rounded-2xl text-sm text-stone-900 focus:ring-2 focus:ring-emerald-500/20">
            <option value="English + Arabic">English + Arabic</option>
            <option value="English only">English only</option>
            <option value="Arabic only">Arabic only</option>
          </select>
        </div>
      </section>

      {/* Assignments in this course */}
      {courseAssignments.length > 0 && (
        <section className="bg-white rounded-3xl border border-stone-200 p-6 space-y-4">
          <h2 className="text-sm font-bold text-stone-400 uppercase tracking-wider">Assignments in this Course</h2>
          <div className="divide-y divide-stone-100">
            {courseAssignments.map(a => (
              <div key={a.id} onClick={() => onSelectAssignment(a)}
                className="py-3 flex items-center justify-between hover:bg-stone-50 -mx-2 px-2 rounded-2xl cursor-pointer transition-colors">
                <div className="flex items-center gap-3">
                  <BookOpen className="w-4 h-4 text-stone-300" />
                  <div>
                    <p className="text-sm font-medium text-stone-800">{a.title}</p>
                    <p className="text-xs text-stone-400">{a.questionCount} questions · {a.questionMode}</p>
                  </div>
                </div>
                <span className={cn('px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-md',
                  a.status === 'Active' ? 'bg-emerald-100 text-emerald-700' : 'bg-stone-100 text-stone-500')}>
                  {a.status}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <button onClick={handleSave} disabled={saving}
        className="flex items-center gap-2 bg-stone-900 text-white px-6 py-3 rounded-2xl text-sm font-medium hover:bg-stone-800 transition-colors disabled:opacity-60">
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
        {saved ? 'Saved!' : saving ? 'Saving…' : 'Save Changes'}
      </button>
    </div>
  );
}
