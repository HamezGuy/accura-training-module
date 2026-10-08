import { Request, Response, NextFunction } from 'express';
import { AccuraAuthClient, extractTokenFromHeader, getRoleByName, ROLES } from '@accura-trial/auth-core';
import { decode } from 'jsonwebtoken';
import { config } from '../config/environment';
import { logger } from '../config/logger';
import type { TrainingAuthorityContext } from '../services/training-authority.service';

export interface AuthUser {
  userId: number;
  username: string;
  role: string;
  organizationIds?: number[];
}

export interface AuthRequest extends Request {
  user?: AuthUser;
  trainingAuthority?: TrainingAuthorityContext;
}

const authorityClient = new AccuraAuthClient(config.authority, logger);

export async function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  if (req.aborted || res.destroyed) return;
  const token = extractTokenFromHeader(req.headers.authorization);

  if (!token) {
    res.status(401).json({ success: false, message: 'Authentication required' });
    return;
  }

  let userId: number;
  try {
    // Decode only for subject continuity with the authority's response. These
    // unverified claims never establish authentication or authorization.
    const decoded = decode(token);
    if (!decoded || typeof decoded !== 'object' || !Number.isSafeInteger(decoded.userId) || decoded.userId < 1) {
      throw new Error('Invalid access-token identity');
    }
    userId = decoded.userId;
  } catch {
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
    return;
  }

  try {
    // The native authority owns signature/claim verification and current
    // sessions, active accounts and role/membership grants. Never authorize
    // from decoded claims, or distribute the authority's signing secret here.
    const result = await authorityClient.verify(token);
    // Verification has its own bounded timeout. A client may disconnect while
    // it is pending; never start a training read/write after that late answer.
    if (req.aborted || res.destroyed) return;
    if (result.httpStatus === 401 || result.httpStatus === 403) {
      const code = typeof result.error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(result.error.code)
        ? result.error.code : 'AUTHORITY_REFUSED';
      res.status(result.httpStatus).json({ success: false, code,
        message: code === 'PASSWORD_EXPIRED' ? 'Password expired. Change your password before continuing.'
          : 'Authentication refused by the account authority' });
      return;
    }
    if (!Number.isInteger(result.httpStatus) || result.httpStatus < 200 || result.httpStatus >= 300 || result.success !== true) {
      throw new Error('Authority verification unavailable');
    }
    const current = result.data;
    if (!current || typeof current !== 'object' || Array.isArray(current)
      || !Number.isSafeInteger(current.userId) || current.userId < 1 || current.userId !== userId
      || typeof current.username !== 'string' || !current.username.trim()
      || typeof current.email !== 'string' || typeof current.role !== 'string'
      || typeof current.userType !== 'string' || !current.userType.trim()
      || !Array.isArray(current.studyIds) || !current.studyIds.every(id => Number.isSafeInteger(id) && id > 0)
      || !Array.isArray(current.organizationIds) || !current.organizationIds.every(id => Number.isSafeInteger(id) && id > 0)) {
      throw new Error('Invalid authoritative identity');
    }
    const currentRole = getRoleByName(current.role);
    if (currentRole.id === ROLES.INVALID.id) throw new Error('Unknown authoritative role');
    req.user = {
      userId: current.userId,
      username: current.username,
      role: currentRole.name,
      organizationIds: [...current.organizationIds],
    };
    const cancellation = new AbortController();
    const abort = () => cancellation.abort();
    const close = () => { if (!res.writableEnded) abort(); cleanup(); };
    const cleanup = () => {
      req.removeListener('aborted', abort);
      res.removeListener('close', close);
      res.removeListener('finish', cleanup);
    };
    req.once('aborted', abort);
    res.once('close', close);
    res.once('finish', cleanup);
    if (req.aborted || res.destroyed) abort();
    // Non-enumerable request-local credentials avoid accidental request logging.
    Object.defineProperty(req, 'trainingAuthority', { configurable: true, value: Object.freeze({
      actorUserId: current.userId, accessToken: token, signal: cancellation.signal,
    }) });
  } catch {
    if (req.aborted || res.destroyed) return;
    // Never log the bearer, upstream body or exception text; a transport error
    // may contain request details. There is no local-only fallback or cache.
    logger.warn('Native authority verification unavailable', { ip: req.ip });
    res.status(503).json({ success: false, code: 'AUTH_TEMPORARILY_UNAVAILABLE',
      message: 'Could not verify your current session. Please try again.' });
    return;
  }
  next();
}
