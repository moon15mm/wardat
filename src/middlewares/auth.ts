import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../utils/auth';

export function authenticateSuperAdmin(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized. Missing token.' });
  }

  const token = authHeader.split(' ')[1];
  const payload = verifyToken(token);

  if (!payload || payload.role !== 'superadmin') {
    return res.status(401).json({ error: 'Unauthorized. Invalid token.' });
  }

  next();
}

export function authenticateShop(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized. Missing token.' });
  }

  const token = authHeader.split(' ')[1];
  const payload = verifyToken(token);

  if (!payload || payload.role !== 'shop' || !payload.shopId) {
    return res.status(401).json({ error: 'Unauthorized. Invalid token.' });
  }

  (req as any).shopId = payload.shopId;
  next();
}
