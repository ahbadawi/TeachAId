import { useState, useEffect } from 'react';
import { db, auth } from '../firebase';
import { collection, query, where, onSnapshot, doc, updateDoc, getDocs } from 'firebase/firestore';
import { Educator, Course, Assignment, InterviewSession } from '../types';
import { Plus, BookOpen, ClipboardList, LogOut, Search, Bell, Loader2, History, FileText, ShieldCheck } from 'lucide-react';
import { motion } from 'motion/react';
import { cn } from '../lib/utils';
import CreateAssignment from './CreateAssignment';
import CreateCourse from './CreateCourse';
import CourseDetail from './CourseDetail';
import AssignmentDetail from './AssignmentDetail';
import AuditLogs from './AuditLogs';
import AdminPanel from './AdminPanel';

interface Props {
  educator: Educator;
  onSignOut?: () => void;
}

const DEV_COURSES: Course[] = [
  { id: 'dev-course-1', name: 'Introduction to AI', educatorId: 'dev-educator-001', institutionId: 'dev-institution', defaultLanguagePair: 'en', defaultQuestionCount: 12, defaultCaptureMode: 'Snapshot' },
  { id: 'dev-course-2', name: 'Data Structures', educatorId: 'dev-educator-001', institutionId: 'dev-institution', defaultLanguagePair: 'en', defaultQuestionCount: 10, defaultCaptureMode: 'Snapshot' },
];
const DEV_ASSIGNMENTS: Assignment[] = [
  { id: 'dev-assign-1', title: 'Essay on Neural Networks', courseId: 'dev-course-1', educatorId: 'dev-educator-001', windowOpen: new Date(Date.now() - 86400000).toISOString(), windowClose: new Date(Date.now() + 86400000 * 5).toISOString(), questionCount: 12, questionMode: 'AI-Generated', responseTimeLimit: 60, captureMode: 'Snapshot', status: 'Active' },
  { id: 'dev-assign-2', title: 'Binary Trees Implementation', courseId: 'dev-course-2', educatorId: 'dev-educator-001', windowOpen: new Date(Date.now() - 172800000).toISOString(), windowClose: new Date(Date.now() + 86400000 * 3).toISOString(), questionCount: 10, questionMode: 'Manual', responseTimeLimit: 90, captureMode: 'Snapshot', status: 'Active' },
  { id: 'dev-assign-3', title: 'Closed: Recursion Concepts', courseId: 'dev-course-2', educatorId: 'dev-educator-001', windowOpen: new Date(Date.now() - 864000000).toISOString(), windowClose: new Date(Date.now() - 86400000).toISOString(), questionCount: 8, questionMode: 'Mixed', responseTimeLimit: 60, captureMode: 'Snapshot', status: 'Closed' },
];
const DEV_SESSIONS: InterviewSession[] = [
  { id: 's1', assignmentId: 'dev-assign-1', studentId: 'stu-1', submissionId: '', currentQuestionIndex: 0, arabicAudioEnabled: false, status: 'AWAITING_REVIEW', startedAt: new Date().toISOString() },
  { id: 's2', assignmentId: 'dev-assign-1', studentId: 'stu-2', submissionId: '', currentQuestionIndex: 2, arabicAudioEnabled: false, status: 'IN_PROGRESS',      startedAt: new Date().toISOString() },
  { id: 's3', assignmentId: 'dev-assign-1', studentId: 'stu-3', submissionId: '', currentQuestionIndex: 0, arabicAudioEnabled: false, status: 'REVIEWED',          startedAt: new Date().toISOString() },
  { id: 's4', assignmentId: 'dev-assign-2', studentId: 'stu-4', submissionId: '', currentQuestionIndex: 0, arabicAudioEnabled: false, status: 'AWAITING_PROCESSING', startedAt: new Date().toISOString() },
];

