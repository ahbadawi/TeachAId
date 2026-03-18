import { auth } from '../firebase';
import { GoogleAuthProvider, signInWithPopup } from 'firebase/auth';
import { LogIn, ShieldCheck, FlaskConical } from 'lucide-react';
import { motion } from 'motion/react';
import { Educator } from '../types';

interface Props {
  onDevLogin?: (educator: Educator) => void;
}

export default function Auth({ onDevLogin }: Props) {
  const handleLogin = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error('Login failed:', error);
    }
  };

  const handleDevLogin = () => {
    onDevLogin?.({
      id: 'dev-educator-001',
      name: 'Dev Educator',
      email: 'dev@teachaid.local',
      institutionId: 'dev-institution',
      role: 'Admin',
    });
  };

  return (
    <div className="min-h-screen bg-stone-50 flex flex-col items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-md w-full bg-white rounded-3xl shadow-xl shadow-stone-200/50 p-8 border border-stone-100"
      >
        <div className="flex flex-col items-center text-center mb-8">
          <div className="w-16 h-16 bg-emerald-100 rounded-2xl flex items-center justify-center mb-4">
            <ShieldCheck className="w-8 h-8 text-emerald-600" />
          </div>
          <h1 className="text-3xl font-serif font-medium text-stone-900 mb-2">TeachAId</h1>
          <p className="text-stone-500">AI-Powered Academic Integrity Interview Platform</p>
        </div>

        <button
          onClick={handleLogin}
          className="w-full flex items-center justify-center gap-3 bg-stone-900 text-white py-4 rounded-2xl hover:bg-stone-800 transition-colors font-medium"
        >
          <LogIn className="w-5 h-5" />
          Sign in with Google
        </button>

        {import.meta.env.DEV && (
          <button
            onClick={handleDevLogin}
            className="mt-3 w-full flex items-center justify-center gap-3 bg-amber-500 text-white py-3 rounded-2xl hover:bg-amber-600 transition-colors font-medium text-sm"
          >
            <FlaskConical className="w-4 h-4" />
            Dev Login (bypass auth)
          </button>
        )}

        <div className="mt-8 pt-8 border-t border-stone-100 text-center">
          <p className="text-xs text-stone-400 uppercase tracking-widest font-medium">
            Educator & Admin Access Only
          </p>
        </div>
      </motion.div>
    </div>
  );
}
