import type { RequestHandler } from "express";

export function wrapAsync(handler: RequestHandler): RequestHandler {
  return (req, res, next) => Promise.resolve(handler(req, res, next))
    .catch(error => next(error || new Error("Rejected promise")));
}
