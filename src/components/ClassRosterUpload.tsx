import { useState, useRef } from 'react';
import * as XLSX from 'xlsx';
import { db } from '../firebase';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { Upload, CheckCircle2, AlertCircle, X, Loader2, Users } from 'lucide-react';
import { cn } from '../lib/utils';

interface ParsedRow {
  rowNum: number;
  name: string;
  email: string;
  errors: string[];
}

interface Props {
  courseId: string;
  educatorId: string;
  onClose: () => void;
  onUploaded: (count: number) => void;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normalizeHeader(h: unknown): string {
  return String(h ?? '').toLowerCase().trim().replace(/[^a-z]/g, '');
}

export default function ClassRosterUpload({ courseId, educatorId, onClose, onUploaded }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<ParsedRow[] | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedCount, setSavedCount] = useState<number | null>(null);

  const validRows = rows?.filter(r => r.errors.length === 0) ?? [];
  const invalidRows = rows?.filter(r => r.errors.length > 0) ?? [];

  const parseFile = (file: File) => {
    setParseError(null);
    setRows(null);
    setSavedCount(null);

    const ext = file.name.split('.').pop()?.toLowerCase();
    if (!['xls', 'xlsx', 'csv'].includes(ext ?? '')) {
      setParseError('Unsupported file type. Please upload an .xls, .xlsx, or .csv file.');
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
          setParseError('The file appears to be empty or has only one row. Expected a header row + data rows.');
          return;
        }

        // Detect header row
        const headers = (raw[0] as unknown[]).map(normalizeHeader);
        const nameIdx = headers.findIndex(h => ['name', 'fullname', 'studentname', 'firstname'].includes(h)
          || h.includes('name'));
        const emailIdx = headers.findIndex(h => h === 'email' || h.includes('email') || h.includes('mail'));

        if (nameIdx === -1 || emailIdx === -1) {
          setParseError(
            `Could not find required columns. Found headers: [${(raw[0] as unknown[]).join(', ')}]. ` +
            `Please ensure the file has a "Name" column and an "Email" column.`
          );
          return;
        }

        const seen = new Set<string>();
        const parsed: ParsedRow[] = [];

        for (let i = 1; i < raw.length; i++) {
          const row = raw[i] as unknown[];
          const name = String(row[nameIdx] ?? '').trim();
          const email = String(row[emailIdx] ?? '').trim().toLowerCase();
          const errors: string[] = [];

          if (!name) errors.push('Name is empty');
          if (!email) {
            errors.push('Email is empty');
          } else if (!EMAIL_RE.test(email)) {
            errors.push(`Invalid email format: "${email}"`);
          } else if (seen.has(email)) {
            errors.push(`Duplicate email: "${email}"`);
          } else {
            seen.add(email);
          }

          // Skip fully empty rows (both name and email blank)
          if (!name && !email) continue;

          parsed.push({ rowNum: i + 1, name, email, errors });
        }

        if (parsed.length === 0) {
          setParseError('No data rows found after the header. Is the file empty?');
          return;
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

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) parseFile(file);
  };

