import type { ErrorRequestHandler, RequestHandler } from "express";

export function wrapAsync(handler: RequestHandler): RequestHandler;
export function wrapAsync(handler: ErrorRequestHandler): ErrorRequestHandler;
export function wrapAsync(handler: RequestHandler | ErrorRequestHandler): RequestHandler | ErrorRequestHandler;
export function wrapAsync(handler: RequestHandler | ErrorRequestHandler): RequestHandler | ErrorRequestHandler {
  if (handler.length === 4) {
    const wrapped: ErrorRequestHandler = (error, req, res, next) =>
      Promise.resolve((handler as ErrorRequestHandler)(error, req, res, next))
        .catch(error => next(error || new Error("Rejected promise")));
    return wrapped;
  }
  const wrapped: RequestHandler = (req, res, next) => Promise.resolve((handler as RequestHandler)(req, res, next))
    .catch(error => next(error || new Error("Rejected promise")));
  return wrapped;
}
