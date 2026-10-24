import type { RouteDefinition } from "../../../../../src";
import { zodRoute } from "../../../../../src/zod";
import { getStore } from "../../../store";
import { createUserSchema } from "../../../schemas";

export const docs = { tags: ["Users"] };

export const GET: RouteDefinition = {
  docs: { summary: "List users", responses: { "200": { description: "Users" } } },
  handler(req, res) {
    res.json(getStore(req).listUsers());
  },
};

export const POST = zodRoute({
  schemas: { body: createUserSchema },
  docs: { summary: "Create a user", responses: { "201": { description: "Created user" } } },
  handler(req, res) {
    const user = getStore(req).createUser(req.validated.body);
    res.location(`${req.baseUrl}/users/${user.id}`).status(201).json(user);
  },
});