  const handleSave = async () => {
    if (!validRows.length) return;
    setSaving(true);
    try {
      for (const row of validRows) {
        await addDoc(collection(db, 'students'), {
          name: row.name,
          email: row.email,
          studentId: row.email,
          courseId,
          institutionId: educatorId,
          createdAt: serverTimestamp(),
        });
      }
      setSavedCount(validRows.length);
      onUploaded(validRows.length);
    } catch (err: any) {
      setParseError(`Failed to save students: ${err?.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-stone-900/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <div className="bg-white w-full max-w-2xl rounded-[32px] shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="p-6 border-b border-stone-100 flex justify-between items-center shrink-0">
          <div className="flex items-center gap-3">
            <Users className="w-5 h-5 text-emerald-600" />
            <h2 className="text-xl font-serif font-medium text-stone-900">Upload Class Roster</h2>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-stone-100 rounded-full transition-colors">
            <X className="w-5 h-5 text-stone-400" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 p-6 space-y-5">

          {/* Drop zone */}
          {!rows && (
            <>
              <p className="text-xs text-stone-500">
                Upload an Excel or CSV file with a <strong>Name</strong> column and an <strong>Email</strong> column.
                Any other columns are ignored. Each email must be unique and properly formatted.
              </p>

              <div
                onDragOver={e => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
                onClick={() => inputRef.current?.click()}
                className={cn(
                  'border-2 border-dashed rounded-3xl p-10 text-center cursor-pointer transition-all',
                  dragging ? 'border-emerald-400 bg-emerald-50' : 'border-stone-200 hover:border-stone-300 hover:bg-stone-50'
                )}
              >
                <Upload className={cn('w-8 h-8 mx-auto mb-3', dragging ? 'text-emerald-500' : 'text-stone-300')} />
                <p className="text-sm font-medium text-stone-600">Drop your file here, or click to browse</p>
                <p className="text-xs text-stone-400 mt-1">Accepts .xls, .xlsx, .csv</p>
                <input
                  ref={inputRef}
                  type="file"
                  accept=".xls,.xlsx,.csv"
                  className="hidden"
                  onChange={handleInputChange}
                />
              </div>

              {parseError && (
                <div className="flex gap-2 bg-red-50 border border-red-200 rounded-2xl px-4 py-3">
                  <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                  <p className="text-xs text-red-700">{parseError}</p>
                </div>
              )}
            </>
          )}

          {/* Preview */}
          {rows && savedCount === null && (
            <>
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-stone-700">
                  <span className="font-mono">{fileName}</span> — {rows.length} rows parsed
                </p>
                <button
                  onClick={() => { setRows(null); setFileName(null); setParseError(null); if (inputRef.current) inputRef.current.value = ''; }}
                  className="text-xs text-stone-400 hover:text-stone-600 underline"
                >
                  Change file
                </button>
              </div>

              {/* Summary badges */}
              <div className="flex gap-3">
                <span className="inline-flex items-center gap-1.5 text-xs font-medium bg-emerald-50 text-emerald-700 px-3 py-1.5 rounded-full">
                  <CheckCircle2 className="w-3.5 h-3.5" /> {validRows.length} valid
                </span>
                {invalidRows.length > 0 && (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium bg-red-50 text-red-700 px-3 py-1.5 rounded-full">
                    <AlertCircle className="w-3.5 h-3.5" /> {invalidRows.length} with errors
                  </span>
                )}
              </div>

              {parseError && (
                <div className="flex gap-2 bg-red-50 border border-red-200 rounded-2xl px-4 py-3">
                  <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                  <p className="text-xs text-red-700">{parseError}</p>
                </div>
              )}

              {/* Table */}
              <div className="border border-stone-100 rounded-2xl overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-stone-50 text-stone-500">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium w-8">#</th>
                      <th className="px-3 py-2 text-left font-medium">Name</th>
                      <th className="px-3 py-2 text-left font-medium">Email</th>
                      <th className="px-3 py-2 text-left font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-50">
                    {rows.map(row => (
                      <tr key={row.rowNum} className={cn(row.errors.length > 0 ? 'bg-red-50/60' : '')}>
                        <td className="px-3 py-2 text-stone-400">{row.rowNum}</td>
                        <td className="px-3 py-2 text-stone-800">{row.name || <span className="text-stone-300 italic">empty</span>}</td>
                        <td className="px-3 py-2 font-mono text-stone-600">{row.email || <span className="text-stone-300 italic">empty</span>}</td>
                        <td className="px-3 py-2">
                          {row.errors.length === 0 ? (
                            <span className="inline-flex items-center gap-1 text-emerald-600">
                              <CheckCircle2 className="w-3 h-3" /> OK
                            </span>
                          ) : (
                            <span className="inline-flex items-start gap-1 text-red-600">
                              <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
                              <span>{row.errors.join('; ')}</span>
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
                  {invalidRows.length} row{invalidRows.length > 1 ? 's' : ''} with errors will be skipped.
                  Only the {validRows.length} valid row{validRows.length !== 1 ? 's' : ''} will be saved.
                </p>
              )}
            </>
          )}

          {/* Success */}
          {savedCount !== null && (
            <div className="text-center py-8 space-y-3">
              <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto" />
              <p className="text-lg font-medium text-stone-800">{savedCount} students added</p>
              <p className="text-sm text-stone-500">They will appear in the Student List for this course.</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-stone-100 flex justify-end gap-3 shrink-0">
          {savedCount !== null ? (
            <button onClick={onClose} className="bg-stone-900 text-white px-6 py-2.5 rounded-2xl text-sm font-medium hover:bg-stone-800">
              Done
            </button>
          ) : rows ? (
            <>
              <button onClick={onClose} className="px-5 py-2.5 rounded-2xl text-sm font-medium text-stone-600 hover:bg-stone-100">
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving || validRows.length === 0}
                className="flex items-center gap-2 bg-emerald-700 text-white px-6 py-2.5 rounded-2xl text-sm font-medium hover:bg-emerald-600 disabled:opacity-50"
              >
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                {saving ? 'Saving…' : `Add ${validRows.length} Student${validRows.length !== 1 ? 's' : ''}`}
              </button>
            </>
          ) : (
            <button onClick={onClose} className="px-5 py-2.5 rounded-2xl text-sm font-medium text-stone-600 hover:bg-stone-100">
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
