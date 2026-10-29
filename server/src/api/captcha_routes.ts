import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { createChallenge } from '../services/captcha.js';
import { rateLimit } from '../rate-limit.js';

const router = Router();

/** Cheap flood guard on challenge minting itself. */
function captchaLimiter(req: Request, res: Response, next: NextFunction): void {
  if (!rateLimit(`captcha:${req.ip}`, 40, 60_000)) {
    res.status(429).json({ error: 'Too many captcha requests — try again in a minute' });
    return;
  }
  next();
}

/** A fresh challenge: signed token + the SVG question to render. */
router.get('/', captchaLimiter, (_req, res) => {
  res.set('cache-control', 'no-store');
  res.json(createChallenge());
});

export default router;
