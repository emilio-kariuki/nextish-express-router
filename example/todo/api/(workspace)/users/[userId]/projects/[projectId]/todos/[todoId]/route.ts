import type { RouteDefinition } from "../../../../../../../../../../src";
import { zodRoute } from "../../../../../../../../../../src/zod";
import { getStore } from "../../../../../../../../store";
import { updateTodoSchema } from "../../../../../../../../schemas";

export const docs = { tags: ["Todos"] };

export const GET: RouteDefinition = {
  docs: { summary: "Get a todo", responses: { "200": { description: "Todo" } } },
  handler(req, res) {
    res.json(getStore(req).getTodo(req.params.userId, req.params.projectId, req.params.todoId));
  },
};

export const PATCH = zodRoute({
  schemas: { body: updateTodoSchema },
  docs: { summary: "Rename, complete, or reopen a todo", bodyRequired: true, responses: { "200": { description: "Updated todo" } } },
  handler(req, res) {
    res.json(getStore(req).updateTodo(req.params.userId, req.params.projectId, req.params.todoId, req.validated.body));
  },
});

export const DELETE: RouteDefinition = {
  docs: { summary: "Delete a todo", responses: { "204": { description: "Deleted todo" } } },
  handler(req, res) {
    getStore(req).deleteTodo(req.params.userId, req.params.projectId, req.params.todoId);
    res.status(204).end();
  },
};
