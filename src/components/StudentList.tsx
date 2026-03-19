import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, where, onSnapshot, addDoc, serverTimestamp, updateDoc, doc } from 'firebase/firestore';
import { Assignment, Student, Submission, InterviewSession } from '../types';
import {
  UserPlus, Mail, Link as LinkIcon, CheckCircle2, Clock,
  AlertCircle, FileText, Loader2, X,
} from 'lucide-react';
import { cn } from '../lib/utils';
import ReportViewer from './ReportViewer';

interface Props {
  assignment: Assignment;
  onClose: () => void;
}

export default function StudentList({ assignment, onClose }: Props) {
  const [students, setStudents] = useState<Student[]>([]);
  const [sessions, setSessions] = useState<InterviewSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedStudentIndex, setSelectedStudentIndex] = useState<number | null>(null);
  const [showAddStudent, setShowAddStudent] = useState(false);

  useEffect(() => {
    // Only load students enrolled in this assignment's course
    const qStudents = query(
      collection(db, 'students'),
      where('institutionId', '==', assignment.educatorId || 'ashraf-institution')
    );
    const unsubStudents = onSnapshot(qStudents, snap => {
      const all = snap.docs.map(d => ({ id: d.id, ...d.data() } as Student));
      // Filter to this course only — students belong to exactly one course
      setStudents(all.filter(s => s.courseId === assignment.courseId));
    });

    // Filtered to this assignment only
    const qSessions = query(collection(db, 'interviewSessions'), where('assignmentId', '==', assignment.id));
    const unsubSessions = onSnapshot(qSessions, snap => {
      setSessions(snap.docs.map(d => ({ id: d.id, ...d.data() } as InterviewSession)));
      setLoading(false);
    });

    return () => { unsubStudents(); unsubSessions(); };
  }, [assignment.id, assignment.educatorId]);

  // Secure token: crypto.randomUUID() → store token hash via SHA-256
  const generateSecureToken = async (): Promise<string> => {
    const uuid = crypto.randomUUID();
    // Store raw token in URL, store SHA-256 hash in Firestore
    const encoder = new TextEncoder();
    const data = encoder.encode(uuid);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return JSON.stringify({ raw: uuid, hash: hashHex });
  };

  const generateInvite = async (student: Student) => {
    try {
      const tokenData = JSON.parse(await generateSecureToken());
      const expiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      await addDoc(collection(db, 'inviteTokens'), {
        studentId: student.id,
        assignmentId: assignment.id,
        tokenHash: tokenData.hash,
        expiry,
        issuedBy: assignment.educatorId || 'educator',
        createdAt: serverTimestamp(),
      });
      const url = `${window.location.origin}/?token=${tokenData.raw}`;
      // Copy to clipboard and show
      await navigator.clipboard.writeText(url).catch(() => {});
      alert(`Invite link generated and copied to clipboard:\n\n${url}\n\nThis link expires on ${new Date(expiry).toLocaleDateString()}.`);
    } catch (err) {
      console.error(err);
      alert('Failed to generate invite link.');
    }
  };

  const reviewedSessions = sessions.filter(s => s.status === 'REVIEWED').length;
  const completedSessions = sessions.filter(s => ['AWAITING_REVIEW', 'REVIEWED', 'AWAITING_PROCESSING'].includes(s.status)).length;

  // Navigate between students in report view
  const studentsWithSessions = students.filter(s => sessions.some(sess => sess.studentId === s.id));

  const openReport = (student: Student, idx: number) => {
    const sess = sessions.find(s => s.studentId === student.id);
    if (sess) {
      setSelectedSessionId(sess.id);
      setSelectedStudentIndex(idx);
    }
  };

  if (selectedSessionId) {
    return (
      <div>
        <button onClick={() => setSelectedSessionId(null)} className="text-stone-400 hover:text-stone-600 text-sm mb-4 flex items-center gap-1">
          ← Back to Student List
        </button>
        <ReportViewer
          sessionId={selectedSessionId}
          onClose={() => setSelectedSessionId(null)}
          educatorId={assignment.educatorId || ''}
          onPrevStudent={selectedStudentIndex !== null && selectedStudentIndex > 0 ? () => {
            const prev = studentsWithSessions[selectedStudentIndex - 1];
            if (prev) openReport(prev, selectedStudentIndex - 1);
          } : undefined}
          onNextStudent={selectedStudentIndex !== null && selectedStudentIndex < studentsWithSessions.length - 1 ? () => {
            const next = studentsWithSessions[selectedStudentIndex + 1];
            if (next) openReport(next, selectedStudentIndex + 1);
          } : undefined}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-serif font-medium text-stone-900">{assignment.title}</h2>
          <p className="text-sm text-stone-500 mt-1">
            {completedSessions} of {students.length} completed &bull; {reviewedSessions} reviewed
          </p>
        </div>
        <button
          onClick={() => setShowAddStudent(true)}
          className="flex items-center gap-2 text-sm font-medium text-emerald-600 hover:text-emerald-700"
        >
          <UserPlus className="w-4 h-4" />
          Add Student
        </button>
      </div>

      <div className="bg-white rounded-3xl border border-stone-200 overflow-hidden">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-stone-50 border-b border-stone-200">
              <th className="px-6 py-4 text-xs font-bold text-stone-400 uppercase tracking-wider">Student</th>
              <th className="px-6 py-4 text-xs font-bold text-stone-400 uppercase tracking-wider">ID</th>
              <th className="px-6 py-4 text-xs font-bold text-stone-400 uppercase tracking-wider">Status</th>
              <th className="px-6 py-4 text-xs font-bold text-stone-400 uppercase tracking-wider text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {loading ? (
              <tr><td colSpan={4} className="px-6 py-12 text-center text-stone-400"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></td></tr>
            ) : students.length === 0 ? (
              <tr><td colSpan={4} className="px-6 py-12 text-center text-stone-400 text-sm">No students added yet. Add students or upload a roster.</td></tr>
            ) : (
              students.map((student, idx) => {
                const session = sessions.find(s => s.studentId === student.id);
                const sessionIdx = studentsWithSessions.indexOf(student);
                return (
                  <tr key={student.id} className="hover:bg-stone-50/50 transition-colors">
                    <td className="px-6 py-4">
                      <p className="text-sm font-medium text-stone-900">{student.name}</p>
                      <p className="text-xs text-stone-500">{student.email || 'No email'}</p>
                    </td>
                    <td className="px-6 py-4 text-sm text-stone-600">{student.studentId}</td>
                    <td className="px-6 py-4"><StatusBadge status={session?.status || 'NOT_STARTED'} /></td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex justify-end gap-2">
                        <button onClick={() => generateInvite(student)} className="p-2 text-stone-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-xl transition-all" title="Generate Invite Link">
                          <LinkIcon className="w-4 h-4" />
                        </button>
                        {session && ['AWAITING_REVIEW', 'REVIEWED', 'AWAITING_PROCESSING'].includes(session.status) && (
                          <button onClick={() => openReport(student, sessionIdx)} className="p-2 text-stone-400 hover:text-blue-600 hover:bg-blue-50 rounded-xl transition-all" title="View Report">
                            <FileText className="w-4 h-4" />
                          </button>
                        )}
                        <button className="p-2 text-stone-400 hover:text-stone-600 hover:bg-stone-100 rounded-xl transition-all" title="Send Reminder">
                          <Mail className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {showAddStudent && <AddStudentModal onClose={() => setShowAddStudent(false)} institutionId={assignment.educatorId || 'ashraf-institution'} courseId={assignment.courseId} />}
    </div>
  );
}

function AddStudentModal({ onClose, institutionId, courseId }: { onClose: () => void; institutionId: string; courseId: string }) {
  const [name, setName] = useState('');
  const [studentId, setStudentId] = useState('');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !studentId.trim()) return;
    setLoading(true);
    try {
      await addDoc(collection(db, 'students'), {
        name: name.trim(),
        studentId: studentId.trim(),
        email: email.trim() || null,
        institutionId,
        courseId,
        createdAt: serverTimestamp(),
      });
      onClose();
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-stone-900/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-[32px] shadow-2xl w-full max-w-md">
        <div className="p-6 border-b border-stone-100 flex justify-between items-center">
          <h3 className="text-lg font-serif font-medium text-stone-900">Add Student</h3>
          <button onClick={onClose} className="p-2 hover:bg-stone-100 rounded-full"><X className="w-5 h-5 text-stone-400" /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">Full Name *</label>
            <input required type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Student's full name"
              className="w-full px-4 py-3 bg-stone-50 border border-stone-200 rounded-2xl text-sm focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">Student ID *</label>
            <input required type="text" value={studentId} onChange={e => setStudentId(e.target.value)} placeholder="University student ID"
              className="w-full px-4 py-3 bg-stone-50 border border-stone-200 rounded-2xl text-sm focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">Email (optional)</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="student@university.edu"
              className="w-full px-4 py-3 bg-stone-50 border border-stone-200 rounded-2xl text-sm focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
          </div>
          <button type="submit" disabled={loading || !name.trim() || !studentId.trim()}
            className="w-full bg-stone-900 text-white py-3.5 rounded-2xl font-medium hover:bg-stone-800 disabled:opacity-40 flex items-center justify-center gap-2">
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            Add Student
          </button>
        </form>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { icon: any; color: string; label: string }> = {
    NOT_STARTED: { icon: Clock, color: 'text-stone-400 bg-stone-100', label: 'Not Started' },
    CONSENT_PENDING: { icon: Clock, color: 'text-stone-400 bg-stone-100', label: 'Consent Pending' },
    UPLOAD_PENDING: { icon: Clock, color: 'text-stone-400 bg-stone-100', label: 'Upload Pending' },
    IN_PROGRESS: { icon: Loader2, color: 'text-amber-600 bg-amber-50', label: 'In Progress' },
    AWAITING_PROCESSING: { icon: Loader2, color: 'text-blue-500 bg-blue-50', label: 'Processing' },
    AWAITING_REVIEW: { icon: AlertCircle, color: 'text-blue-600 bg-blue-50', label: 'Awaiting Review' },
    REVIEWED: { icon: CheckCircle2, color: 'text-emerald-600 bg-emerald-50', label: 'Reviewed' },
    INCOMPLETE: { icon: AlertCircle, color: 'text-red-600 bg-red-50', label: 'Incomplete' },
    PROCESSING_FAILED: { icon: AlertCircle, color: 'text-red-600 bg-red-50', label: 'Processing Failed' },
    EXPIRED: { icon: Clock, color: 'text-stone-400 bg-stone-100', label: 'Expired' },
  };

  const cfg = config[status] || config['NOT_STARTED'];
  const Icon = cfg.icon;

  return (
    <span className={cn('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider', cfg.color)}>
      <Icon className={cn('w-3 h-3', (status === 'IN_PROGRESS' || status === 'AWAITING_PROCESSING') && 'animate-spin')} />
      {cfg.label}
    </span>
  );
}
