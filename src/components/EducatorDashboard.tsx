import { useState, useEffect } from 'react';
import { db, auth } from '../firebase';
import { collection, query, where, onSnapshot, doc, updateDoc, addDoc, serverTimestamp, getDocs } from 'firebase/firestore';
import { Educator, Course, Assignment, InterviewSession } from '../types';
import { Plus, BookOpen, ClipboardList, Settings, LogOut, Search, Bell, Loader2, History, Save, FileText } from 'lucide-react';
import { motion } from 'motion/react';
import { cn } from '../lib/utils';
import CreateAssignment from './CreateAssignment';
import CreateCourse from './CreateCourse';
import CourseDetail from './CourseDetail';
import AssignmentDetail from './AssignmentDetail';
import AuditLogs from './AuditLogs';

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
  { id: 's1', assignmentId: 'dev-assign-1', studentId: 'stu-1', status: 'AWAITING_REVIEW', createdAt: new Date().toISOString() } as InterviewSession,
  { id: 's2', assignmentId: 'dev-assign-1', studentId: 'stu-2', status: 'IN_PROGRESS', createdAt: new Date().toISOString() } as InterviewSession,
  { id: 's3', assignmentId: 'dev-assign-1', studentId: 'stu-3', status: 'REVIEWED', createdAt: new Date().toISOString() } as InterviewSession,
  { id: 's4', assignmentId: 'dev-assign-2', studentId: 'stu-4', status: 'AWAITING_PROCESSING', createdAt: new Date().toISOString() } as InterviewSession,
];

