import { useState, useEffect } from 'react';
import { db } from '../firebase';
import {
  collection, query, where, onSnapshot, addDoc, deleteDoc, doc,
  updateDoc, serverTimestamp, getDocs, writeBatch,
} from 'firebase/firestore';
import { Course, Assignment, Student } from '../types';
import {
  Plus, Trash2, Edit3, Save, X, Loader2, Users, BookOpen,
  ClipboardList, AlertCircle, CheckCircle2, ChevronDown, ChevronUp,
  Upload, RefreshCw,
} from 'lucide-react';
import { cn } from '../lib/utils';
import ClassRosterUpload from './ClassRosterUpload';

interface Props {
  educatorId: string;
  institutionId: string;
}

type Section = 'courses' | 'roster' | 'assignments';

export default function AdminPanel({ educatorId, institutionId }: Props) {
  const [section, setSection] = useState<Section>('courses');
  const [courses, setCourses] = useState<Course[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubCourses = onSnapshot(
      query(collection(db, 'courses'), where('educatorId', '==', educatorId)),
      snap => { setCourses(snap.docs.map(d => ({ id: d.id, ...d.data() } as Course))); setLoading(false); }
    );
    const unsubAssign = onSnapshot(
      query(collection(db, 'assignments'), where('educatorId', '==', educatorId)),
      snap => { setAssignments(snap.docs.map(d => ({ id: d.id, ...d.data() } as Assignment))); }
    );
    return () => { unsubCourses(); unsubAssign(); };
  }, [educatorId]);

  if (loading) return <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-stone-300" /></div>;

  return (
    <div className="space-y-6 max-w-4xl">
      <h2 className="text-2xl font-serif font-medium text-stone-900">Admin</h2>

      {/* Section tabs */}
      <div className="flex bg-stone-100 p-1 rounded-2xl w-fit gap-1">
        {([
          { key: 'courses', label: 'Courses', icon: BookOpen },
          { key: 'roster', label: 'Rosters', icon: Users },
          { key: 'assignments', label: 'Assignments', icon: ClipboardList },
        ] as { key: Section; label: string; icon: any }[]).map(({ key, label, icon: Icon }) => (
          <button key={key} onClick={() => setSection(key)}
            className={cn('flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all',
              section === key ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-500 hover:text-stone-700')}>
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>

      {section === 'courses' && (
        <CourseSection courses={courses} assignments={assignments} educatorId={educatorId} institutionId={institutionId} />
      )}
      {section === 'roster' && (
        <RosterSection courses={courses} educatorId={educatorId} />
      )}
      {section === 'assignments' && (
        <AssignmentSection assignments={assignments} courses={courses} educatorId={educatorId} />
      )}
    </div>
  );
}

// ─── Course Management ────────────────────────────────────────────────────────
function CourseSection({ courses, assignments, educatorId, institutionId }: {
  courses: Course[]; assignments: Assignment[]; educatorId: string; institutionId: string;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [adding, setAdding] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const handleAdd = async () => {
    if (!newName.trim()) return;
    setAdding(true);
    try {
      await addDoc(collection(db, 'courses'), {
        name: newName.trim(),
        description: newDesc.trim() || null,
        educatorId,
        institutionId,
        defaultLanguagePair: 'en',
        defaultQuestionCount: 12,
        defaultCaptureMode: 'Snapshot',
        createdAt: serverTimestamp(),
      });
      setNewName('');
      setNewDesc('');
      setShowAdd(false);
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (courseId: string) => {
    setDeletingId(courseId);
    try {
      // Delete all students in course
      const studs = await getDocs(query(collection(db, 'students'), where('courseId', '==', courseId)));
      const batch = writeBatch(db);
      studs.docs.forEach(d => batch.delete(d.ref));
      // Delete the course doc
      batch.delete(doc(db, 'courses', courseId));
      await batch.commit();
      setConfirmDeleteId(null);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-sm text-stone-500">{courses.length} course{courses.length !== 1 ? 's' : ''}</p>
        <button onClick={() => setShowAdd(v => !v)}
          className="flex items-center gap-2 text-sm font-medium text-emerald-600 hover:text-emerald-700">
          <Plus className="w-4 h-4" />
          Add Course
        </button>
      </div>

      {showAdd && (
        <div className="bg-stone-50 border border-stone-200 rounded-2xl p-4 space-y-3">
          <p className="text-xs font-bold text-stone-400 uppercase tracking-wider">New Course</p>
          <input value={newName} onChange={e => setNewName(e.target.value)}
            placeholder="Course name (e.g. CSAI-490: Selected Topics…)"
            className="w-full px-3 py-2 bg-white border border-stone-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
          <input value={newDesc} onChange={e => setNewDesc(e.target.value)}
            placeholder="Description (optional)"
            className="w-full px-3 py-2 bg-white border border-stone-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
          <div className="flex gap-2">
            <button onClick={() => setShowAdd(false)} className="px-4 py-2 text-sm text-stone-500 hover:bg-stone-100 rounded-xl">Cancel</button>
            <button onClick={handleAdd} disabled={adding || !newName.trim()}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white text-sm rounded-xl hover:bg-emerald-700 disabled:opacity-50">
              {adding && <Loader2 className="w-3 h-3 animate-spin" />}
              Add
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {courses.map(c => {
          const courseAssignments = assignments.filter(a => a.courseId === c.id);
          const isConfirming = confirmDeleteId === c.id;
          return (
            <div key={c.id} className="bg-white border border-stone-200 rounded-2xl px-5 py-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-stone-900">{c.name}</p>
                <p className="text-xs text-stone-400 mt-0.5">
                  {courseAssignments.length} assignment{courseAssignments.length !== 1 ? 's' : ''}
                  {c.description ? ` · ${c.description}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {isConfirming ? (
                  <>
                    <span className="text-xs text-red-600 font-medium">Delete course + all students?</span>
                    <button onClick={() => handleDelete(c.id)} disabled={deletingId === c.id}
                      className="px-3 py-1.5 bg-red-600 text-white text-xs rounded-xl hover:bg-red-700 disabled:opacity-50 flex items-center gap-1">
                      {deletingId === c.id && <Loader2 className="w-3 h-3 animate-spin" />}
                      Confirm
                    </button>
                    <button onClick={() => setConfirmDeleteId(null)} className="px-3 py-1.5 text-stone-500 text-xs rounded-xl hover:bg-stone-100">Cancel</button>
                  </>
                ) : (
                  <button onClick={() => setConfirmDeleteId(c.id)}
                    className="p-2 text-stone-300 hover:text-red-500 hover:bg-red-50 rounded-xl transition-all" title="Delete course">
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Roster Management ────────────────────────────────────────────────────────
function RosterSection({ courses, educatorId }: { courses: Course[]; educatorId: string }) {
  const [selectedCourseId, setSelectedCourseId] = useState<string>('');
  const [students, setStudents] = useState<Student[]>([]);
  const [loadingStudents, setLoadingStudents] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [dupeIds, setDupeIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!selectedCourseId) { setStudents([]); return; }
    setLoadingStudents(true);
    const unsub = onSnapshot(
      query(collection(db, 'students'), where('courseId', '==', selectedCourseId)),
      snap => {
        const all = snap.docs.map(d => ({ id: d.id, ...d.data() } as Student));
        // Detect duplicates by studentId
        const idCounts = new Map<string, number>();
        all.forEach(s => {
          const k = (s.studentId || '').toLowerCase();
          idCounts.set(k, (idCounts.get(k) || 0) + 1);
        });
        const dupes = new Set<string>();
        all.forEach(s => {
          const k = (s.studentId || '').toLowerCase();
          if ((idCounts.get(k) || 0) > 1) dupes.add(s.id);
        });
        setDupeIds(dupes);
        setStudents(all.sort((a, b) => a.name.localeCompare(b.name)));
        setLoadingStudents(false);
      }
    );
    return unsub;
  }, [selectedCourseId]);

  const handleDelete = async (studentId: string) => {
    setDeletingId(studentId);
    try { await deleteDoc(doc(db, 'students', studentId)); }
    finally { setDeletingId(null); }
  };

  const selectedCourse = courses.find(c => c.id === selectedCourseId);

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs font-medium text-stone-500 mb-2">Select Course</label>
        <select value={selectedCourseId} onChange={e => setSelectedCourseId(e.target.value)}
          className="w-full px-3 py-2.5 bg-white border border-stone-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-500/20">
          <option value="">— choose a course —</option>
          {courses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      {selectedCourseId && (
        <>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-stone-700">
                {loadingStudents ? '…' : students.length} student{students.length !== 1 ? 's' : ''}
              </span>
              {dupeIds.size > 0 && (
                <span className="inline-flex items-center gap-1 text-xs font-medium bg-amber-50 text-amber-700 px-2.5 py-1 rounded-full">
                  <AlertCircle className="w-3 h-3" /> {dupeIds.size} duplicate ID{dupeIds.size > 1 ? 's' : ''}
                </span>
              )}
            </div>
            <button onClick={() => setShowUpload(true)}
              className="flex items-center gap-2 text-sm font-medium text-emerald-600 hover:text-emerald-700">
              <Upload className="w-4 h-4" />
              Upload Roster
            </button>
          </div>

          {dupeIds.size > 0 && (
            <div className="bg-amber-50 border border-amber-100 rounded-2xl px-4 py-3 text-xs text-amber-700">
              <strong>Duplicate student IDs detected.</strong> Review below and remove duplicates manually before sending invites.
            </div>
          )}

          {loadingStudents ? (
            <div className="flex items-center gap-2 text-stone-400 text-sm py-4"><Loader2 className="w-4 h-4 animate-spin" />Loading…</div>
          ) : students.length === 0 ? (
            <div className="py-8 text-center text-stone-400 text-sm">No students yet. Upload a roster to add students.</div>
          ) : (
            <div className="border border-stone-100 rounded-2xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-stone-50 text-stone-400 text-xs uppercase tracking-wider">
                  <tr>
                    <th className="px-4 py-3 text-left">Student ID</th>
                    <th className="px-4 py-3 text-left">Name</th>
                    <th className="px-4 py-3 text-left">Email</th>
                    <th className="px-4 py-3 text-right w-16"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-50">
                  {students.map(s => (
                    <tr key={s.id} className={cn('hover:bg-stone-50', dupeIds.has(s.id) && 'bg-amber-50/50')}>
                      <td className="px-4 py-3 font-mono text-stone-700">
                        {s.studentId}
                        {dupeIds.has(s.id) && (
                          <span className="ml-2 inline-flex items-center gap-0.5 text-[10px] text-amber-600 font-bold">
                            <AlertCircle className="w-3 h-3" /> DUP
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-stone-900 font-medium">{s.name}</td>
                      <td className="px-4 py-3 text-stone-500">{s.email || '—'}</td>
                      <td className="px-4 py-3 text-right">
                        <button onClick={() => handleDelete(s.id)} disabled={deletingId === s.id}
                          className="p-1.5 text-stone-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all disabled:opacity-40">
                          {deletingId === s.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {showUpload && selectedCourse && (
        <ClassRosterUpload
          courseId={selectedCourseId}
          educatorId={educatorId}
          scope="course"
          onClose={() => setShowUpload(false)}
          onUploaded={() => setShowUpload(false)}
        />
      )}
    </div>
  );
}

// ─── Assignment Management ────────────────────────────────────────────────────
function AssignmentSection({ assignments, courses, educatorId }: {
  assignments: Assignment[]; courses: Course[]; educatorId: string;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editOpen, setEditOpen] = useState('');
  const [editClose, setEditClose] = useState('');
  const [editStatus, setEditStatus] = useState<Assignment['status']>('Active');
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [filterCourse, setFilterCourse] = useState('');

  const filtered = filterCourse ? assignments.filter(a => a.courseId === filterCourse) : assignments;

  const startEdit = (a: Assignment) => {
    setEditingId(a.id);
    setEditTitle(a.title);
    setEditOpen(a.windowOpen.slice(0, 16));
    setEditClose(a.windowClose.slice(0, 16));
    setEditStatus(a.status);
  };

  const saveEdit = async (id: string) => {
    setSaving(true);
    try {
      await updateDoc(doc(db, 'assignments', id), {
        title: editTitle,
        windowOpen: new Date(editOpen).toISOString(),
        windowClose: new Date(editClose).toISOString(),
        status: editStatus,
      });
      setEditingId(null);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      // Delete questions subcollection
      const qSnap = await getDocs(collection(db, 'assignments', id, 'questions'));
      const batch = writeBatch(db);
      qSnap.docs.forEach(d => batch.delete(d.ref));
      batch.delete(doc(db, 'assignments', id));
      await batch.commit();
      setConfirmDeleteId(null);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <select value={filterCourse} onChange={e => setFilterCourse(e.target.value)}
          className="px-3 py-2 bg-white border border-stone-200 rounded-xl text-sm text-stone-600 focus:ring-2 focus:ring-emerald-500/20">
          <option value="">All courses</option>
          {courses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <p className="text-sm text-stone-500">{filtered.length} assignment{filtered.length !== 1 ? 's' : ''}</p>
      </div>

      <div className="space-y-2">
        {filtered.length === 0 && (
          <div className="py-8 text-center text-stone-400 text-sm">No assignments found.</div>
        )}
        {filtered.map(a => {
          const course = courses.find(c => c.id === a.courseId);
          const isEditing = editingId === a.id;
          const isConfirming = confirmDeleteId === a.id;

          return (
            <div key={a.id} className="bg-white border border-stone-200 rounded-2xl p-5">
              {isEditing ? (
                <div className="space-y-3">
                  <input value={editTitle} onChange={e => setEditTitle(e.target.value)}
                    className="w-full px-3 py-2 bg-stone-50 border border-stone-200 rounded-xl text-sm font-medium focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-stone-400 mb-1">Opens</label>
                      <input type="datetime-local" value={editOpen} onChange={e => setEditOpen(e.target.value)}
                        className="w-full px-3 py-2 bg-stone-50 border border-stone-200 rounded-xl text-xs focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
                    </div>
                    <div>
                      <label className="block text-xs text-stone-400 mb-1">Closes</label>
                      <input type="datetime-local" value={editClose} onChange={e => setEditClose(e.target.value)}
                        className="w-full px-3 py-2 bg-stone-50 border border-stone-200 rounded-xl text-xs focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-stone-400 mb-1">Status</label>
                    <select value={editStatus} onChange={e => setEditStatus(e.target.value as Assignment['status'])}
                      className="px-3 py-2 bg-stone-50 border border-stone-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-500/20">
                      {(['Draft', 'Processing', 'Ready', 'Active', 'Closed', 'Archived'] as Assignment['status'][]).map(s => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => setEditingId(null)} className="px-4 py-2 text-sm text-stone-500 hover:bg-stone-100 rounded-xl">Cancel</button>
                    <button onClick={() => saveEdit(a.id)} disabled={saving}
                      className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white text-sm rounded-xl hover:bg-emerald-700 disabled:opacity-50">
                      {saving && <Loader2 className="w-3 h-3 animate-spin" />}
                      <Save className="w-3 h-3" />
                      Save
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm font-medium text-stone-900">{a.title}</p>
                    <p className="text-xs text-stone-400 mt-0.5">{course?.name || a.courseId}</p>
                    <div className="flex items-center gap-3 mt-1.5">
                      <span className={cn('text-[10px] font-bold uppercase px-2 py-0.5 rounded-md',
                        a.status === 'Active' ? 'bg-emerald-100 text-emerald-700' :
                        a.status === 'Closed' ? 'bg-stone-100 text-stone-500' :
                        'bg-amber-100 text-amber-700')}>
                        {a.status}
                      </span>
                      <span className="text-xs text-stone-400">
                        {new Date(a.windowOpen).toLocaleDateString()} → {new Date(a.windowClose).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {isConfirming ? (
                      <>
                        <span className="text-xs text-red-600 mr-2">Delete permanently?</span>
                        <button onClick={() => handleDelete(a.id)} disabled={deletingId === a.id}
                          className="px-3 py-1.5 bg-red-600 text-white text-xs rounded-xl hover:bg-red-700 disabled:opacity-50 flex items-center gap-1">
                          {deletingId === a.id && <Loader2 className="w-3 h-3 animate-spin" />}
                          Delete
                        </button>
                        <button onClick={() => setConfirmDeleteId(null)} className="px-3 py-1.5 text-stone-500 text-xs rounded-xl hover:bg-stone-100">Cancel</button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => startEdit(a)}
                          className="p-2 text-stone-300 hover:text-emerald-600 hover:bg-emerald-50 rounded-xl transition-all">
                          <Edit3 className="w-4 h-4" />
                        </button>
                        <button onClick={() => setConfirmDeleteId(a.id)}
                          className="p-2 text-stone-300 hover:text-red-500 hover:bg-red-50 rounded-xl transition-all">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
