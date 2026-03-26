export type UserRole = 'Admin' | 'Educator' | 'Observer';

export interface Institution {
  id: string;
  name: string;
  contactEmail: string;
  subscriptionTier: string;
  defaultRetentionPolicy: any;
}

export interface Educator {
  id: string;
  name: string;
  email: string;
  institutionId: string;
  role: UserRole;
}

export interface CourseContextFile {
  name: string;
  url: string;
  size: number;
  uploadedAt: string;
}

export interface Course {
  id: string;
  name: string;
  description?: string;
  educatorId: string;
  institutionId: string;
  defaultLanguagePair: string;
  defaultQuestionCount: number;
  defaultCaptureMode: 'Snapshot' | 'Video';
  contextFiles?: CourseContextFile[];
}

export interface Assignment {
  id: string;
  title: string;
  courseId: string;
  educatorId: string;
  rubricFileUrl?: string;
  briefFileUrl?: string;
  windowOpen: string;
  windowClose: string;
  questionCount: number;
  questionMode: 'AI-Generated' | 'Manual' | 'Mixed';
  responseTimeLimit: number;
  captureMode: 'Snapshot' | 'Video';
  status: 'Draft' | 'Processing' | 'Ready' | 'Active' | 'Closed' | 'Archived';
  summaryText?: string;
  rubricText?: string;     // effective rubric (provided or AI-generated) — stored for re-use at analysis time
  summaryGeneratedAt?: string;
  questions?: Question[];  // stored inline on the assignment doc (avoids subcollection permission issues)
}

export interface Student {
  id: string;
  name: string;
  studentId: string;
  email?: string;
  institutionId: string;
  courseId: string;
  assignmentIds?: string[];  // set when student is added to a specific assignment only
}

export interface EmailLog {
  id?: string;
  studentId: string;
  assignmentId: string;
  email: string;
  subject: string;
  sentAt: string;
  status: 'sent' | 'failed';
  errorMessage?: string;
  sentBy: string;
}

export interface Submission {
  id: string;
  assignmentId: string;
  studentId: string;
  workFileUrl?: string;
  extractedText?: string;
  status: string;
  arabicEnabled: boolean;
}

export interface InviteToken {
  id: string;
  studentId: string;
  assignmentId: string;
  tokenHash: string;
  expiry: string;
  usedAt?: string;
  issuedBy: string;
  reissueReason?: string;
  createdAt: string;
}

// Canonical session statuses — UPPER_SNAKE_CASE only
export type SessionStatus =
  | 'NOT_STARTED'
  | 'CONSENT_PENDING'
  | 'UPLOAD_PENDING'
  | 'IN_PROGRESS'
  | 'INCOMPLETE'
  | 'AWAITING_PROCESSING'
  | 'AWAITING_REVIEW'
  | 'REVIEWED'
  | 'PROCESSING_FAILED'
  | 'EXPIRED';

export interface InterviewSession {
  id: string;
  submissionId: string;
  studentId: string;
  assignmentId: string;
  workFileUrl?: string;
  status: SessionStatus;
  currentQuestionIndex: number;
  startedAt?: string;
  completedAt?: string;
  arabicAudioEnabled: boolean;
  disruptionCause?: string;
  isTestMode?: boolean;
}

export interface MCQOptions {
  a: string; b: string; c: string; d: string;
  aAr?: string; bAr?: string; cAr?: string; dAr?: string;
}

export interface Question {
  id?: string;
  order: number;
  questionType?: 'open' | 'mcq';   // 'open' if omitted (backwards compat)
  textEn: string;
  textAr: string;
  followUpEn?: string | null;
  followUpAr?: string | null;
  // Open questions — excerpt from student's submission shown on screen
  submissionExtract?: string;
  // MCQ questions — options + correct answer
  options?: MCQOptions;
  correctOption?: 'a' | 'b' | 'c' | 'd';
  // Pre-generated audio stored in Firebase Storage
  audioUrlEn?: string;
  audioUrlAr?: string;
}

export interface ResponseChunk {
  id: string;
  questionIndex: number;
  isBranch: boolean;
  timestamp: string;
  duration: number;
  audioUrl?: string;
  videoUrl?: string;
  uploadConfirmedAt?: string;
  transcriptText?: string;
  transcriptLanguage?: string;
  transcriptConfidence?: number;
  selectedOption?: 'a' | 'b' | 'c' | 'd'; // MCQ answer
}

export interface Snapshot {
  id: string;
  timestamp: string;
  storagePath?: string;  // Firebase Storage path, stored at upload time for reliable retrieval
  questionIndex: number;
  isSubmissionSnapshot: boolean;
  imageUrl?: string;
}

export interface Flag {
  id: string;
  questionIndex: number;
  classification: 'Hard Evidence' | 'Soft Signal' | 'Data Quality Issue';
  severity: number; // 1–5
  description: string;
}

export interface AnalysisReport {
  id: string;
  sessionId: string;
  comprehensionLevel: 'High' | 'Medium' | 'Low';
  recommendedAction: 'Accept' | 'Schedule Follow-up' | 'Escalate for Review';
  summary: string;
}

export interface EducatorDecision {
  id: string;
  sessionId: string;
  reportId: string;
  educatorId: string;
  decision: 'Accept' | 'Schedule Follow-up' | 'Escalate for Review';
  note?: string;
  decidedAt: string;
}

export type ActionType =
  | 'Course Created'
  | 'Assignment Created'
  | 'Consent Given'
  | 'Interview Started'
  | 'Interview Completed'
  | 'Interview Incomplete'
  | 'Report Reviewed'
  | 'New Code Issued';

export interface AuditLog {
  id: string;
  timestamp: string;
  userId: string;
  action: ActionType;
  details: string;
  metadata?: Record<string, any>;
}
