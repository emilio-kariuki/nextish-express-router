import type { RequestHandler } from "express";
import { z } from "zod";
import { zodRoute } from "../../../src/zod";

const bodySchema = z.object({ name: z.string().min(1, "Name is required") });

export const GET: RequestHandler = (_req, res) => {
  res.json({ method: "GET", message: "Fetching all users" });
};

export const POST = zodRoute({
  schemas: { body: bodySchema },
  docs: {
    summary: "Create a user",
    responses: { "201": { description: "Created user" } }
  },
  handler(req, res) {
    const user = { id: Date.now(), name: req.validated.body.name };
    res.status(201).json({ method: "POST", user });
  }
});

export const PUT: RequestHandler = (_req, res) => {
  res.json({ method: "PUT", message: "Updating user(s)" });
};

export const DELETE: RequestHandler = (_req, res) => {
  res.json({ method: "DELETE", message: "Deleting user(s)" });
};

export const PATCH: RequestHandler = (_req, res) => {
  res.json({ method: "PATCH", message: "Partially updating user(s)" });
};
