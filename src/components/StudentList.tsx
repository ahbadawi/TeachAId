import { useState, useEffect } from 'react';
import { db } from '../firebase';
import {
  collection, query, where, onSnapshot, addDoc, serverTimestamp, updateDoc, doc,
} from 'firebase/firestore';
import { Assignment, Student, InterviewSession } from '../types';
import {
  UserPlus, Mail, Link as LinkIcon, CheckCircle2, Clock,
  AlertCircle, FileText, Loader2, X, Upload, Send, CheckSquare, Square, Download, Cpu,
} from 'lucide-react';
import { cn } from '../lib/utils';
import ReportViewer from './ReportViewer';
import ClassRosterUpload from './ClassRosterUpload';
import { sendInvites, getSmtpAccounts } from '../lib/claude';

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
  const [showUploadRoster, setShowUploadRoster] = useState(false);

  // Checkbox state
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());

  // Email preview modal
  const [showEmailModal, setShowEmailModal] = useState(false);

  // Batch processing state
  const [batchId, setBatchId] = useState<string | null>(null);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number; failed: number; status: string } | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);

  const handleProcessAll = async () => {
    setBatchError(null);
    try {
      const r = await fetch('/api/batch-process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignmentId: assignment.id }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Failed to start batch processing');
      if (!data.batchId) return; // nothing pending
      setBatchId(data.batchId);
      setBatchProgress({ done: 0, total: data.total, failed: 0, status: 'running' });
    } catch (err: any) {
      setBatchError(err.message);
    }
  };

  // Poll batch status every 5s while running
  useEffect(() => {
    if (!batchId || batchProgress?.status === 'complete') return;
    const iv = setInterval(async () => {
      try {
        const r = await fetch(`/api/batch-status/${batchId}`);
        if (!r.ok) return;
        const data = await r.json();
        setBatchProgress({ done: data.done ?? 0, total: data.total ?? 0, failed: data.failed ?? 0, status: data.status ?? 'running' });
        if (data.status === 'complete') {
          clearInterval(iv);
          if (data.failed > 0) setBatchError(`${data.failed} session(s) failed. Check server logs.`);
        }
      } catch { /* ignore polling errors */ }
    }, 5000);
    return () => clearInterval(iv);
  }, [batchId, batchProgress?.status]);

  useEffect(() => {
    const qStudents = query(
      collection(db, 'students'),
      where('institutionId', '==', assignment.educatorId || 'ashraf-institution')
    );
    const unsubStudents = onSnapshot(qStudents, snap => {
      const all = snap.docs.map(d => ({ id: d.id, ...d.data() } as Student));
      // Students belong to this course OR are assignment-scoped to this assignment
      setStudents(all.filter(s =>
        s.courseId === assignment.courseId ||
        (s.assignmentIds && s.assignmentIds.includes(assignment.id))
      ));
    });

    const qSessions = query(collection(db, 'interviewSessions'), where('assignmentId', '==', assignment.id));
    const unsubSessions = onSnapshot(qSessions, snap => {
      setSessions(snap.docs.map(d => ({ id: d.id, ...d.data() } as InterviewSession)));
      setLoading(false);
    });

    return () => { unsubStudents(); unsubSessions(); };
  }, [assignment.id, assignment.educatorId, assignment.courseId]);

  // Generate invite token and return the URL (does not alert/copy automatically)
  const generateInviteUrl = async (student: Student): Promise<string> => {
    const uuid = crypto.randomUUID();
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(uuid));
    const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    const expiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await addDoc(collection(db, 'inviteTokens'), {
      studentId: student.id,
      assignmentId: assignment.id,
      tokenHash: hashHex,
      expiry,
      issuedBy: assignment.educatorId || 'educator',
      createdAt: serverTimestamp(),
    });
    return `${window.location.origin}/?token=${uuid}`;
  };

  const generateInvite = async (student: Student) => {
    try {
      const url = await generateInviteUrl(student);
      await navigator.clipboard.writeText(url).catch(() => {});
      alert(`Invite link copied to clipboard:\n\n${url}`);
    } catch (err) {
      alert('Failed to generate invite link.');
    }
  };

  const toggleCheck = (id: string) => {
    setCheckedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (checkedIds.size === students.length) {
      setCheckedIds(new Set());
    } else {
      setCheckedIds(new Set(students.map(s => s.id)));
    }
  };

  const reviewedSessions = sessions.filter(s => s.status === 'REVIEWED').length;
  const completedSessions = sessions.filter(s =>
    ['AWAITING_REVIEW', 'REVIEWED', 'AWAITING_PROCESSING', 'INCOMPLETE'].includes(s.status)
  ).length;
  const pendingProcessing = sessions.filter(s => s.status === 'AWAITING_PROCESSING').length;

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
        <button onClick={() => setSelectedSessionId(null)}
          className="text-stone-400 hover:text-stone-600 text-sm mb-4 flex items-center gap-1">
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

  const selectedStudents = students.filter(s => checkedIds.has(s.id) && s.email);
  const allChecked = students.length > 0 && checkedIds.size === students.length;
  const someChecked = checkedIds.size > 0 && checkedIds.size < students.length;

  const exportCsv = () => {
    const rows = [
      ['Student ID', 'Name', 'Email', 'Session Status', 'Started At', 'Completed At'],
      ...students.map(s => {
        const sess = sessions.find(se => se.studentId === s.id);
        return [
          s.studentId || '',
          s.name,
          s.email || '',
          sess?.status || 'NOT_STARTED',
          sess?.startedAt ? new Date(sess.startedAt as any).toISOString() : '',
          sess?.completedAt ? new Date(sess.completedAt as any).toISOString() : '',
        ];
      }),
    ];
    const csv = rows
      .map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${assignment.title.replace(/[^a-z0-9]/gi, '_')}_students.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Batch processing progress banner */}
      {batchProgress && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 flex items-center gap-3">
          {batchProgress.status === 'complete'
            ? <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
            : <Loader2 className="w-4 h-4 text-amber-500 animate-spin shrink-0" />}
          <p className="text-sm text-amber-800 font-medium">
            {batchProgress.status === 'complete'
              ? `Batch complete — ${batchProgress.done} processed, ${batchProgress.failed} failed`
              : `Processing sessions… ${batchProgress.done} / ${batchProgress.total}`}
          </p>
        </div>
      )}
      {batchError && (
        <div className="bg-red-50 border border-red-200 rounded-2xl px-4 py-3 text-sm text-red-700">
          {batchError}
        </div>
      )}

      {/* Awaiting review nudge */}
      {(() => {
        const awaitingReview = sessions.filter(s => s.status === 'AWAITING_REVIEW').length;
        if (!awaitingReview || batchProgress) return null;
        return (
          <div className="bg-sky-50 border border-sky-200 rounded-2xl px-4 py-3 flex items-center justify-between gap-3">
            <p className="text-sm text-sky-800 font-medium">
              {awaitingReview} session{awaitingReview > 1 ? 's' : ''} ready for your review
            </p>
            <button
              onClick={() => {
                const first = studentsWithSessions.find(s => {
                  const sess = sessions.find(se => se.studentId === s.id);
                  return sess?.status === 'AWAITING_REVIEW';
                });
                if (first) openReport(first, studentsWithSessions.indexOf(first));
              }}
              className="shrink-0 text-xs font-semibold text-sky-700 bg-sky-100 hover:bg-sky-200 px-3 py-1.5 rounded-lg transition-colors"
            >
              Review Now →
            </button>
          </div>
        );
      })()}

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-sm text-stone-500 mt-1">
            {completedSessions} of {students.length} completed &bull; {reviewedSessions} reviewed
          </p>
        </div>
        <div className="flex items-center gap-2">
          {pendingProcessing > 0 && (
            <button
              onClick={handleProcessAll}
              disabled={!!(batchProgress && batchProgress.status !== 'complete')}
              className="flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-xl bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
            >
              {batchProgress && batchProgress.status !== 'complete' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Cpu className="w-4 h-4" />}
              Process All ({pendingProcessing})
            </button>
          )}
          <button
            onClick={() => setShowEmailModal(true)}
            disabled={checkedIds.size === 0}
            className={cn(
              'flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-xl transition-colors',
              checkedIds.size > 0
                ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                : 'bg-stone-100 text-stone-400 cursor-not-allowed'
            )}
            title={checkedIds.size === 0 ? 'Select students to send invites' : undefined}
          >
            <Send className="w-4 h-4" />
            {checkedIds.size > 0 ? `Send Invites (${checkedIds.size})` : 'Send Invites'}
          </button>
          <button onClick={() => setShowUploadRoster(true)}
            className="flex items-center gap-2 text-sm font-medium text-stone-500 hover:text-stone-700 border border-stone-200 px-3 py-2 rounded-xl hover:bg-stone-50">
            <Upload className="w-4 h-4" />
            Upload Roster
          </button>
          <button onClick={() => setShowAddStudent(true)}
            className="flex items-center gap-2 text-sm font-medium text-emerald-600 hover:text-emerald-700">
            <UserPlus className="w-4 h-4" />
            Add Student
          </button>
          {students.length > 0 && (
            <button onClick={exportCsv}
              title="Download student roster with session status as CSV"
              className="flex items-center gap-2 text-sm font-medium text-stone-500 hover:text-stone-700 border border-stone-200 px-3 py-2 rounded-xl hover:bg-stone-50">
              <Download className="w-4 h-4" />
              Export CSV
            </button>
          )}
        </div>
      </div>

      {/* Student table */}
      <div className="bg-white rounded-3xl border border-stone-200 overflow-hidden">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-stone-50 border-b border-stone-200">
              <th className="px-4 py-4 w-10">
                <button onClick={toggleAll} className="text-stone-400 hover:text-emerald-600">
                  {allChecked
                    ? <CheckSquare className="w-4 h-4 text-emerald-600" />
                    : someChecked
                    ? <CheckSquare className="w-4 h-4 text-stone-300" />
                    : <Square className="w-4 h-4" />}
                </button>
              </th>
              <th className="px-4 py-4 text-xs font-bold text-stone-400 uppercase tracking-wider">Student</th>
              <th className="px-4 py-4 text-xs font-bold text-stone-400 uppercase tracking-wider">ID</th>
              <th className="px-4 py-4 text-xs font-bold text-stone-400 uppercase tracking-wider">Status</th>
              <th className="px-4 py-4 text-xs font-bold text-stone-400 uppercase tracking-wider text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {loading ? (
              <tr><td colSpan={5} className="px-6 py-12 text-center text-stone-400">
                <Loader2 className="w-6 h-6 animate-spin mx-auto" />
              </td></tr>
            ) : students.length === 0 ? (
              <tr><td colSpan={5} className="px-6 py-12 text-center text-stone-400 text-sm">
                No students yet. Add students or upload a roster.
              </td></tr>
            ) : (
              students.map((student, idx) => {
                const session = sessions.find(s => s.studentId === student.id);
                const sessionIdx = studentsWithSessions.indexOf(student);
                const isChecked = checkedIds.has(student.id);
                return (
                  <tr key={student.id} className={cn('hover:bg-stone-50/50 transition-colors', isChecked && 'bg-emerald-50/30')}>
                    <td className="px-4 py-4">
                      <button onClick={() => toggleCheck(student.id)} className="text-stone-300 hover:text-emerald-600">
                        {isChecked
                          ? <CheckSquare className="w-4 h-4 text-emerald-600" />
                          : <Square className="w-4 h-4" />}
                      </button>
                    </td>
                    <td className="px-4 py-4">
                      <p className="text-sm font-medium text-stone-900">{student.name}</p>
                      <p className="text-xs text-stone-500">{student.email || 'No email'}</p>
                    </td>
                    <td className="px-4 py-4 text-sm text-stone-600">{student.studentId}</td>
                    <td className="px-4 py-4"><StatusBadge status={session?.status || 'NOT_STARTED'} /></td>
                    <td className="px-4 py-4 text-right">
                      <div className="flex justify-end gap-2">
                        <button onClick={() => generateInvite(student)}
                          className="p-2 text-stone-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-xl transition-all"
                          title="Copy Invite Link">
                          <LinkIcon className="w-4 h-4" />
                        </button>
                        {session && ['AWAITING_REVIEW', 'REVIEWED', 'AWAITING_PROCESSING'].includes(session.status) && (
                          <button onClick={() => openReport(student, sessionIdx)}
                            className="p-2 text-stone-400 hover:text-blue-600 hover:bg-blue-50 rounded-xl transition-all"
                            title="View Report">
                            <FileText className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Modals */}
      {showAddStudent && (
        <AddStudentModal
          onClose={() => setShowAddStudent(false)}
          institutionId={assignment.educatorId || 'ashraf-institution'}
          courseId={assignment.courseId}
        />
      )}
      {showUploadRoster && (
        <div className="fixed inset-0 bg-stone-900/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-[32px] shadow-2xl w-full max-w-2xl p-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-serif font-medium text-stone-900">Upload Roster</h3>
              <button onClick={() => setShowUploadRoster(false)} className="p-2 hover:bg-stone-100 rounded-full">
                <X className="w-5 h-5 text-stone-400" />
              </button>
            </div>
            <p className="text-xs text-stone-500 mb-4">
              Students uploaded here are added to this assignment only (not the whole course) — useful for late registrations or differentiated assignments.
            </p>
            <ClassRosterUpload
              courseId={assignment.courseId}
              educatorId={assignment.educatorId}
              assignmentId={assignment.id}
              scope="assignment"
              onClose={() => setShowUploadRoster(false)}
              onUploaded={(count) => { setShowUploadRoster(false); }}
            />
          </div>
        </div>
      )}
      {showEmailModal && (
        <EmailPreviewModal
          assignment={assignment}
          selectedStudents={students.filter(s => checkedIds.has(s.id))}
          generateInviteUrl={generateInviteUrl}
          onClose={() => setShowEmailModal(false)}
          onSent={() => { setShowEmailModal(false); setCheckedIds(new Set()); }}
        />
      )}
    </div>
  );
}

// ─── Email Preview Modal ──────────────────────────────────────────────────────
function EmailPreviewModal({
  assignment, selectedStudents, generateInviteUrl, onClose, onSent,
}: {
  assignment: Assignment;
  selectedStudents: Student[];
  generateInviteUrl: (s: Student) => Promise<string>;
  onClose: () => void;
  onSent: () => void;
}) {
  const defaultSubject = `Interview Invitation: ${assignment.title}`;
  const defaultBody =
    `Dear {{name}},\n\nYou have been invited to complete an integrity interview for:\n\n{{assignment}}\n\nPlease use the link below to start your session:\n\n{{link}}\n\nThis link is personal and single-use. It expires in 7 days.\n\nBest regards`;

  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState(defaultBody);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<{ name: string; status: 'sent' | 'failed' | 'no-email'; error?: string }[] | null>(null);
  const [smtpAccounts, setSmtpAccounts] = useState<{ key: string; label: string; from: string }[]>([]);
  const [fromAccount, setFromAccount] = useState<string>('gmail');

  useEffect(() => {
    getSmtpAccounts().then(accounts => {
      setSmtpAccounts(accounts);
      if (accounts.length > 0) setFromAccount(accounts[0].key);
    });
  }, []);

  const eligible = selectedStudents.filter(s => !excluded.has(s.id));
  const withEmail = eligible.filter(s => s.email);
  const withoutEmail = eligible.filter(s => !s.email);

  const toggleExclude = (id: string) => {
    setExcluded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleSend = async () => {
    if (withEmail.length === 0) return;
    setSending(true);
    try {
      // Generate invite URLs for all eligible students with email
      const invites = await Promise.all(
        withEmail.map(async s => ({
          studentId: s.id,
          email: s.email!,
          name: s.name,
          inviteUrl: await generateInviteUrl(s),
        }))
      );
      const sendResults = await sendInvites(invites, assignment.title, subject, body, fromAccount);
      const display: { name: string; status: 'sent' | 'failed' | 'no-email'; error?: string }[] =
        sendResults.map(r => {
          const student = withEmail.find(s => s.id === r.studentId);
          return { name: student?.name || r.studentId, status: r.status, error: r.error };
        });
      // Add students without email as skipped
      withoutEmail.forEach(s => display.push({ name: s.name, status: 'no-email' }));
      setResults(display);
    } catch (err: any) {
      alert(`Send failed: ${err.message}`);
    } finally {
      setSending(false);
    }
  };

  if (results) {
    return (
      <div className="fixed inset-0 bg-stone-900/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
        <div className="bg-white rounded-[32px] shadow-2xl w-full max-w-lg p-8">
          <h3 className="text-lg font-serif font-medium text-stone-900 mb-4">Send Results</h3>
          <div className="space-y-2 mb-6 max-h-60 overflow-y-auto">
            {results.map((r, i) => (
              <div key={i} className={cn('flex items-center justify-between px-4 py-2 rounded-xl text-sm',
                r.status === 'sent' ? 'bg-emerald-50' : r.status === 'no-email' ? 'bg-stone-50' : 'bg-red-50')}>
                <span className="font-medium text-stone-800">{r.name}</span>
                <span className={cn('text-xs font-bold uppercase',
                  r.status === 'sent' ? 'text-emerald-600' : r.status === 'no-email' ? 'text-stone-400' : 'text-red-600')}>
                  {r.status === 'no-email' ? 'No email' : r.status}
                </span>
              </div>
            ))}
          </div>
          <button onClick={onSent} className="w-full bg-stone-900 text-white py-3 rounded-2xl font-medium hover:bg-stone-800">
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-stone-900/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-[32px] shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="p-6 border-b border-stone-100 flex justify-between items-center">
          <div>
            <h3 className="text-lg font-serif font-medium text-stone-900">Send Interview Invitations</h3>
            <p className="text-xs text-stone-400 mt-0.5">Review list and email before sending. This action cannot be undone.</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-stone-100 rounded-full">
            <X className="w-5 h-5 text-stone-400" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Recipient list */}
          <div>
            <p className="text-xs font-bold text-stone-400 uppercase tracking-wider mb-2">
              Recipients — {withEmail.length} will receive email
            </p>
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {selectedStudents.map(s => (
                <div key={s.id} className={cn('flex items-center justify-between px-3 py-2 rounded-xl text-sm',
                  excluded.has(s.id) ? 'bg-stone-50 opacity-50' : 'bg-stone-50')}>
                  <div>
                    <span className="font-medium text-stone-800">{s.name}</span>
                    <span className="text-stone-400 ml-2 text-xs">{s.email || 'No email — will be skipped'}</span>
                  </div>
                  <button onClick={() => toggleExclude(s.id)}
                    className="text-xs text-stone-400 hover:text-red-500 ml-3">
                    {excluded.has(s.id) ? 'Include' : 'Exclude'}
                  </button>
                </div>
              ))}
            </div>
            {withoutEmail.length > 0 && (
              <p className="text-xs text-amber-600 mt-2">
                {withoutEmail.length} student{withoutEmail.length > 1 ? 's' : ''} have no email and will be skipped.
              </p>
            )}
          </div>

          {/* From account selector */}
          <div>
            <label className="block text-xs font-bold text-stone-400 uppercase tracking-wider mb-2">Send From</label>
            {smtpAccounts.length === 0 ? (
              <p className="text-xs text-amber-600 bg-amber-50 px-3 py-2 rounded-xl">
                No SMTP accounts configured. Set SMTP_* environment variables on the server.
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {smtpAccounts.map(acc => (
                  <label key={acc.key} className={cn(
                    'flex items-center gap-3 px-4 py-3 rounded-xl border cursor-pointer transition-colors',
                    fromAccount === acc.key
                      ? 'border-emerald-400 bg-emerald-50'
                      : 'border-stone-200 bg-stone-50 hover:border-stone-300'
                  )}>
                    <input
                      type="radio"
                      name="fromAccount"
                      value={acc.key}
                      checked={fromAccount === acc.key}
                      onChange={() => setFromAccount(acc.key)}
                      className="accent-emerald-600"
                    />
                    <div>
                      <p className="text-sm font-medium text-stone-800">{acc.label}</p>
                      <p className="text-xs text-stone-400">{acc.from}</p>
                    </div>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Email subject */}
          <div>
            <label className="block text-xs font-bold text-stone-400 uppercase tracking-wider mb-2">Subject</label>
            <input value={subject} onChange={e => setSubject(e.target.value)}
              className="w-full px-4 py-2.5 bg-stone-50 border border-stone-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
          </div>

          {/* Email body */}
          <div>
            <label className="block text-xs font-bold text-stone-400 uppercase tracking-wider mb-1">Message Body</label>
            <p className="text-xs text-stone-400 mb-2">
              Use <code className="bg-stone-100 px-1 rounded">{'{{name}}'}</code>,{' '}
              <code className="bg-stone-100 px-1 rounded">{'{{assignment}}'}</code>,{' '}
              <code className="bg-stone-100 px-1 rounded">{'{{link}}'}</code> as placeholders.
            </p>
            <textarea value={body} onChange={e => setBody(e.target.value)} rows={8}
              className="w-full px-4 py-3 bg-stone-50 border border-stone-200 rounded-xl text-sm font-mono focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 resize-none" />
          </div>
        </div>

        <div className="p-6 border-t border-stone-100 flex gap-3">
          <button onClick={onClose} className="flex-1 py-3 border border-stone-200 rounded-2xl text-sm font-medium text-stone-600 hover:bg-stone-50">
            Cancel
          </button>
          <button
            onClick={handleSend}
            disabled={sending || withEmail.length === 0}
            className="flex-1 bg-emerald-600 text-white py-3 rounded-2xl font-medium hover:bg-emerald-700 disabled:opacity-40 flex items-center justify-center gap-2"
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            {sending ? 'Sending…' : `Send to ${withEmail.length} student${withEmail.length !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Add Student Modal ────────────────────────────────────────────────────────
function AddStudentModal({ onClose, institutionId, courseId }: {
  onClose: () => void; institutionId: string; courseId: string;
}) {
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
          <button onClick={onClose} className="p-2 hover:bg-stone-100 rounded-full">
            <X className="w-5 h-5 text-stone-400" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">Full Name *</label>
            <input required type="text" value={name} onChange={e => setName(e.target.value)}
              placeholder="Student's full name"
              className="w-full px-4 py-3 bg-stone-50 border border-stone-200 rounded-2xl text-sm focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">Student ID *</label>
            <input required type="text" value={studentId} onChange={e => setStudentId(e.target.value)}
              placeholder="University student ID"
              className="w-full px-4 py-3 bg-stone-50 border border-stone-200 rounded-2xl text-sm focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">Email (optional)</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="student@university.edu"
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
    PROCESSING_FAILED: { icon: AlertCircle, color: 'text-red-600 bg-red-50', label: 'Failed' },
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
