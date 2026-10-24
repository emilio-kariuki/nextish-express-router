import type { RouteDefinition } from "../../../../../../src";
import { zodRoute } from "../../../../../../src/zod";
import { getStore } from "../../../../store";
import { updateUserSchema } from "../../../../schemas";

export const docs = { tags: ["Users"] };

export const GET: RouteDefinition = {
  docs: { summary: "Get a user", responses: { "200": { description: "User" } } },
  handler(req, res) {
    res.json(getStore(req).getUser(req.params.userId));
  },
};

export const PATCH = zodRoute({
  schemas: { body: updateUserSchema },
  docs: { summary: "Update a user", bodyRequired: true, responses: { "200": { description: "Updated user" } } },
  handler(req, res) {
    res.json(getStore(req).updateUser(req.params.userId, req.validated.body));
  },
});

export const DELETE: RouteDefinition = {
  docs: { summary: "Delete a user and their projects and todos", responses: { "204": { description: "Deleted user" } } },
  handler(req, res) {
    getStore(req).deleteUser(req.params.userId);
    res.status(204).end();
  },
};
