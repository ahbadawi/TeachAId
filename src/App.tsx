import { useState, useEffect } from 'react';
import { auth, db } from './firebase';
import { onAuthStateChanged, User } from 'firebase/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import EducatorDashboard from './components/EducatorDashboard';
import StudentPortal from './components/StudentPortal';
import Auth from './components/Auth';
import { Educator } from './types';
import { Loader2 } from 'lucide-react';

// Only this account can access the educator dashboard
const OWNER_EMAILS = ['ashraf.badawi@gmail.com'];

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [educator, setEducator] = useState<Educator | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'educator' | 'student'>('educator');
  const [studentToken, setStudentToken] = useState<string | null>(null);

  const handleSignOut = () => {
    localStorage.removeItem('teachaid_dev_session');
    setEducator(null);
    setUser(null);
    auth.signOut().catch(() => {});
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (token) { setView('student'); setStudentToken(token); }

    const devSessionRaw = localStorage.getItem('teachaid_dev_session');
    if (devSessionRaw) {
      try { setEducator(JSON.parse(devSessionRaw)); } catch { localStorage.removeItem('teachaid_dev_session'); }
      setLoading(false);
      return;
    }

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      if (firebaseUser) {
        const educatorDoc = await getDoc(doc(db, 'educators', firebaseUser.uid));
        if (educatorDoc.exists()) {
          setEducator({ id: firebaseUser.uid, ...educatorDoc.data() } as Educator);
        } else if (OWNER_EMAILS.includes(firebaseUser.email ?? '')) {
          const newEducator: Educator = {
            id: firebaseUser.uid,
            name: firebaseUser.displayName || 'Ashraf Badawi',
            email: firebaseUser.email!,
            institutionId: 'ashraf-institution',
            role: 'Admin',
          };
          await setDoc(doc(db, 'educators', firebaseUser.uid), newEducator);
          setEducator(newEducator);
        }
      } else {
        setEducator(null);
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-stone-50">
        <Loader2 className="w-8 h-8 animate-spin text-emerald-600" />
      </div>
    );
  }

  if (view === 'student' && studentToken) return <StudentPortal token={studentToken} />;

  if (!user && !educator) {
    return <Auth onDevLogin={(devEducator) => { setEducator(devEducator); setLoading(false); }} />;
  }

  if (!educator) {
    return (
      <div className="min-h-screen bg-stone-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white p-8 rounded-3xl shadow-xl text-center">
          <h2 className="text-xl font-medium text-stone-900 mb-2">Access Restricted</h2>
          <p className="text-stone-500 mb-6">Your account is not authorized to access the educator dashboard.</p>
          <button onClick={handleSignOut} className="w-full bg-stone-900 text-white py-3 rounded-xl font-medium">
            Sign Out
          </button>
        </div>
      </div>
    );
  }

  return <EducatorDashboard educator={educator} onSignOut={handleSignOut} />;
}
