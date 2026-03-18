import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, orderBy, limit, onSnapshot } from 'firebase/firestore';
import { AuditLog } from '../types';
import { History, User, Activity, Clock } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

export default function AuditLogs() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(collection(db, 'auditLogs'), orderBy('serverTimestamp', 'desc'), limit(50));
    return onSnapshot(q, (snapshot) => {
      setLogs(snapshot.docs.map(d => ({ id: d.id, ...d.data() } as AuditLog)));
      setLoading(false);
    });
  }, []);

  if (loading) return <div className="p-8 text-center text-stone-400">Loading logs...</div>;

  return (
    <div className="bg-white rounded-[32px] border border-stone-100 overflow-hidden shadow-sm">
      <div className="p-6 border-b border-stone-100 bg-stone-50/50">
        <h3 className="text-lg font-serif font-medium text-stone-900 flex items-center gap-2">
          <History className="w-5 h-5 text-emerald-600" />
          System Audit Logs
        </h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="text-[10px] font-bold uppercase tracking-widest text-stone-400 border-b border-stone-50">
              <th className="px-6 py-4">Timestamp</th>
              <th className="px-6 py-4">Action</th>
              <th className="px-6 py-4">User</th>
              <th className="px-6 py-4">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-50">
            {logs.map((log) => (
              <tr key={log.id} className="hover:bg-stone-50 transition-colors">
                <td className="px-6 py-4 text-xs text-stone-500 whitespace-nowrap">
                  <div className="flex items-center gap-2">
                    <Clock className="w-3 h-3" />
                    {log.timestamp ? formatDistanceToNow(new Date(log.timestamp), { addSuffix: true }) : 'Just now'}
                  </div>
                </td>
                <td className="px-6 py-4">
                  <span className="px-2 py-1 bg-emerald-50 text-emerald-700 text-[10px] font-bold rounded-md uppercase tracking-wider">
                    {log.action}
                  </span>
                </td>
                <td className="px-6 py-4 text-xs text-stone-600 font-medium">
                  <div className="flex items-center gap-2">
                    <User className="w-3 h-3 text-stone-400" />
                    {log.userId}
                  </div>
                </td>
                <td className="px-6 py-4 text-xs text-stone-500 max-w-xs truncate">
                  {log.details}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
