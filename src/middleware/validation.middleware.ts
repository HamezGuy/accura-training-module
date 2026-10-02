import { Request, Response, NextFunction } from 'express';
import Joi from 'joi';

export function validate(schema: Joi.ObjectSchema, source: 'body' | 'query' | 'params' = 'body') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const data = source === 'body' ? req.body : source === 'query' ? req.query : req.params;

    const { error, value } = schema.validate(data, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      const details = error.details.map((d) => d.message);
      res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: details,
      });
      return;
    }

    if (source === 'body') {
      req.body = value;
    }

    next();
  };
}

export function exactPositiveId(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw Object.assign(new Error(`An exact positive ${field} is required`), { statusCode: 400 });
  }
  return Number(value);
}
