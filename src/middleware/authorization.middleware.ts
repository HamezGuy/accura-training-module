import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth.middleware';
import { exactPositiveId } from './validation.middleware';

export function authorize(allowedRoles: string[], ownUserId?: (req: AuthRequest) => unknown) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ success: false, message: 'Authentication required' });
      return;
    }

    // Supplied subjects must be exact IDs even for oversight roles. An absent
    // optional filter is a global read and cannot qualify for self access.
    let targetUserId: number | undefined;
    try { targetUserId = ownUserId ? exactPositiveId(ownUserId(req), 'user ID') : undefined; }
    catch (error) { next(error); return; }

    const isOwnUser = ownUserId !== undefined && targetUserId !== undefined && targetUserId === req.user.userId;
    if (!allowedRoles.includes(req.user.role) && !isOwnUser) {
      res.status(403).json({
        success: false,
        message: 'Insufficient permissions for this action',
      });
      return;
    }

    next();
  };
}