export default function EducatorDashboard({ educator, onSignOut }: Props) {
  const isDev = educator.id === 'dev-educator-001';
  const [courses, setCourses] = useState<Course[]>(isDev ? DEV_COURSES : []);
  const [assignments, setAssignments] = useState<Assignment[]>(isDev ? DEV_ASSIGNMENTS : []);
  const [sessions, setSessions] = useState<InterviewSession[]>(isDev ? DEV_SESSIONS : []);
  const [activeTab, setActiveTab] = useState<'overview' | 'assignments' | 'courses' | 'logs' | 'admin'>('overview');
  const [showCreateAssignment, setShowCreateAssignment] = useState(false);
  const [showCreateCourse, setShowCreateCourse] = useState(false);
  const [selectedAssignment, setSelectedAssignment] = useState<Assignment | null>(null);
  const [selectedCourse, setSelectedCourse] = useState<Course | null>(null);
  const [loading, setLoading] = useState(!isDev);
  const [searchQuery, setSearchQuery] = useState('');

  // Per-course student counts
  const [courseStudentCounts, setCourseStudentCounts] = useState<Record<string, number>>({});

  // Notification count — sessions waiting for the educator's review
  const awaitingReviewCount = sessions.filter(s => s.status === 'AWAITING_REVIEW').length;

  useEffect(() => {
    if (isDev) return;

    const qCourses = query(collection(db, 'courses'), where('educatorId', '==', educator.id));
    const unsubCourses = onSnapshot(qCourses, (snapshot) => {
      const cs = snapshot.docs.map(d => ({ id: d.id, ...d.data() } as Course));
      setCourses(cs);
      // Refresh student counts for each course
      cs.forEach(c => {
        getDocs(query(collection(db, 'students'), where('courseId', '==', c.id))).then(snap => {
          setCourseStudentCounts(prev => ({ ...prev, [c.id]: snap.size }));
        });
      });
    });

    const qAssignments = query(collection(db, 'assignments'), where('educatorId', '==', educator.id));
    const unsubAssignments = onSnapshot(qAssignments, (snapshot) => {
      setAssignments(snapshot.docs.map(d => ({ id: d.id, ...d.data() } as Assignment)));
      setLoading(false);
    });

    const qSessions = query(collection(db, 'interviewSessions'), where('assignmentId', '!=', ''));
    const unsubSessions = onSnapshot(qSessions, (snapshot) => {
      setSessions(snapshot.docs.map(d => ({ id: d.id, ...d.data() } as InterviewSession)));
    });

    return () => { unsubCourses(); unsubAssignments(); unsubSessions(); };
  }, [educator.id, isDev]);

  const sessionStats = assignments.reduce<Record<string, {
    total: number; completed: number;
    submitted: number; interviewed: number; graded: number; flagged: number;
  }>>((acc, a) => {
    const asSessions = sessions.filter(s => s.assignmentId === a.id);
    const submitted = asSessions.filter(s => s.workFileUrl || s.status !== 'NOT_STARTED').length;
    const interviewed = asSessions.filter(s =>
      ['AWAITING_REVIEW', 'REVIEWED', 'AWAITING_PROCESSING', 'INCOMPLETE'].includes(s.status)
    ).length;
    const graded = asSessions.filter(s => (s as any).grade?.score !== undefined || s.status === 'REVIEWED').length;
    const flagged = asSessions.filter(s => (s as any).flagged === true).length;
    const completed = asSessions.filter(s =>
      ['AWAITING_REVIEW', 'REVIEWED', 'AWAITING_PROCESSING'].includes(s.status)
    ).length;
    acc[a.id] = { total: asSessions.length, completed, submitted, interviewed, graded, flagged };
    return acc;
  }, {});

  const openAssignment = (a: Assignment) => {
    setSelectedAssignment(a);
    setActiveTab('assignments');
  };

  if (!educator) return null;

  return (
    <div className="min-h-screen bg-stone-50 flex">
      {/* Sidebar */}
      <aside className="w-64 bg-white border-r border-stone-200 flex flex-col">
        <div className="p-6">
          <h1 className="text-2xl font-serif font-medium text-emerald-700">TeachAId</h1>
        </div>

        <nav className="flex-1 px-4 space-y-1">
          <NavItem icon={<ClipboardList className="w-5 h-5" />} label="Overview"
            active={activeTab === 'overview'}
            onClick={() => { setActiveTab('overview'); setSelectedAssignment(null); }} />
          <NavItem icon={<FileText className="w-5 h-5" />} label="Assignments"
            active={activeTab === 'assignments'}
            onClick={() => { setActiveTab('assignments'); setSelectedAssignment(null); }} />
          <NavItem icon={<BookOpen className="w-5 h-5" />} label="Courses"
            active={activeTab === 'courses'}
            onClick={() => setActiveTab('courses')} />
          {educator.role === 'Admin' && (
            <NavItem icon={<History className="w-5 h-5" />} label="Audit Logs"
              active={activeTab === 'logs'}
              onClick={() => setActiveTab('logs')} />
          )}
          <NavItem icon={<ShieldCheck className="w-5 h-5" />} label="Admin"
            active={activeTab === 'admin'}
            onClick={() => setActiveTab('admin')} />
        </nav>

        <div className="p-4 border-t border-stone-100">
          <div className="flex items-center gap-3 p-2 mb-4">
            <div className="w-8 h-8 bg-stone-100 rounded-full flex items-center justify-center text-xs font-bold text-stone-600">
              {educator.name.charAt(0)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-stone-900 truncate">{educator.name}</p>
              <p className="text-xs text-stone-500 truncate">{educator.role}</p>
            </div>
          </div>
          <button onClick={() => onSignOut ? onSignOut() : auth.signOut()}
            className="w-full flex items-center gap-2 text-stone-500 hover:text-red-600 p-2 text-sm transition-colors">
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="h-16 bg-white border-b border-stone-200 flex items-center justify-between px-8">
          <div className="relative w-96">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search students or assignments..."
              className="w-full pl-10 pr-4 py-2 bg-stone-100 border-none rounded-xl text-sm focus:ring-2 focus:ring-emerald-500/20"
            />
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={() => { setActiveTab('assignments'); setSelectedAssignment(null); }}
              title={awaitingReviewCount > 0 ? `${awaitingReviewCount} session${awaitingReviewCount > 1 ? 's' : ''} awaiting review` : 'No pending reviews'}
              className="p-2 text-stone-400 hover:text-stone-600 relative"
            >
              <Bell className="w-5 h-5" />
              {awaitingReviewCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1 border-2 border-white">
                  {awaitingReviewCount > 9 ? '9+' : awaitingReviewCount}
                </span>
              )}
            </button>
            <button onClick={() => setShowCreateAssignment(true)}
              className="bg-emerald-600 text-white px-4 py-2 rounded-xl text-sm font-medium hover:bg-emerald-700 transition-colors flex items-center gap-2">
              <Plus className="w-4 h-4" />
              New Assignment
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-8">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="w-8 h-8 animate-spin text-stone-300" />
            </div>
          ) : (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>

              {/* ── OVERVIEW ── */}
              {activeTab === 'overview' && (
                <div className="space-y-8">
                  <div className="flex items-baseline gap-3">
                    <h1 className="text-2xl font-serif font-medium text-emerald-700">TeachAId</h1>
                    <span className="text-xs text-stone-400">
                      Last updated {new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}
                    </span>
                  </div>
                  <section>
                    <h2 className="text-lg font-medium text-stone-900 mb-4">Active Assignments</h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                      {assignments.length === 0 ? (
                        <div className="col-span-full py-12 text-center bg-white rounded-3xl border border-dashed border-stone-200">
                          <p className="text-stone-400">No active assignments yet.</p>
                        </div>
                      ) : assignments.map(a => (
                        <div key={a.id} onClick={() => openAssignment(a)}>
                          <AssignmentCard
                            assignment={a}
                            stats={sessionStats[a.id] || { total: 0, completed: 0, submitted: 0, interviewed: 0, graded: 0, flagged: 0 }}
                            courseName={courses.find(c => c.id === a.courseId)?.name}
                            studentCount={courseStudentCounts[a.courseId]}
                          />
                        </div>
                      ))}
                    </div>
                  </section>

                  <section>
                    <h2 className="text-lg font-medium text-stone-900 mb-4">Needs Attention</h2>
                    <div className="bg-white rounded-3xl border border-stone-200 overflow-hidden">
                      {assignments.filter(a => (sessionStats[a.id]?.total ?? 0) > (sessionStats[a.id]?.completed ?? 0)).length === 0 ? (
                        <div className="p-6 text-center text-stone-400 text-sm">Everything is up to date.</div>
                      ) : (
                        <div className="divide-y divide-stone-100">
                          {assignments.filter(a => (sessionStats[a.id]?.total ?? 0) > (sessionStats[a.id]?.completed ?? 0)).map(a => (
                            <div key={a.id} onClick={() => openAssignment(a)}
                              className="px-6 py-4 flex items-center justify-between hover:bg-stone-50 cursor-pointer">
                              <div>
                                <p className="text-sm font-medium text-stone-900">{a.title}</p>
                                <p className="text-xs text-stone-400 mt-0.5">
                                  {sessionStats[a.id]?.completed ?? 0} of {sessionStats[a.id]?.total ?? 0} responses reviewed
                                </p>
                              </div>
                              <span className="text-xs text-amber-600 font-medium">Review pending</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </section>
                </div>
              )}

              {/* ── ASSIGNMENTS ── */}
              {activeTab === 'assignments' && (
                selectedAssignment ? (
                  <AssignmentDetail
                    assignment={selectedAssignment}
                    courses={courses}
                    onBack={() => setSelectedAssignment(null)}
                    onAssignmentUpdated={(updated) => {
                      setAssignments(prev => prev.map(a => a.id === updated.id ? updated : a));
                      setSelectedAssignment(updated);
                    }}
                  />
                ) : (
                  <div className="space-y-6">
                    <div className="flex items-center justify-between">
                      <h2 className="text-2xl font-serif font-medium text-stone-900">All Assignments</h2>
                      <button onClick={() => setShowCreateAssignment(true)}
                        className="text-emerald-600 font-medium text-sm hover:underline">
                        New Assignment
                      </button>
                    </div>
                    {(() => {
                      const q = searchQuery.trim().toLowerCase();
                      const filtered = q
                        ? assignments.filter(a =>
                            a.title.toLowerCase().includes(q) ||
                            (courses.find(c => c.id === a.courseId)?.name || '').toLowerCase().includes(q)
                          )
                        : assignments;
                      return (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                          {filtered.length === 0 ? (
                            <div className="col-span-full py-12 text-center bg-white rounded-3xl border border-dashed border-stone-200">
                              <p className="text-stone-400">{q ? `No assignments match "${searchQuery}".` : 'No assignments yet.'}</p>
                            </div>
                          ) : filtered.map(a => (
                            <div key={a.id} onClick={() => setSelectedAssignment(a)}>
                              <AssignmentCard
                                assignment={a}
                                stats={sessionStats[a.id] || { total: 0, completed: 0, submitted: 0, interviewed: 0, graded: 0, flagged: 0 }}
                                courseName={courses.find(c => c.id === a.courseId)?.name}
                                studentCount={courseStudentCounts[a.courseId]}
                              />
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                )
              )}

              {/* ── COURSES ── */}
              {activeTab === 'courses' && (
                selectedCourse ? (
                  <CourseDetail
                    course={selectedCourse}
                    assignments={assignments}
                    isDev={isDev}
                    onBack={() => setSelectedCourse(null)}
                    onSelectAssignment={(a) => { setSelectedCourse(null); openAssignment(a); }}
                    onCourseUpdated={(updated) => {
                      setCourses(prev => prev.map(c => c.id === updated.id ? updated : c));
                      setSelectedCourse(updated);
                    }}
                  />
                ) : (
                  <div className="space-y-6">
                    <div className="flex items-center justify-between">
                      <h2 className="text-2xl font-serif font-medium text-stone-900">Your Courses</h2>
                      <button onClick={() => setShowCreateCourse(true)}
                        className="text-emerald-600 font-medium text-sm hover:underline">
                        Add Course
                      </button>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      {courses.map(c => {
                        const courseAssignments = assignments.filter(a => a.courseId === c.id);
                        const studentCount = courseStudentCounts[c.id] ?? 0;
                        return (
                          <div key={c.id} onClick={() => setSelectedCourse(c)}
                            className="bg-white p-6 rounded-3xl border border-stone-200 hover:shadow-md hover:border-emerald-200 transition-all cursor-pointer group">
                            <h3 className="text-lg font-medium text-stone-900 mb-2 group-hover:text-emerald-700 transition-colors">{c.name}</h3>
                            <div className="flex items-center gap-3 mb-3">
                              <span className="inline-flex items-center gap-1.5 bg-emerald-50 text-emerald-700 text-xs font-bold px-2.5 py-1 rounded-full">
                                {studentCount} students
                              </span>
                              <span className="text-xs text-stone-400">{courseAssignments.length} assignment{courseAssignments.length !== 1 ? 's' : ''}</span>
                              {c.contextFiles?.length ? (
                                <span className="text-xs text-stone-400">{c.contextFiles.length} context file{c.contextFiles.length > 1 ? 's' : ''}</span>
                              ) : null}
                            </div>
                            {c.description && <p className="text-xs text-stone-400 line-clamp-2">{c.description}</p>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )
              )}

              {activeTab === 'logs' && <AuditLogs />}
              {activeTab === 'admin' && (
                <AdminPanel educatorId={educator.id} institutionId={educator.institutionId} />
              )}
            </motion.div>
          )}
        </div>
      </main>

      {showCreateAssignment && (
        <CreateAssignment courses={courses} educatorId={educator.id} onClose={() => setShowCreateAssignment(false)} />
      )}
      {showCreateCourse && (
        <CreateCourse educatorId={educator.id} institutionId={educator.institutionId} onClose={() => setShowCreateCourse(false)} />
      )}
    </div>
  );
}

function NavItem({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className={cn('w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-sm font-medium transition-all',
        active ? 'bg-emerald-50 text-emerald-700' : 'text-stone-500 hover:bg-stone-50 hover:text-stone-900')}>
      {icon}
      {label}
    </button>
  );
}

function AssignmentCard({ assignment, stats, courseName, studentCount }: {
  assignment: Assignment;
  stats: { total: number; completed: number; submitted: number; interviewed: number; graded: number; flagged: number };
  courseName?: string;
  studentCount?: number;
}) {
  const dueDate = assignment.windowClose ? new Date(assignment.windowClose) : null;
  const now = new Date();
  const dueLabel = dueDate
    ? dueDate < now ? 'Closed' : `Closes ${dueDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
    : 'No deadline set';

  const statusColor =
    assignment.status === 'Active' ? 'bg-emerald-100 text-emerald-700' :
    assignment.status === 'Processing' ? 'bg-amber-100 text-amber-700' :
    'bg-stone-100 text-stone-500';

  return (
    <div className="bg-white p-6 rounded-3xl border border-stone-200 hover:shadow-lg transition-all cursor-pointer group">
      <div className="flex justify-between items-start mb-1">
        <h3 className="font-medium text-stone-900 group-hover:text-emerald-700 transition-colors pr-2 leading-snug">{assignment.title}</h3>
        <span className={cn('px-2 py-1 text-[10px] font-bold uppercase tracking-wider rounded-md whitespace-nowrap shrink-0', statusColor)}>
          {assignment.status}
        </span>
      </div>

      {courseName && <p className="text-xs text-stone-400 mb-2">{courseName}</p>}

      {studentCount !== undefined && studentCount > 0 && (
        <p className="text-xs text-stone-500 mb-3">
          <span className="font-bold text-stone-700">{studentCount}</span> students in roster
        </p>
      )}

      <div className="grid grid-cols-3 gap-2 mb-3">
        <div className="bg-stone-50 rounded-xl p-2 text-center">
          <p className="text-lg font-bold text-stone-800">{stats.submitted}</p>
          <p className="text-[10px] text-stone-400 uppercase tracking-wide">Submitted</p>
        </div>
        <div className="bg-stone-50 rounded-xl p-2 text-center">
          <p className="text-lg font-bold text-stone-800">{stats.interviewed}</p>
          <p className="text-[10px] text-stone-400 uppercase tracking-wide">Interviewed</p>
        </div>
        <div className="bg-stone-50 rounded-xl p-2 text-center">
          <p className="text-lg font-bold text-stone-800">{stats.graded}</p>
          <p className="text-[10px] text-stone-400 uppercase tracking-wide">Graded</p>
        </div>
      </div>

      {stats.flagged > 0 && (
        <div className="flex items-center gap-1.5 bg-amber-50 border border-amber-100 rounded-xl px-3 py-1.5 mb-3">
          <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
          <span className="text-xs text-amber-700 font-medium">{stats.flagged} submission{stats.flagged > 1 ? 's' : ''} flagged</span>
        </div>
      )}

      <div className="mt-2 pt-3 border-t border-stone-50 flex justify-between items-center">
        <span className={cn('text-xs', dueDate && dueDate < now ? 'text-red-400' : 'text-stone-400')}>{dueLabel}</span>
        <span className="text-xs font-medium text-emerald-600">View Details</span>
      </div>
    </div>
  );
}

