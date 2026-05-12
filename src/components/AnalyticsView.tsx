import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { Assignment, Course, InterviewSession, AnalysisReport } from '../types';
import { Loader2 } from 'lucide-react';
import { cn } from '../lib/utils';

interface Props {
  assignments: Assignment[];
  sessions: InterviewSession[];
  courses: Course[];
}

interface AssignmentAnalytics {
  assignment: Assignment;
  courseName: string;
  total: number;
  submitted: number;
  interviewed: number;
  reviewed: number;
  high: number;
  medium: number;
  low: number;
  accept: number;
  followUp: number;
  escalate: number;
}

export default function AnalyticsView({ assignments, sessions, courses }: Props) {
  const [reports, setReports] = useState<AnalysisReport[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const sessionIds = sessions
      .filter(s => ['AWAITING_REVIEW', 'REVIEWED'].includes(s.status))
      .map(s => s.id);

    if (!sessionIds.length) { setLoading(false); return; }

    // Firestore 'in' operator supports max 30 items — batch into chunks
    const chunks: string[][] = [];
    for (let i = 0; i < sessionIds.length; i += 30) chunks.push(sessionIds.slice(i, i + 30));

    Promise.all(
      chunks.map(chunk =>
        getDocs(query(collection(db, 'analysisReports'), where('sessionId', 'in', chunk)))
      )
    ).then(snaps => {
      setReports(snaps.flatMap(snap => snap.docs.map(d => ({ id: d.id, ...d.data() } as AnalysisReport))));
    }).catch(() => {
      setReports([]);
    }).finally(() => setLoading(false));
  }, [sessions.length]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="w-6 h-6 animate-spin text-stone-300" />
      </div>
    );
  }

  if (!assignments.length) {
    return (
      <div className="py-20 text-center text-stone-400 text-sm">No assignments yet.</div>
    );
  }

  const data: AssignmentAnalytics[] = assignments.map(a => {
    const asSessions = sessions.filter(s => s.assignmentId === a.id);
    const asReports  = reports.filter(r => asSessions.some(s => s.id === r.sessionId));

    return {
      assignment: a,
      courseName: courses.find(c => c.id === a.courseId)?.name ?? '',
      total:       asSessions.length,
      submitted:   asSessions.filter(s => s.workFileUrl || s.status !== 'NOT_STARTED').length,
      interviewed: asSessions.filter(s => ['AWAITING_REVIEW','REVIEWED','AWAITING_PROCESSING','INCOMPLETE'].includes(s.status)).length,
      reviewed:    asSessions.filter(s => s.status === 'REVIEWED').length,
      high:        asReports.filter(r => r.comprehensionLevel === 'High').length,
      medium:      asReports.filter(r => r.comprehensionLevel === 'Medium').length,
      low:         asReports.filter(r => r.comprehensionLevel === 'Low').length,
      accept:      asReports.filter(r => r.recommendedAction === 'Accept').length,
      followUp:    asReports.filter(r => r.recommendedAction === 'Schedule Follow-up').length,
      escalate:    asReports.filter(r => r.recommendedAction === 'Escalate for Review').length,
    };
  });

  // Class-level totals
  const totals = data.reduce((acc, d) => ({
    total:       acc.total       + d.total,
    interviewed: acc.interviewed + d.interviewed,
    reviewed:    acc.reviewed    + d.reviewed,
    high:        acc.high        + d.high,
    medium:      acc.medium      + d.medium,
    low:         acc.low         + d.low,
    escalate:    acc.escalate    + d.escalate,
  }), { total: 0, interviewed: 0, reviewed: 0, high: 0, medium: 0, low: 0, escalate: 0 });

  return (
    <div className="space-y-8">
      <div className="flex items-baseline gap-3">
        <h2 className="text-2xl font-serif font-medium text-stone-900">Analytics</h2>
        <span className="text-xs text-stone-400">{assignments.length} assignment{assignments.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Summary bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total students" value={totals.total} />
        <StatCard label="Interviewed"    value={totals.interviewed} of={totals.total} color="emerald" />
        <StatCard label="Reviewed"       value={totals.reviewed}    of={totals.interviewed} color="sky" />
        <StatCard label="Flagged"        value={totals.escalate}    of={totals.reviewed} color="red" />
      </div>

      {/* Per-assignment breakdown */}
      <div className="space-y-4">
        {data.map(d => (
          <div key={d.assignment.id} className="bg-white rounded-3xl border border-stone-200 p-6 space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="font-medium text-stone-900">{d.assignment.title}</h3>
                {d.courseName && <p className="text-xs text-stone-400 mt-0.5">{d.courseName}</p>}
              </div>
              <span className={cn('px-2 py-0.5 text-[10px] font-bold uppercase rounded-md',
                d.assignment.status === 'Active' ? 'bg-emerald-100 text-emerald-700' : 'bg-stone-100 text-stone-500')}>
                {d.assignment.status}
              </span>
            </div>

            {/* Progress pipeline */}
            <div className="grid grid-cols-4 gap-2 text-center">
              {[
                { label: 'Enrolled',    v: d.total },
                { label: 'Submitted',   v: d.submitted },
                { label: 'Interviewed', v: d.interviewed },
                { label: 'Reviewed',    v: d.reviewed },
              ].map(({ label, v }) => (
                <div key={label} className="bg-stone-50 rounded-2xl p-3">
                  <p className="text-xl font-bold text-stone-800">{v}</p>
                  <p className="text-[10px] text-stone-400 uppercase tracking-wide mt-0.5">{label}</p>
                </div>
              ))}
            </div>

            {/* Comprehension distribution */}
            {(d.high + d.medium + d.low) > 0 && (
              <div>
                <p className="text-xs font-semibold text-stone-500 uppercase tracking-wide mb-2">Comprehension</p>
                <CompBar
                  segments={[
                    { label: 'High',   count: d.high,   color: 'bg-emerald-500' },
                    { label: 'Medium', count: d.medium, color: 'bg-amber-400' },
                    { label: 'Low',    count: d.low,    color: 'bg-red-400' },
                  ]}
                />
              </div>
            )}

            {/* Action recommendations */}
            {(d.accept + d.followUp + d.escalate) > 0 && (
              <div>
                <p className="text-xs font-semibold text-stone-500 uppercase tracking-wide mb-2">Recommended Action</p>
                <CompBar
                  segments={[
                    { label: 'Accept',      count: d.accept,   color: 'bg-emerald-500' },
                    { label: 'Follow-up',   count: d.followUp, color: 'bg-amber-400' },
                    { label: 'Escalate',    count: d.escalate, color: 'bg-red-500' },
                  ]}
                />
              </div>
            )}

            {(d.high + d.medium + d.low) === 0 && (
              <p className="text-xs text-stone-400 italic">No processed reports yet for this assignment.</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function StatCard({ label, value, of: total, color }: {
  label: string; value: number; of?: number; color?: 'emerald' | 'sky' | 'red';
}) {
  const pct = total ? Math.round((value / total) * 100) : null;
  const colorClass = color === 'emerald' ? 'text-emerald-600' : color === 'sky' ? 'text-sky-600' : color === 'red' ? 'text-red-500' : 'text-stone-800';
  return (
    <div className="bg-white rounded-2xl border border-stone-200 p-4 text-center">
      <p className={cn('text-3xl font-bold', colorClass)}>{value}</p>
      <p className="text-xs text-stone-400 mt-1">{label}</p>
      {pct !== null && <p className="text-xs text-stone-300 mt-0.5">{pct}%</p>}
    </div>
  );
}

function CompBar({ segments }: { segments: { label: string; count: number; color: string }[] }) {
  const total = segments.reduce((s, g) => s + g.count, 0);
  if (!total) return null;
  return (
    <div className="space-y-1">
      <div className="flex h-2.5 rounded-full overflow-hidden gap-0.5">
        {segments.map(seg => seg.count > 0 && (
          <div key={seg.label} className={cn('rounded-full', seg.color)} style={{ width: `${(seg.count / total) * 100}%` }} />
        ))}
      </div>
      <div className="flex gap-4">
        {segments.map(seg => (
          <span key={seg.label} className="flex items-center gap-1 text-xs text-stone-500">
            <span className={cn('inline-block w-2 h-2 rounded-full', seg.color)} />
            {seg.count} {seg.label}
          </span>
        ))}
      </div>
    </div>
  );
}
