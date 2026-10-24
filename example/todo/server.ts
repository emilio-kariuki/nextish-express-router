import { createTodoApp } from "./app";

function reportError(error: unknown) {
  console.error(error);
  process.exitCode = 1;
}

async function main() {
  const port = Number(process.env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be an integer from 0 to 65535");
  const { app, api } = await createTodoApp();
  const server = app.listen(port, "127.0.0.1", () => {
    const address = server.address();
    if (address && typeof address === "object") {
      console.log(`Todo API running on http://127.0.0.1:${address.port}`);
    }
  });
  const shutdown = () => {
    server.close();
    api.close().catch(reportError);
  };
  server.on("error", error => {
    reportError(error);
    shutdown();
  });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch(reportError);
