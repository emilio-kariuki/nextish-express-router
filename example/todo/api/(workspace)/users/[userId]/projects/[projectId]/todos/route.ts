import { zodRoute } from "../../../../../../../../../src/zod";
import { getStore } from "../../../../../../../store";
import { createTodoSchema, todoQuerySchema } from "../../../../../../../schemas";

export const docs = { tags: ["Todos"] };

export const GET = zodRoute({
  schemas: { query: todoQuerySchema },
  docs: { summary: "List todos, optionally filtering by completion", responses: { "200": { description: "Todos" } } },
  handler(req, res) {
    res.json(getStore(req).listTodos(req.params.userId, req.params.projectId, req.validated.query.completed));
  },
});

export const POST = zodRoute({
  schemas: { body: createTodoSchema },
  docs: { summary: "Create a todo", responses: { "201": { description: "Created todo" } } },
  handler(req, res) {
    const todo = getStore(req).createTodo(req.params.userId, req.params.projectId, req.validated.body);
    res.location(`${req.baseUrl}/users/${req.params.userId}/projects/${todo.projectId}/todos/${todo.id}`)
      .status(201).json(todo);
  },
});
