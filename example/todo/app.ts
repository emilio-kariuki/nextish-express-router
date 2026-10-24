import express from "express";
import type { ErrorRequestHandler } from "express";
import path from "node:path";
import { createNextishRouter, generateOpenAPI } from "../../src";
import type { NextishRouter } from "../../src";
import { ApiError, TodoStore } from "./store";

export async function createTodoApp(): Promise<{ app: express.Express; api: NextishRouter }> {
  const app = express();
  app.disable("x-powered-by");
  app.locals.todoStore = new TodoStore();
  const api = await createNextishRouter(path.join(__dirname, "api"));

  app.get("/", (_req, res) => res.json({
    name: "Nextish Todo API", users: "/api/users", openapi: "/openapi.json",
  }));
  app.use("/api", api);
  app.get("/openapi.json", (_req, res) => res.json(generateOpenAPI(api.getRoutes(), {
    title: "Nextish Todo API", version: "1.0.0", servers: [{ url: "/api" }],
  })));
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));

  const handleError: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof ApiError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if (error && typeof error === "object" && "status" in error && typeof error.status === "number"
      && Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
      res.status(error.status).json({ error: "Invalid request" });
      return;
    }
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  };
  app.use(handleError);
  return { app, api };
}
