import { useState } from 'react';
import { db } from '../firebase';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { X, Loader2 } from 'lucide-react';
import { motion } from 'motion/react';
import { logAudit } from '../lib/audit';

interface Props {
  onClose: () => void;
  educatorId: string;
  institutionId: string;
}

export default function CreateCourse({ onClose, educatorId, institutionId }: Props) {
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name) return;

    setLoading(true);
    try {
      await addDoc(collection(db, 'courses'), {
        name,
        educatorId,
        institutionId,
        defaultLanguagePair: 'English + Arabic',
        defaultQuestionCount: 12,
        defaultCaptureMode: 'Snapshot',
        createdAt: serverTimestamp()
      });

      await logAudit('Course Created', `Course "${name}" created`, educatorId);
      onClose();
    } catch (error) {
      console.error('Failed to create course:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-stone-900/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-white w-full max-w-md rounded-[32px] shadow-2xl overflow-hidden"
      >
        <div className="p-6 border-b border-stone-100 flex justify-between items-center">
          <h2 className="text-xl font-serif font-medium text-stone-900">New Course</h2>
          <button onClick={onClose} className="p-2 hover:bg-stone-100 rounded-full transition-colors">
            <X className="w-5 h-5 text-stone-400" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-8 space-y-6">
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">Course Name</label>
            <input 
              required
              autoFocus
              type="text" 
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Introduction to Computer Science"
              className="w-full px-4 py-3 bg-stone-50 border border-stone-200 rounded-2xl focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
            />
          </div>

          <div className="pt-4">
            <button 
              disabled={loading || !name}
              className="w-full bg-stone-900 text-white py-4 rounded-2xl font-medium hover:bg-stone-800 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {loading && <Loader2 className="w-5 h-5 animate-spin" />}
              Create Course
            </button>
          </div>
        </form>
      </motion.div>
    </div>
  );
}
