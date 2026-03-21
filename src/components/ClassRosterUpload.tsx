import { useState, useRef, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { db } from '../firebase';
import { collection, addDoc, serverTimestamp, getDocs, query, where } from 'firebase/firestore';
import { Upload, CheckCircle2, AlertCircle, X, Loader2, Users } from 'lucide-react';
import { cn } from '../lib/utils';

interface ParsedRow {
  rowNum: number;
  studentId: string;   // alphanumeric university ID — primary unique key
  name: string;
  email: string;
  errors: string[];
  duplicate?: 'file' | 'roster'; // why it's flagged
}

interface Props {
  courseId: string;
  educatorId: string;
  assignmentId?: string;
  scope?: 'course' | 'assignment';
  onClose: () => void;
  onUploaded: (count: number) => void;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const STUDENT_ID_RE = /^[a-zA-Z0-9\-_]{2,20}$/;

function normalizeHeader(h: unknown): string {
  return String(h ?? '').toLowerCase().trim().replace(/[^a-z0-9]/g, '');
}

function emailScore(values: string[]): number {
  const nonEmpty = values.filter(v => v.length > 0);
  if (!nonEmpty.length) return 0;
  return nonEmpty.filter(v => v.includes('@') && v.includes('.')).length / nonEmpty.length;
}

function studentIdScore(header: string, values: string[]): number {
  const h = normalizeHeader(header);
  const headerHint = ['studentid', 'id', 'stuid', 'sid', 'matricno', 'matric', 'universityid', 'rollno', 'roll'].some(k => h === k || h.includes(k)) ? 0.5 : 0;
  const nonEmpty = values.filter(v => v.length > 0);
  if (!nonEmpty.length) return headerHint;
  // Student IDs: short alphanumeric, no spaces, no @
  const idLike = nonEmpty.filter(v => !v.includes('@') && STUDENT_ID_RE.test(v.replace(/\s/g, ''))).length;
  return headerHint + 0.5 * (idLike / nonEmpty.length);
}

function nameScore(header: string, values: string[], excludeCols: number[], colIdx: number): number {
  if (excludeCols.includes(colIdx)) return 0;
  const h = normalizeHeader(header);
  const headerHint = ['name', 'student', 'fullname', 'firstname', 'lastname', 'first', 'last', 'studentname'].some(k => h.includes(k)) ? 0.4 : 0;
  const nonEmpty = values.filter(v => v.length > 0);
  if (!nonEmpty.length) return headerHint;
  const nameLike = nonEmpty.filter(v => !v.includes('@') && /^[a-zA-Z\u0600-\u06FF '\-\.]{2,60}$/.test(v)).length;
  return headerHint + 0.6 * (nameLike / nonEmpty.length);
}

export default function ClassRosterUpload({
  courseId, educatorId, assignmentId, scope = 'course', onClose, onUploaded,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<ParsedRow[] | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedCount, setSavedCount] = useState<number | null>(null);
  const [existingIds, setExistingIds] = useState<Set<string>>(new Set());
  const [existingCount, setExistingCount] = useState(0);

  useEffect(() => {
    const q = query(collection(db, 'students'), where('courseId', '==', courseId));
    getDocs(q).then(snap => {
      const ids = new Set(snap.docs.map(d => String(d.data().studentId || '').trim().toLowerCase()));
      setExistingIds(ids);
      setExistingCount(snap.size);
    }).catch(() => {});
  }, [courseId]);

  const validRows = rows?.filter(r => r.errors.length === 0) ?? [];
  const invalidRows = rows?.filter(r => r.errors.length > 0) ?? [];

  const parseFile = (file: File) => {
    setParseError(null);
    setRows(null);
    setSavedCount(null);

    const ext = file.name.split('.').pop()?.toLowerCase();
    if (!['xls', 'xlsx', 'csv'].includes(ext ?? '')) {
      setParseError('Unsupported file type. Please upload .xls, .xlsx, or .csv.');
      return;
    }

    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const raw: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

        if (raw.length < 2) {
          setParseError('File is empty or has only a header row.');
          return;
        }

        const headerRow = raw[0] as unknown[];
        const numCols = headerRow.length;
        const colValues: string[][] = Array.from({ length: numCols }, (_, ci) =>
          raw.slice(1).map(r => String((r as unknown[])[ci] ?? '').trim())
        );

        // Detect columns
        const emailScores = colValues.map(v => emailScore(v));
        const emailIdx = emailScores.indexOf(Math.max(...emailScores));
        if (emailScores[emailIdx] < 0.3) {
          setParseError(`Could not find an email column. Columns found: [${headerRow.join(', ')}]`);
          return;
        }

        const idScores = headerRow.map((h, ci) => ci === emailIdx ? 0 : studentIdScore(String(h), colValues[ci]));
        const idIdx = idScores.indexOf(Math.max(...idScores));
        const hasIdCol = idScores[idIdx] > 0.2;

        const nameScores = headerRow.map((h, ci) =>
          nameScore(String(h), colValues[ci], [emailIdx, hasIdCol ? idIdx : -1], ci)
        );
        const nameIdx = nameScores.indexOf(Math.max(...nameScores));
        if (nameScores[nameIdx] < 0.1) {
          setParseError(`Could not find a name column. Columns found: [${headerRow.join(', ')}]`);
          return;
        }

        // First/last name split detection
        const firstIdx = headerRow.findIndex((h, ci) => {
          const nh = normalizeHeader(h);
          return ci !== emailIdx && ci !== (hasIdCol ? idIdx : -1) && (nh === 'first' || nh === 'firstname' || nh.startsWith('first'));
        });
        const lastIdx = headerRow.findIndex((h, ci) => {
          const nh = normalizeHeader(h);
          return ci !== emailIdx && ci !== firstIdx && ci !== (hasIdCol ? idIdx : -1) && (nh === 'last' || nh === 'lastname' || nh.startsWith('last'));
        });
        const useSplit = firstIdx !== -1 && lastIdx !== -1;

        const seenIds = new Set<string>();
        const seenEmails = new Set<string>();
        const parsed: ParsedRow[] = [];

        for (let i = 1; i < raw.length; i++) {
          const row = raw[i] as unknown[];
          const name = useSplit
            ? `${String(row[firstIdx] ?? '').trim()} ${String(row[lastIdx] ?? '').trim()}`.trim()
            : String(row[nameIdx] ?? '').trim();
          const email = String(row[emailIdx] ?? '').trim().toLowerCase();
          // Student ID: use detected column or fall back to email prefix
          const rawId = hasIdCol ? String(row[idIdx] ?? '').trim() : '';
          const studentId = rawId || email.split('@')[0]; // fallback to email prefix
          const errors: string[] = [];
          let duplicate: ParsedRow['duplicate'];

          if (!name) errors.push('Name is empty');

          if (!email) {
            errors.push('Email is empty');
          } else if (!EMAIL_RE.test(email)) {
            errors.push(`Invalid email: "${email}"`);
          } else if (seenEmails.has(email)) {
            errors.push(`Duplicate email in file: "${email}"`);
          } else {
            seenEmails.add(email);
          }

          if (!studentId) {
            errors.push('Student ID is empty');
          } else {
            const idLower = studentId.toLowerCase();
            if (seenIds.has(idLower)) {
              errors.push(`Duplicate student ID in file: "${studentId}"`);
              duplicate = 'file';
            } else if (existingIds.has(idLower)) {
              errors.push(`Student ID already in roster: "${studentId}"`);
              duplicate = 'roster';
            } else {
              seenIds.add(idLower);
            }
          }

          if (!name && !email && !rawId) continue;
          parsed.push({ rowNum: i + 1, studentId, name, email, errors, duplicate });
        }

        if (parsed.length === 0) {
          setParseError('No data rows found.');
          return;
        }

        if (!hasIdCol) {
          setParseError(null); // not an error, just informational
          // Show warning in UI via state
        }

        setRows(parsed);
      } catch (err: any) {
        setParseError(`Failed to parse file: ${err?.message ?? 'Unknown error'}`);
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) parseFile(file);
  };

  const handleSave = async () => {
    if (!validRows.length) return;
    setSaving(true);
    try {
      for (const row of validRows) {
        const studentData: Record<string, any> = {
          name: row.name,
          email: row.email,
          studentId: row.studentId,
          courseId,
          institutionId: educatorId,
          createdAt: serverTimestamp(),
        };
        if (scope === 'assignment' && assignmentId) {
          studentData.assignmentIds = [assignmentId];
        }
        await addDoc(collection(db, 'students'), studentData);
      }
      setSavedCount(validRows.length);
      onUploaded(validRows.length);
    } catch (err: any) {
      setParseError(`Failed to save students: ${err?.message}`);
    } finally {
      setSaving(false);
    }
  };

  const isEmbedded = scope === 'assignment';

  return (
    <div className={cn(!isEmbedded && 'fixed inset-0 bg-stone-900/40 backdrop-blur-sm flex items-center justify-center p-4 z-50')}>
      <div className={cn('bg-white rounded-[32px] shadow-2xl overflow-hidden flex flex-col', isEmbedded ? 'w-full' : 'w-full max-w-2xl max-h-[90vh]')}>

        {!isEmbedded && (
          <div className="p-6 border-b border-stone-100 flex justify-between items-center shrink-0">
            <div className="flex items-center gap-3">
              <Users className="w-5 h-5 text-emerald-600" />
              <div>
                <h2 className="text-xl font-serif font-medium text-stone-900">Upload Class Roster</h2>
                {existingCount > 0 && <p className="text-xs text-stone-500 mt-0.5">{existingCount} students already in this course</p>}
              </div>
            </div>
            <button onClick={onClose} className="p-2 hover:bg-stone-100 rounded-full"><X className="w-5 h-5 text-stone-400" /></button>
          </div>
        )}

        <div className={cn('overflow-y-auto flex-1 space-y-5', isEmbedded ? 'p-0' : 'p-6')}>
          {!rows && (
            <>
              <p className="text-xs text-stone-500">
                Upload an Excel or CSV file. Required columns: <strong>Student ID</strong>, <strong>Name</strong>, <strong>Email</strong>.
                Student ID is the unique identifier — duplicates already in the roster will be rejected.
              </p>
              <div
                onDragOver={e => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
                onClick={() => inputRef.current?.click()}
                className={cn('border-2 border-dashed rounded-3xl p-10 text-center cursor-pointer transition-all',
                  dragging ? 'border-emerald-400 bg-emerald-50' : 'border-stone-200 hover:border-stone-300 hover:bg-stone-50')}
              >
                <Upload className={cn('w-8 h-8 mx-auto mb-3', dragging ? 'text-emerald-500' : 'text-stone-300')} />
                <p className="text-sm font-medium text-stone-600">Drop your file here, or click to browse</p>
                <p className="text-xs text-stone-400 mt-1">Accepts .xls, .xlsx, .csv</p>
                <input ref={inputRef} type="file" accept=".xls,.xlsx,.csv" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) parseFile(f); }} />
              </div>
              {parseError && (
                <div className="flex gap-2 bg-red-50 border border-red-200 rounded-2xl px-4 py-3">
                  <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                  <p className="text-xs text-red-700">{parseError}</p>
                </div>
              )}
            </>
          )}

          {rows && savedCount === null && (
            <>
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-stone-700"><span className="font-mono">{fileName}</span> — {rows.length} rows</p>
                <button onClick={() => { setRows(null); setFileName(null); setParseError(null); if (inputRef.current) inputRef.current.value = ''; }}
                  className="text-xs text-stone-400 hover:text-stone-600 underline">Change file</button>
              </div>

              <div className="flex gap-2 flex-wrap">
                <span className="inline-flex items-center gap-1.5 text-xs font-medium bg-emerald-50 text-emerald-700 px-3 py-1.5 rounded-full">
                  <CheckCircle2 className="w-3.5 h-3.5" /> {validRows.length} will be added
                </span>
                {invalidRows.length > 0 && (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium bg-red-50 text-red-700 px-3 py-1.5 rounded-full">
                    <AlertCircle className="w-3.5 h-3.5" /> {invalidRows.length} skipped
                  </span>
                )}
                {existingCount > 0 && (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium bg-stone-100 text-stone-500 px-3 py-1.5 rounded-full">
                    <Users className="w-3.5 h-3.5" /> {existingCount} already in course
                  </span>
                )}
              </div>

              <div className="border border-stone-100 rounded-2xl overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-stone-50 text-stone-500">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium w-8">#</th>
                      <th className="px-3 py-2 text-left font-medium">Student ID</th>
                      <th className="px-3 py-2 text-left font-medium">Name</th>
                      <th className="px-3 py-2 text-left font-medium">Email</th>
                      <th className="px-3 py-2 text-left font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-50">
                    {rows.map(row => (
                      <tr key={row.rowNum} className={cn(
                        row.errors.length > 0
                          ? row.duplicate === 'roster' ? 'bg-amber-50/60' : 'bg-red-50/60'
                          : ''
                      )}>
                        <td className="px-3 py-2 text-stone-400">{row.rowNum}</td>
                        <td className="px-3 py-2 font-mono text-stone-700">{row.studentId || <span className="text-stone-300 italic">—</span>}</td>
                        <td className="px-3 py-2 text-stone-800">{row.name || <span className="text-stone-300 italic">empty</span>}</td>
                        <td className="px-3 py-2 font-mono text-stone-600">{row.email || <span className="text-stone-300 italic">empty</span>}</td>
                        <td className="px-3 py-2">
                          {row.errors.length === 0 ? (
                            <span className="inline-flex items-center gap-1 text-emerald-600"><CheckCircle2 className="w-3 h-3" /> OK</span>
                          ) : row.duplicate === 'roster' ? (
                            <span className="inline-flex items-start gap-1 text-amber-600">
                              <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" /><span>Already in roster</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-start gap-1 text-red-600">
                              <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" /><span>{row.errors.join('; ')}</span>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {invalidRows.length > 0 && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-2xl px-4 py-3">
                  {invalidRows.length} row{invalidRows.length > 1 ? 's' : ''} will be skipped. Only {validRows.length} valid row{validRows.length !== 1 ? 's' : ''} will be saved.
                </p>
              )}
            </>
          )}

          {savedCount !== null && (
            <div className="text-center py-8 space-y-3">
              <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto" />
              <p className="text-lg font-medium text-stone-800">{savedCount} students added</p>
              <p className="text-xs font-bold text-emerald-600">Total in course: {existingCount + savedCount}</p>
            </div>
          )}
        </div>

        <div className={cn('border-t border-stone-100 flex justify-end gap-3 shrink-0', isEmbedded ? 'p-4 mt-4' : 'p-6')}>
          {savedCount !== null ? (
            <button onClick={onClose} className="bg-stone-900 text-white px-6 py-2.5 rounded-2xl text-sm font-medium hover:bg-stone-800">Done</button>
          ) : rows ? (
            <>
              <button onClick={onClose} className="px-5 py-2.5 rounded-2xl text-sm font-medium text-stone-600 hover:bg-stone-100">Cancel</button>
              <button onClick={handleSave} disabled={saving || validRows.length === 0}
                className="flex items-center gap-2 bg-emerald-700 text-white px-6 py-2.5 rounded-2xl text-sm font-medium hover:bg-emerald-600 disabled:opacity-50">
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                {saving ? 'Saving…' : `Add ${validRows.length} Student${validRows.length !== 1 ? 's' : ''}`}
              </button>
            </>
          ) : (
            <button onClick={onClose} className="px-5 py-2.5 rounded-2xl text-sm font-medium text-stone-600 hover:bg-stone-100">Cancel</button>
          )}
        </div>
      </div>
    </div>
  );
}
