import { Request, Response, NextFunction } from 'express';
import { createJwtService, extractTokenFromHeader, getRoleByName, ROLES } from '@accura-trial/auth-core';
import { config } from '../config/environment';
import { logger } from '../config/logger';

export interface AuthUser {
  userId: number;
  username: string;
  role: string;
  organizationIds?: number[];
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

const jwtService = createJwtService({ secret: config.jwt.secret }, logger);

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): void {
  const token = extractTokenFromHeader(req.headers.authorization);

  if (!token) {
    res.status(401).json({ success: false, message: 'Authentication required' });
    return;
  }

  try {
    const decoded = jwtService.verifyAccessToken(token);
    if (!decoded) throw new Error('Invalid access token');
    if (!Number.isSafeInteger(decoded.userId) || decoded.userId < 1 || !decoded.username.trim()) {
      throw new Error('Invalid access-token identity');
    }
    const role = getRoleByName(decoded.role);
    if (role.id === ROLES.INVALID.id) throw new Error('Unknown access-token role');

    req.user = {
      userId: decoded.userId,
      username: decoded.username,
      role: role.name,
      organizationIds: decoded.organizationIds,
    };

    next();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Token verification failed';
    logger.warn('JWT verification failed', { error: message, ip: req.ip });
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}
