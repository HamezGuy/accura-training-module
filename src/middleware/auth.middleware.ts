import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/environment';
import { logger } from '../config/logger';

export interface AuthUser {
  userId: number;
  username: string;
  role: string;
  organizationId: number;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ success: false, message: 'Authentication required' });
    return;
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, config.jwt.secret) as Record<string, unknown>;

    req.user = {
      userId: decoded['userId'] as number,
      username: decoded['username'] as string,
      role: decoded['role'] as string,
      organizationId: decoded['organizationId'] as number,
    };

    next();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Token verification failed';
    logger.warn('JWT verification failed', { error: message, ip: req.ip });
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}
