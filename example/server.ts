import express from "express";
import path from "path";
import { createNextishRouter } from "../src";

function reportError(error: unknown) {
  console.error(error);
  process.exitCode = 1;
}

async function main() {
  const app = express();
  const apiRouter = await createNextishRouter(path.join(__dirname, "api"), {
    watch: process.env.NODE_ENV !== "production"
  });

  app.use("/api", apiRouter);

  const server = app.listen(3000, () => {
    console.log("Server running on http://localhost:3000");
  });
  const shutdown = () => {
    server.close();
    apiRouter.close().catch(reportError);
  };
  server.on("error", error => {
    reportError(error);
    shutdown();
  });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch(reportError);