export default function EducatorDashboard({ educator, onSignOut }: Props) {
  const isDev = educator.id === 'dev-educator-001';
  const [courses, setCourses] = useState<Course[]>(isDev ? DEV_COURSES : []);
  const [assignments, setAssignments] = useState<Assignment[]>(isDev ? DEV_ASSIGNMENTS : []);
  const [sessions, setSessions] = useState<InterviewSession[]>(isDev ? DEV_SESSIONS : []);
  const [activeTab, setActiveTab] = useState<'overview' | 'assignments' | 'courses' | 'logs' | 'settings'>('overview');
  const [showCreateAssignment, setShowCreateAssignment] = useState(false);
  const [showCreateCourse, setShowCreateCourse] = useState(false);
  const [selectedAssignment, setSelectedAssignment] = useState<Assignment | null>(null);
  const [selectedCourse, setSelectedCourse] = useState<Course | null>(null);
  const [loading, setLoading] = useState(!isDev);

  // Per-course student counts
  const [courseStudentCounts, setCourseStudentCounts] = useState<Record<string, number>>({});

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
          <NavItem icon={<Settings className="w-5 h-5" />} label="Settings"
            active={activeTab === 'settings'}
            onClick={() => setActiveTab('settings')} />
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
            <input type="text" placeholder="Search students or assignments..."
              className="w-full pl-10 pr-4 py-2 bg-stone-100 border-none rounded-xl text-sm focus:ring-2 focus:ring-emerald-500/20" />
          </div>
          <div className="flex items-center gap-4">
            <button className="p-2 text-stone-400 hover:text-stone-600 relative">
              <Bell className="w-5 h-5" />
              <span className="absolute top-2 right-2 w-2 h-2 bg-red-500 rounded-full border-2 border-white" />
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
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                      {assignments.length === 0 ? (
                        <div className="col-span-full py-12 text-center bg-white rounded-3xl border border-dashed border-stone-200">
                          <p className="text-stone-400">No assignments yet.</p>
                        </div>
                      ) : assignments.map(a => (
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
              {activeTab === 'settings' && <SettingsPanel educatorId={educator.id} />}
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

const TEST_STUDENTS = [
  { name: 'Ashraf (ZC)', email: 'abadawi@zewailcity.edu.eg', studentId: 'test-zc-001' },
  { name: 'Ashraf (UPM)', email: 'a.badawi@upm.edu.sa', studentId: 'test-upm-002' },
  { name: 'Ashraf (Gmail)', email: 'ashraf.badawi@gmail.com', studentId: 'test-gmail-003' },
];

const REAL_COURSES = [
  { name: 'CSAI-490: Selected Topics in Computational Sciences', institutionId: 'zewail-city', defaultQuestionCount: 12 },
  { name: 'ITNS-407: IT Audit and Risk Management', institutionId: 'zewail-city', defaultQuestionCount: 10 },
  { name: 'CSAI-499: Senior Project Part 2', institutionId: 'zewail-city', defaultQuestionCount: 8 },
  { name: 'CS-224: Computer Architecture (Monday Section)', institutionId: 'upm', defaultQuestionCount: 12 },
  { name: 'CS-224: Computer Architecture (Friday Section)', institutionId: 'upm', defaultQuestionCount: 12 },
  { name: 'AI-372: AI Ethics & Professionalism', institutionId: 'upm', defaultQuestionCount: 10 },
];

function SettingsPanel({ educatorId }: { educatorId: string }) {
  const storageKey = `teachaid_settings_${educatorId}`;
  const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');

  const [defaultCaptureMode, setDefaultCaptureMode] = useState<'Snapshot' | 'Video'>(saved.defaultCaptureMode ?? 'Snapshot');
  const [defaultQuestionCount, setDefaultQuestionCount] = useState<number>(saved.defaultQuestionCount ?? 12);
  const [defaultResponseTime, setDefaultResponseTime] = useState<number>(saved.defaultResponseTime ?? 60);
  const [testingMode, setTestingMode] = useState<boolean>(saved.testingMode ?? false);
  const [saved_, setSaved_] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [seedLinks, setSeedLinks] = useState<{ name: string; email: string; url: string }[] | null>(null);
  const [seedError, setSeedError] = useState<string | null>(null);
  const [seedingCourses, setSeedingCourses] = useState(false);
  const [coursesSeeded, setCoursesSeeded] = useState(false);
  const [courseSeedError, setCourseSeedError] = useState<string | null>(null);

  const seedTestData = async () => {
    setSeeding(true);
    setSeedError(null);
    setSeedLinks(null);
    try {
      console.log('[seed] step 1: create course');
      const courseRef = await addDoc(collection(db, 'courses'), {
        name: 'Test Interview Class', description: 'Seed data for testing the student interview flow.',
        educatorId, institutionId: 'ashraf-institution', defaultLanguagePair: 'en',
        defaultQuestionCount: 3, defaultCaptureMode: 'Snapshot', createdAt: serverTimestamp(),
      });
      console.log('[seed] step 1 OK:', courseRef.id);

      const windowOpen = new Date().toISOString();
      const windowClose = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      console.log('[seed] step 2: create assignment');
      const assignmentRef = await addDoc(collection(db, 'assignments'), {
        title: 'Test: Sample Interview Assignment', courseId: courseRef.id, educatorId,
        windowOpen, windowClose, questionCount: 3, questionMode: 'Manual', responseTimeLimit: 60,
        captureMode: 'Snapshot', status: 'Active', createdAt: serverTimestamp(),
      });
      console.log('[seed] step 2 OK:', assignmentRef.id);

      console.log('[seed] step 3: create questions');
      for (const [i, q] of [
        { textEn: 'Please introduce yourself and briefly describe your academic background.', textAr: 'يرجى تقديم نفسك ووصف خلفيتك الأكاديمية باختصار.' },
        { textEn: 'Describe the main idea of a recent assignment or project you worked on.', textAr: 'صف الفكرة الرئيسية لمشروع أو تكليف أخير عملت عليه.' },
        { textEn: 'What was the most challenging part of that work, and how did you handle it?', textAr: 'ما هو الجزء الأصعب في ذلك العمل، وكيف تعاملت معه؟' },
      ].entries()) {
        await addDoc(collection(db, 'assignments', assignmentRef.id, 'questions'), { ...q, order: i });
        console.log('[seed] question', i, 'OK');
      }

      console.log('[seed] step 4: create students + tokens');
      const links: { name: string; email: string; url: string }[] = [];
      for (const s of TEST_STUDENTS) {
        const studentRef = await addDoc(collection(db, 'students'), {
          name: s.name, email: s.email, studentId: s.studentId,
          institutionId: educatorId, courseId: courseRef.id, createdAt: serverTimestamp(),
        });
        const rawToken = crypto.randomUUID();
        const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawToken));
        const tokenHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
        await addDoc(collection(db, 'inviteTokens'), {
          studentId: studentRef.id, assignmentId: assignmentRef.id, tokenHash,
          expiry: windowClose, issuedBy: educatorId, createdAt: serverTimestamp(),
        });
        links.push({ name: s.name, email: s.email, url: `${window.location.origin}/?token=${rawToken}` });
      }
      setSeedLinks(links);
    } catch (err: any) {
      console.error('Seed error:', err);
      setSeedError(err?.message || 'Seeding failed. Check Firestore rules and console.');
    } finally {
      setSeeding(false);
    }
  };

  const seedCourses = async () => {
    setSeedingCourses(true);
    setCourseSeedError(null);
    try {
      for (const c of REAL_COURSES) {
        await addDoc(collection(db, 'courses'), {
          name: c.name, educatorId, institutionId: c.institutionId,
          defaultLanguagePair: 'en', defaultQuestionCount: c.defaultQuestionCount,
          defaultCaptureMode: 'Snapshot', createdAt: serverTimestamp(),
        });
      }
      setCoursesSeeded(true);
    } catch (err: any) {
      setCourseSeedError(err?.message || 'Failed to create courses.');
    } finally {
      setSeedingCourses(false);
    }
  };

  const handleSave = () => {
    localStorage.setItem(storageKey, JSON.stringify({ defaultCaptureMode, defaultQuestionCount, defaultResponseTime, testingMode }));
    setSaved_(true);
    setTimeout(() => setSaved_(false), 2000);
  };

  return (
    <div className="max-w-2xl space-y-8">
      <h2 className="text-2xl font-serif font-medium text-stone-900">Settings</h2>

      <section className="bg-white rounded-3xl border border-stone-200 p-6 space-y-6">
        <h3 className="text-sm font-bold text-stone-400 uppercase tracking-wider">Assignment Defaults</h3>
        <div>
          <label className="block text-sm font-medium text-stone-700 mb-2">Default Capture Mode</label>
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
          <label className="block text-sm font-medium text-stone-700 mb-1">
            Default Response Time Limit: <span className="text-emerald-600 font-bold">{defaultResponseTime}s</span>
          </label>
          <input type="range" min="30" max="180" step="15" value={defaultResponseTime}
            onChange={e => setDefaultResponseTime(parseInt(e.target.value))}
            className="w-full accent-emerald-600 max-w-xs" />
          <div className="flex justify-between text-xs text-stone-400 mt-1 max-w-xs"><span>30s</span><span>3m</span></div>
        </div>
      </section>

      <section className="bg-white rounded-3xl border border-stone-200 p-6 space-y-4">
        <h3 className="text-sm font-bold text-stone-400 uppercase tracking-wider">Developer</h3>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-stone-700">Testing Mode</p>
            <p className="text-xs text-stone-400 mt-0.5">Reduces timers to 5 seconds. Do not enable in production.</p>
          </div>
          <button onClick={() => setTestingMode(v => !v)}
            className={cn('relative w-12 h-6 rounded-full transition-colors', testingMode ? 'bg-amber-500' : 'bg-stone-200')}>
            <span className={cn('absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-all', testingMode ? 'left-7' : 'left-1')} />
          </button>
        </div>
        {testingMode && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3">
            <p className="text-xs text-amber-700 font-medium">Testing Mode is ON — all interview timers run at 5 seconds.</p>
          </div>
        )}
      </section>

      <section className="bg-white rounded-3xl border border-stone-200 p-6 space-y-4">
        <h3 className="text-sm font-bold text-stone-400 uppercase tracking-wider">My Courses</h3>
        <p className="text-xs text-stone-500 leading-relaxed">
          Creates all 6 courses: CSAI-490, ITNS-407, CSAI-499, CS-224 (Monday), CS-224 (Friday), and AI-372.
          Safe to run once — does not check for duplicates.
        </p>
        {courseSeedError && <p className="text-xs text-red-600">{courseSeedError}</p>}
        {coursesSeeded ? (
          <p className="text-xs text-emerald-700 font-medium">All 6 courses created. Go to the Courses tab.</p>
        ) : (
          <button onClick={seedCourses} disabled={seedingCourses}
            className="flex items-center gap-2 bg-emerald-700 text-white px-5 py-2.5 rounded-2xl text-sm font-medium hover:bg-emerald-600 disabled:opacity-50">
            {seedingCourses && <Loader2 className="w-4 h-4 animate-spin" />}
            {seedingCourses ? 'Creating courses…' : 'Create My 6 Courses'}
          </button>
        )}
      </section>

      <section className="bg-white rounded-3xl border border-stone-200 p-6 space-y-4">
        <h3 className="text-sm font-bold text-stone-400 uppercase tracking-wider">Test Data</h3>
        <p className="text-xs text-stone-500 leading-relaxed">
          Creates a "Test Interview Class" with a 3-question assignment and invite links for 3 test accounts. Links are valid 7 days.
        </p>
        {seedError && <p className="text-xs text-red-600">{seedError}</p>}
        {seedLinks ? (
          <div className="space-y-3">
            <p className="text-xs font-semibold text-emerald-700">Test links generated:</p>
            {seedLinks.map(l => (
              <div key={l.email} className="bg-stone-50 border border-stone-100 rounded-2xl p-3">
                <p className="text-xs font-medium text-stone-700 mb-1">{l.name} — {l.email}</p>
                <input readOnly value={l.url} onClick={e => (e.target as HTMLInputElement).select()}
                  className="w-full text-xs font-mono bg-white border border-stone-200 rounded-xl px-3 py-2 text-stone-600 cursor-text focus:outline-none" />
              </div>
            ))}
            <p className="text-xs text-stone-400">Click each URL field to select, then copy.</p>
          </div>
        ) : (
          <button onClick={seedTestData} disabled={seeding}
            className="flex items-center gap-2 bg-stone-700 text-white px-5 py-2.5 rounded-2xl text-sm font-medium hover:bg-stone-600 disabled:opacity-50">
            {seeding && <Loader2 className="w-4 h-4 animate-spin" />}
            {seeding ? 'Creating test data…' : 'Create Test Class + Links'}
          </button>
        )}
      </section>

      <button onClick={handleSave}
        className="flex items-center gap-2 bg-stone-900 text-white px-6 py-3 rounded-2xl text-sm font-medium hover:bg-stone-800 transition-colors">
        <Save className="w-4 h-4" />
        {saved_ ? 'Saved!' : 'Save Settings'}
      </button>
    </div>
  );
}
