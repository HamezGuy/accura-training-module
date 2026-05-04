import { v4 as uuidv4 } from 'uuid';
import { config } from '../config/environment';

export function generateCertificateNumber(courseCode: string, userId: number): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const uniqueSuffix = uuidv4().substring(0, 6).toUpperCase();
  return `AT-CERT-${courseCode.toUpperCase()}-${userId}-${timestamp}-${uniqueSuffix}`;
}

export function calculateExpirationDate(validityDays?: number | null): Date {
  const days = validityDays ?? config.training.certificateValidityDays;
  const expiration = new Date();
  expiration.setDate(expiration.getDate() + days);
  return expiration;
}

export function isCertificateExpired(expirationDate: string | Date | null): boolean {
  if (!expirationDate) return false;
  const expDate = typeof expirationDate === 'string' ? new Date(expirationDate) : expirationDate;
  return expDate < new Date();
}
