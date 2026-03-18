import { db } from '../firebase';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { AuditLog, ActionType } from '../types';

export async function logAudit(
  action: ActionType,
  details: string,
  userId?: string,
  metadata?: Record<string, any>
) {
  try {
    const log: Omit<AuditLog, 'id'> = {
      timestamp: new Date().toISOString(),
      userId: userId || 'system',
      action,
      details,
      metadata
    };

    await addDoc(collection(db, 'auditLogs'), {
      ...log,
      serverTimestamp: serverTimestamp()
    });
  } catch (error) {
    console.error('Failed to log audit:', error);
  }
}
